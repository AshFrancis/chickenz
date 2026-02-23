#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{contract, contractimpl, Address, Bytes, BytesN, Env};

// ── Mock Game Hub ──────────────────────────────────────────────

#[contract]
pub struct MockGameHub;

#[contractimpl]
impl MockGameHub {
    pub fn start_game(
        _env: Env,
        _game_id: Address,
        _session_id: u32,
        _player1: Address,
        _player2: Address,
        _player1_points: i128,
        _player2_points: i128,
    ) {
        // no-op stub
    }
    pub fn end_game(_env: Env, _session_id: u32, _player1_won: bool) {
        // no-op stub
    }
}

// ── Mock Verifier (always passes) ──────────────────────────────

#[contract]
pub struct MockVerifier;

#[contractimpl]
impl MockVerifier {
    pub fn verify(_env: Env, _seal: Bytes, _image_id: BytesN<32>, _journal: BytesN<32>) {
        // no-op — always passes
    }
}

// ── Mock Verifier that panics (always rejects) ─────────────────

// ── Helpers ────────────────────────────────────────────────────

fn setup(env: &Env) -> (Address, Address, Address, Address, BytesN<32>) {
    let contract_id = env.register(ChickenzContract, ());
    let admin = Address::generate(env);
    let game_hub = env.register(MockGameHub, ());
    let verifier = env.register(MockVerifier, ());
    let image_id = BytesN::from_array(env, &[0xAA; 32]);

    (contract_id, admin, game_hub, verifier, image_id)
}

fn init<'a>(env: &'a Env) -> (ChickenzContractClient<'a>, Address, Address, BytesN<32>) {
    let (contract_id, admin, game_hub, verifier, image_id) = setup(env);
    let client = ChickenzContractClient::new(env, &contract_id);
    client.initialize(&admin, &game_hub, &verifier, &image_id);
    (client, admin, contract_id, image_id)
}

/// Build a valid 76-byte journal: winner=0, seed_commit=given bytes.
fn make_journal(env: &Env, winner: i32, seed_commit: &[u8; 32]) -> Bytes {
    let mut journal_bytes = [0u8; 76];
    let w = winner as u32;
    journal_bytes[0] = (w & 0xFF) as u8;
    journal_bytes[1] = ((w >> 8) & 0xFF) as u8;
    journal_bytes[2] = ((w >> 16) & 0xFF) as u8;
    journal_bytes[3] = ((w >> 24) & 0xFF) as u8;
    // scores at 4..12 (leave zero)
    // transcript_hash at 12..44 (leave zero)
    for i in 0..32 {
        journal_bytes[44 + i] = seed_commit[i];
    }
    Bytes::from_slice(env, &journal_bytes)
}

// ── Tests ──────────────────────────────────────────────────────

#[test]
fn test_initialize() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, admin, game_hub, verifier, image_id) = setup(&env);
    let client = ChickenzContractClient::new(&env, &contract_id);
    client.initialize(&admin, &game_hub, &verifier, &image_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_double_initialize() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, admin, game_hub, verifier, image_id) = setup(&env);
    let client = ChickenzContractClient::new(&env, &contract_id);
    client.initialize(&admin, &game_hub, &verifier, &image_id);
    client.initialize(&admin, &game_hub, &verifier, &image_id);
}

#[test]
fn test_set_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _contract_id, _image_id) = init(&env);
    let new_admin = Address::generate(&env);
    client.set_admin(&new_admin);
}

#[test]
fn test_set_image_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _contract_id, _image_id) = init(&env);
    let new_id = BytesN::from_array(&env, &[0xBB; 32]);
    client.set_image_id(&new_id);
}

#[test]
fn test_start_match() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _contract_id, _image_id) = init(&env);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    let seed_commit = BytesN::from_array(&env, &[0xCC; 32]);

    client.start_match(&42u32, &player1, &player2, &seed_commit);

    // Verify match was stored
    let m = client.get_match(&42u32);
    assert_eq!(m.player1, player1);
    assert_eq!(m.player2, player2);
    assert_eq!(m.seed_commit, seed_commit);
    assert_eq!(m.settled, false);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn test_start_match_duplicate_session() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _contract_id, _image_id) = init(&env);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    let seed_commit = BytesN::from_array(&env, &[0xCC; 32]);

    client.start_match(&42u32, &player1, &player2, &seed_commit);
    // Second call with same session_id should fail
    client.start_match(&42u32, &player1, &player2, &seed_commit);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_start_match_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(ChickenzContract, ());
    let client = ChickenzContractClient::new(&env, &contract_id);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    let seed_commit = BytesN::from_array(&env, &[0xCC; 32]);

    client.start_match(&1u32, &player1, &player2, &seed_commit);
}

