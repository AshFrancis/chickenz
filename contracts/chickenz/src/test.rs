#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Env, Address, BytesN, Bytes};

fn setup_contract(env: &Env) -> (Address, Address, Address, Address, BytesN<32>) {
    let contract_id = env.register(ChickenzContract, ());
    let admin = Address::generate(env);
    let game_hub = Address::generate(env);
    let verifier = Address::generate(env);
    let image_id = BytesN::from_array(env, &[0xAA; 32]);

    (contract_id, admin, game_hub, verifier, image_id)
}

#[test]
fn test_initialize() {
    let env = Env::default();
    let (contract_id, admin, game_hub, verifier, image_id) = setup_contract(&env);

    let client = ChickenzContractClient::new(&env, &contract_id);

    client.initialize(&admin, &game_hub, &verifier, &image_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_double_initialize() {
    let env = Env::default();
    let (contract_id, admin, game_hub, verifier, image_id) = setup_contract(&env);

    let client = ChickenzContractClient::new(&env, &contract_id);

    client.initialize(&admin, &game_hub, &verifier, &image_id);
    client.initialize(&admin, &game_hub, &verifier, &image_id);
}

#[test]
fn test_journal_decode() {
    // Build a 76-byte journal manually
    let mut journal_bytes = [0u8; 76];
    // winner = 0 (player 0 wins) at offset 0
    journal_bytes[0] = 0;
    journal_bytes[1] = 0;
    journal_bytes[2] = 0;
    journal_bytes[3] = 0;
    // score_p0 = 3 at offset 4
    journal_bytes[4] = 3;
    // score_p1 = 1 at offset 8
    journal_bytes[8] = 1;
    // transcript_hash at offset 12 (32 bytes of 0xBB)
    for i in 12..44 {
        journal_bytes[i] = 0xBB;
    }
    // seed_commit at offset 44 (32 bytes of 0xCC)
    for i in 44..76 {
        journal_bytes[i] = 0xCC;
    }

    let env = Env::default();
    let journal = Bytes::from_slice(&env, &journal_bytes);

    let winner = decode_winner(&journal);
    assert_eq!(winner, 0);

    let seed = extract_seed_commit(&env, &journal);
    assert_eq!(seed, BytesN::from_array(&env, &[0xCC; 32]));
}

#[test]
fn test_journal_decode_draw() {
    let mut journal_bytes = [0u8; 76];
    // winner = -1 (0xFFFFFFFF LE) for draw
    journal_bytes[0] = 0xFF;
    journal_bytes[1] = 0xFF;
    journal_bytes[2] = 0xFF;
    journal_bytes[3] = 0xFF;

    let env = Env::default();
    let journal = Bytes::from_slice(&env, &journal_bytes);

    let winner = decode_winner(&journal);
    assert_eq!(winner, -1);
}
