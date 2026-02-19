#![no_main]

risc0_zkvm::guest::entry!(main);

use chickenz_core::fp::{self, ChunkProof, FpInput, MATCH_DURATION_TICKS};
use sha2::{Digest, Sha256};

/// Max state bytes (conservative upper bound for encode_state output).
const MAX_STATE_WORDS: usize = 256;
/// Max chunk input: 360 ticks × 6 bytes = 2160 bytes = 540 u32 words.
const MAX_CHUNK_INPUT_WORDS: usize = 540;

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

    // 2. Read state bytes (fixed buffer, no heap)
    let state_word_count = (state_byte_len + 3) / 4;
    let mut state_words = [0u32; MAX_STATE_WORDS];
    risc0_zkvm::guest::env::read_slice(&mut state_words[..state_word_count]);
    let state_bytes: &[u8] = bytemuck::cast_slice(&state_words[..state_word_count]);
    let state_bytes = &state_bytes[..state_byte_len];

    // 3. Read input bytes (fixed buffer, no heap)
    let input_byte_len = tick_count * 6;
    let input_word_count = (input_byte_len + 3) / 4;
    let mut input_words = [0u32; MAX_CHUNK_INPUT_WORDS];
    risc0_zkvm::guest::env::read_slice(&mut input_words[..input_word_count]);
    let input_bytes: &[u8] = bytemuck::cast_slice(&input_words[..input_word_count]);
    let input_bytes = &input_bytes[..input_byte_len];

    // 4. Decode state, hash it (streaming, no Vec)
    let mut state = fp::decode_state(state_bytes);
    let state_hash_in = fp::hash_state(&state);
    let tick_start = state.tick as u32;

    // 5. Replay ticks + stream input hash in one pass
    let map = fp::arena_map();
    let mut input_hasher = Sha256::new();

    for t in 0..tick_count {
        let off = t * 6;
        let tick_bytes = &input_bytes[off..off + 6];

        // Feed raw bytes to hasher
        input_hasher.update(tick_bytes);

        let inputs = [
            FpInput {
                buttons: tick_bytes[0],
                aim_x: tick_bytes[1] as i8,
                aim_y: tick_bytes[2] as i8,
            },
            FpInput {
                buttons: tick_bytes[3],
                aim_x: tick_bytes[4] as i8,
                aim_y: tick_bytes[5] as i8,
            },
        ];
        fp::step_mut(&mut state, &inputs, &map);
        if state.match_over {
            // Hash remaining tick bytes for integrity
            if off + 6 < input_byte_len {
                input_hasher.update(&input_bytes[off + 6..]);
            }
            break;
        }
    }

    let input_hash: [u8; 32] = input_hasher.finalize().into();

    // 6. Hash output state (streaming, no Vec), commit proof
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