#[test]
fn test_settle_match() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _contract_id, _image_id) = init(&env);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    let seed_commit_bytes = [0xCC; 32];
    let seed_commit = BytesN::from_array(&env, &seed_commit_bytes);

    client.start_match(&42u32, &player1, &player2, &seed_commit);

    // Build journal with winner=0, matching seed_commit
    let journal = make_journal(&env, 0, &seed_commit_bytes);
    // 260-byte seal (4-byte selector + 256-byte proof, all zeros for mock)
    let seal = Bytes::from_slice(&env, &[0u8; 260]);

    client.settle_match(&42u32, &seal, &journal);

    // Verify match is now settled
    let m = client.get_match(&42u32);
    assert_eq!(m.settled, true);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_settle_match_already_settled() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _contract_id, _image_id) = init(&env);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    let seed_commit_bytes = [0xCC; 32];
    let seed_commit = BytesN::from_array(&env, &seed_commit_bytes);

    client.start_match(&42u32, &player1, &player2, &seed_commit);

    let journal = make_journal(&env, 0, &seed_commit_bytes);
    let seal = Bytes::from_slice(&env, &[0u8; 260]);

    client.settle_match(&42u32, &seal, &journal);
    // Second settle should fail
    client.settle_match(&42u32, &seal, &journal);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_settle_match_seed_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _contract_id, _image_id) = init(&env);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    let seed_commit = BytesN::from_array(&env, &[0xCC; 32]);

    client.start_match(&42u32, &player1, &player2, &seed_commit);

    // Journal with different seed_commit
    let wrong_seed = [0xDD; 32];
    let journal = make_journal(&env, 0, &wrong_seed);
    let seal = Bytes::from_slice(&env, &[0u8; 260]);

    client.settle_match(&42u32, &seal, &journal);
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn test_settle_match_invalid_seal_size() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _contract_id, _image_id) = init(&env);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    let seed_commit_bytes = [0xCC; 32];
    let seed_commit = BytesN::from_array(&env, &seed_commit_bytes);

    client.start_match(&42u32, &player1, &player2, &seed_commit);

    let journal = make_journal(&env, 0, &seed_commit_bytes);
    // Wrong seal size (100 bytes instead of 260)
    let seal = Bytes::from_slice(&env, &[0u8; 100]);

    client.settle_match(&42u32, &seal, &journal);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn test_settle_match_invalid_journal_size() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _contract_id, _image_id) = init(&env);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    let seed_commit = BytesN::from_array(&env, &[0xCC; 32]);

    client.start_match(&42u32, &player1, &player2, &seed_commit);

    // Wrong journal size (10 bytes)
    let journal = Bytes::from_slice(&env, &[0u8; 10]);
    let seal = Bytes::from_slice(&env, &[0u8; 260]);

    client.settle_match(&42u32, &seal, &journal);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_settle_match_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _contract_id, _image_id) = init(&env);

    let journal = make_journal(&env, 0, &[0xCC; 32]);
    let seal = Bytes::from_slice(&env, &[0u8; 260]);

    client.settle_match(&999u32, &seal, &journal);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn test_settle_match_invalid_winner() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _contract_id, _image_id) = init(&env);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    let seed_commit_bytes = [0xCC; 32];
    let seed_commit = BytesN::from_array(&env, &seed_commit_bytes);

    client.start_match(&42u32, &player1, &player2, &seed_commit);

    // winner = 5 (invalid — must be 0 or 1)
    let journal = make_journal(&env, 5, &seed_commit_bytes);
    let seal = Bytes::from_slice(&env, &[0u8; 260]);

    client.settle_match(&42u32, &seal, &journal);
}

#[test]
fn test_cancel_match_success() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _contract_id, _image_id) = init(&env);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    let seed_commit = BytesN::from_array(&env, &[0xCC; 32]);

    client.start_match(&42u32, &player1, &player2, &seed_commit);
    client.cancel_match(&42u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_cancel_match_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _contract_id, _image_id) = init(&env);

    client.cancel_match(&999u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_get_match_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _contract_id, _image_id) = init(&env);

    client.get_match(&999u32);
}

#[test]
fn test_journal_decode() {
    let mut journal_bytes = [0u8; 76];
    journal_bytes[0] = 0; // winner = 0
    journal_bytes[4] = 3; // score_p0 = 3
    journal_bytes[8] = 1; // score_p1 = 1
    for i in 12..44 {
        journal_bytes[i] = 0xBB;
    }
    for i in 44..76 {
        journal_bytes[i] = 0xCC;
    }

    let env = Env::default();
    let journal = Bytes::from_slice(&env, &journal_bytes);

    assert_eq!(decode_winner(&journal), 0);
    assert_eq!(
        extract_seed_commit(&env, &journal),
        BytesN::from_array(&env, &[0xCC; 32])
    );
}

#[test]
fn test_journal_decode_player1_wins() {
    let mut journal_bytes = [0u8; 76];
    journal_bytes[0] = 1; // winner = 1
    let env = Env::default();
    let journal = Bytes::from_slice(&env, &journal_bytes);
    assert_eq!(decode_winner(&journal), 1);
}

#[test]
fn test_journal_decode_draw() {
    let mut journal_bytes = [0u8; 76];
    journal_bytes[0] = 0xFF; // winner = -1
    journal_bytes[1] = 0xFF;
    journal_bytes[2] = 0xFF;
    journal_bytes[3] = 0xFF;

    let env = Env::default();
    let journal = Bytes::from_slice(&env, &journal_bytes);
    assert_eq!(decode_winner(&journal), -1);
}
