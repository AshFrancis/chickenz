#![no_main]

risc0_zkvm::guest::entry!(main);

use chickenz_core::fp::{self, ChunkProof, FpInput, CHUNK_PROOF_WORDS};
use sha2::{Digest, Sha256};

/// Chunk guest: replays N ticks from a given state, commits state hash chain.
///
/// Input (all via read_slice):
///   [state_byte_len: u32, tick_count: u32]
///   [state_bytes padded to u32 words]
///   [input_bytes (tick_count × 6) padded to u32 words]
///
/// Output (via commit_slice): ChunkProof as 30 u32 words (120 bytes)
fn main() {
    // 1. Read header
    let mut header = [0u32; 2];
    risc0_zkvm::guest::env::read_slice(&mut header);
    let state_byte_len = header[0] as usize;
    let tick_count = header[1] as usize;

    // 2. Read state bytes
    let state_word_count = (state_byte_len + 3) / 4;
    let mut state_words = vec![0u32; state_word_count];
    risc0_zkvm::guest::env::read_slice(&mut state_words);
    let state_bytes: &[u8] = bytemuck::cast_slice(&state_words);
    let state_bytes = &state_bytes[..state_byte_len];

    // 3. Read input bytes
    let input_byte_len = tick_count * 6;
    let input_word_count = (input_byte_len + 3) / 4;
    let mut input_words = vec![0u32; input_word_count];
    risc0_zkvm::guest::env::read_slice(&mut input_words);
    let input_bytes: &[u8] = bytemuck::cast_slice(&input_words);
    let input_bytes = &input_bytes[..input_byte_len];

    // 4. Decode state, hash it
    let mut state = fp::decode_state(state_bytes);
    let state_hash_in = fp::hash_state(&state);
    let tick_start = state.tick as u32;

    // 5. Hash chunk inputs
    let input_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(input_bytes);
        h.finalize().into()
    };

    // 6. Replay ticks
    let map = fp::arena_map();
    for t in 0..tick_count {
        let off = t * 6;
        let inputs = [
            FpInput {
                buttons: input_bytes[off],
                aim_x: input_bytes[off + 1] as i8,
                aim_y: input_bytes[off + 2] as i8,
            },
            FpInput {
                buttons: input_bytes[off + 3],
                aim_x: input_bytes[off + 4] as i8,
                aim_y: input_bytes[off + 5] as i8,
            },
        ];
        fp::step_mut(&mut state, &inputs, &map);
        if state.match_over {
            break;
        }
    }

    // 7. Hash output state, commit proof
    let state_hash_out = fp::hash_state(&state);

    let proof = ChunkProof {
        state_hash_in,
        state_hash_out,
        input_hash,
        tick_start,
        tick_end: state.tick as u32,
        scores: state.score,
        match_over: state.match_over,
        winner: state.winner,
    };

    risc0_zkvm::guest::env::commit_slice(&proof.to_words());
}
