#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, contractclient,
    Address, Bytes, BytesN, Env,
    crypto::Hash,
};

// ── Cross-contract clients ───────────────────────────────────────────────────

#[contractclient(name = "VerifierClient")]
pub trait VerifierInterface {
    fn verify(env: Env, seal: Bytes, image_id: BytesN<32>, journal: BytesN<32>);
}

#[contractclient(name = "GameHubClient")]
pub trait GameHubInterface {
    fn start_game(
        env: Env,
        game_id: Address,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    );
    fn end_game(env: Env, session_id: u32, player1_won: bool);
}

// ── Storage types ────────────────────────────────────────────────────────────

// ~30 days of ledgers (5s per ledger)
const MATCH_TTL_LEDGERS: u32 = 518_400;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    GameHub,
    Verifier,
    ImageId,
    Match(u32),
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct MatchData {
    pub player1: Address,
    pub player2: Address,
    pub seed_commit: BytesN<32>,
    pub settled: bool,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    MatchNotFound = 4,
    MatchAlreadySettled = 5,
    MatchAlreadyExists = 6,
    InvalidJournal = 7,
    SeedMismatch = 8,
    InvalidWinner = 9,
}

// ── Journal layout ───────────────────────────────────────────────────────────
// 76 bytes = 19 u32 words (LE):
//   [0..4)   winner (i32 as u32)
//   [4..8)   score_p0 (u32)
//   [8..12)  score_p1 (u32)
//   [12..44) transcript_hash (32 bytes)
//   [44..76) seed_commit (32 bytes)

const JOURNAL_SIZE: usize = 76;

fn decode_winner(journal: &Bytes) -> i32 {
    let b0 = journal.get(0).unwrap() as u32;
    let b1 = journal.get(1).unwrap() as u32;
    let b2 = journal.get(2).unwrap() as u32;
    let b3 = journal.get(3).unwrap() as u32;
    (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) as i32
}

fn extract_seed_commit(env: &Env, journal: &Bytes) -> BytesN<32> {
    let mut buf = [0u8; 32];
    for i in 0..32 {
        buf[i] = journal.get(44 + i as u32).unwrap();
    }
    BytesN::from_array(env, &buf)
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct ChickenzContract;

#[contractimpl]
impl ChickenzContract {
    /// One-time setup. Sets admin, game hub, verifier, and expected image ID.
    pub fn initialize(
        env: Env,
        admin: Address,
        game_hub: Address,
        verifier: Address,
        image_id: BytesN<32>,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::GameHub, &game_hub);
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        env.storage().instance().set(&DataKey::ImageId, &image_id);
        Ok(())
    }

    /// Admin can update the expected image ID (e.g. after guest code change).
    pub fn set_image_id(env: Env, image_id: BytesN<32>) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::ImageId, &image_id);
        Ok(())
    }

    /// Start a match. Registers players and calls Game Hub start_game().
    pub fn start_match(
        env: Env,
        session_id: u32,
        player1: Address,
        player2: Address,
        seed_commit: BytesN<32>,
    ) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        let key = DataKey::Match(session_id);
        if env.storage().temporary().has(&key) {
            return Err(Error::MatchAlreadyExists);
        }

        // Call Game Hub start_game first
        let game_hub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::GameHub)
            .ok_or(Error::NotInitialized)?;
        let game_hub = GameHubClient::new(&env, &game_hub_addr);
        game_hub.start_game(
            &env.current_contract_address(),
            &session_id,
            &player1,
            &player2,
            &3i128, // initial lives
            &3i128,
        );

        // Store match data after Game Hub succeeds
        let match_data = MatchData {
            player1,
            player2,
            seed_commit,
            settled: false,
        };
        env.storage().temporary().set(&key, &match_data);
        env.storage()
            .temporary()
            .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
        env.storage()
            .instance()
            .extend_ttl(MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);

        Ok(())
    }

    /// Settle a match with a ZK proof. Verifies the proof and calls Game Hub end_game().
    ///
    /// `seal`: 260-byte Groth16 seal from RISC Zero
    /// `journal`: 76-byte raw journal (ProverOutput in fixed word layout)
    pub fn settle_match(
        env: Env,
        session_id: u32,
        seal: Bytes,
        journal: Bytes,
    ) -> Result<(), Error> {
        let key = DataKey::Match(session_id);

        // 1. Load and validate match
        let mut match_data: MatchData = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::MatchNotFound)?;

        if match_data.settled {
            return Err(Error::MatchAlreadySettled);
        }

        // 2. Validate journal size
        if journal.len() != JOURNAL_SIZE as u32 {
            return Err(Error::InvalidJournal);
        }

        // Extend instance TTL to prevent expiry
        env.storage()
            .instance()
            .extend_ttl(MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);

        // 3. Compute journal digest = SHA-256(journal)
        let journal_digest: Hash<32> = env.crypto().sha256(&journal);

        // 4. Load image_id and verifier
        let image_id: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::ImageId)
            .ok_or(Error::NotInitialized)?;
        let verifier_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Verifier)
            .ok_or(Error::NotInitialized)?;

        // 5. Verify ZK proof — panics on failure, reverting the entire tx
        let verifier = VerifierClient::new(&env, &verifier_addr);
        verifier.verify(
            &seal,
            &image_id,
            &BytesN::from_array(&env, &journal_digest.to_array()),
        );

        // 6. Decode journal: extract winner and seed_commit
        let winner = decode_winner(&journal);
        if winner != 0 && winner != 1 {
            return Err(Error::InvalidWinner);
        }
        let proof_seed_commit = extract_seed_commit(&env, &journal);

        // 7. Verify seed_commit matches what was registered at match start
        if proof_seed_commit != match_data.seed_commit {
            return Err(Error::SeedMismatch);
        }

        // 8. Determine player1_won (draws are impossible — sim always picks a winner)
        let player1_won = winner == 0;

        // 9. Call Game Hub end_game FIRST (before updating state)
        let game_hub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::GameHub)
            .ok_or(Error::NotInitialized)?;
        let game_hub = GameHubClient::new(&env, &game_hub_addr);
        game_hub.end_game(&session_id, &player1_won);

        // 10. Mark settled after Game Hub succeeds
        match_data.settled = true;
        env.storage().temporary().set(&key, &match_data);
        env.storage()
            .temporary()
            .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);

        Ok(())
    }

    /// Read match data.
    pub fn get_match(env: Env, session_id: u32) -> Result<MatchData, Error> {
        env.storage()
            .temporary()
            .get(&DataKey::Match(session_id))
            .ok_or(Error::MatchNotFound)
    }
}

#[cfg(test)]
mod test;
