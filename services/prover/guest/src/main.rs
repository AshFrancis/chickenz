#![no_main]

risc0_zkvm::guest::entry!(main);

use chickenz_core::fp;
use chickenz_core::ProverOutput;

/// Max raw input: 8 (header) + 2 rounds × (4 + 6 * 1800) = 21616 bytes ≈ 5404 u32 words
/// Buffer sized conservatively at 6000 for headroom.
const MAX_INPUT_WORDS: usize = 6000;

fn main() {
    // Read raw bytes into fixed-size buffer — no heap allocation
    let mut input_len = [0u32; 1];
    risc0_zkvm::guest::env::read_slice(&mut input_len);
    let byte_len = input_len[0] as usize;
    let word_len = byte_len.div_ceil(4);
    assert!(word_len <= MAX_INPUT_WORDS, "Input too large: {} words (max {})", word_len, MAX_INPUT_WORDS);

    let mut raw_words = [0u32; MAX_INPUT_WORDS];
    risc0_zkvm::guest::env::read_slice(&mut raw_words[..word_len]);
    let raw_bytes: &[u8] = bytemuck::cast_slice(&raw_words[..word_len]);
    let raw_bytes = &raw_bytes[..byte_len];

    // Multi-round: replay both winning rounds, verify same winner, combine hashes
    let result = fp::run_streaming_multi(raw_bytes);

    let output = ProverOutput {
        winner: result.state.winner,
        scores: result.state.score,
        transcript_hash: result.transcript_hash,
        seed_commit: result.seed_commit,
    };
    risc0_zkvm::guest::env::commit_slice(&output.to_journal_words());
}
