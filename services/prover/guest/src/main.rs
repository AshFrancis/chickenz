#![no_main]

risc0_zkvm::guest::entry!(main);

use chickenz_core::fp;
use chickenz_core::ProverOutput;

fn main() {
    let c0 = risc0_zkvm::guest::env::cycle_count();

    // Read raw bytes — no serde overhead
    let mut input_len = [0u32; 1];
    risc0_zkvm::guest::env::read_slice(&mut input_len);
    let byte_len = input_len[0] as usize;
    // Round up to u32 alignment for read_slice
    let word_len = (byte_len + 3) / 4;
    let mut raw_words = vec![0u32; word_len];
    risc0_zkvm::guest::env::read_slice(&mut raw_words);
    let raw_bytes: &[u8] = bytemuck::cast_slice(&raw_words);
    let raw_bytes = &raw_bytes[..byte_len];

    let (seed, transcript) = fp::decode_raw_input(raw_bytes);

    let c1 = risc0_zkvm::guest::env::cycle_count();

    let map = fp::arena_map();
    let mut state = fp::create_initial_state(seed, &map);

    for tick_inputs in &transcript {
        fp::step_mut(&mut state, tick_inputs, &map);
        if state.match_over {
            break;
        }
    }

    let c2 = risc0_zkvm::guest::env::cycle_count();

    let transcript_hash = fp::hash_transcript(&transcript);
    let seed_commit = fp::hash_seed(seed);

    let c3 = risc0_zkvm::guest::env::cycle_count();

    risc0_zkvm::guest::env::log(&format!(
        "CYCLES: deserialize={}, game_loop={}, hashing={}, total={}",
        c1 - c0,
        c2 - c1,
        c3 - c2,
        c3 - c0,
    ));

    let output = ProverOutput {
        winner: state.winner,
        scores: state.score,
        transcript_hash,
        seed_commit,
    };
    risc0_zkvm::guest::env::commit_slice(&output.to_journal_words());
}
