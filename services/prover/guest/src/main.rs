#![no_main]

risc0_zkvm::guest::entry!(main);

use chickenz_core::fp;
use chickenz_core::ProverOutput;

/// Max raw input: 8 (header) + 6 * 1800 (ticks) = 10808 bytes = 2702 u32 words
const MAX_INPUT_WORDS: usize = 2702;

fn main() {
    // Read raw bytes into fixed-size buffer — no heap allocation
    let mut input_len = [0u32; 1];
    risc0_zkvm::guest::env::read_slice(&mut input_len);
    let byte_len = input_len[0] as usize;
    let word_len = (byte_len + 3) / 4;

    let mut raw_words = [0u32; MAX_INPUT_WORDS];
    risc0_zkvm::guest::env::read_slice(&mut raw_words[..word_len]);
    let raw_bytes: &[u8] = bytemuck::cast_slice(&raw_words[..word_len]);
    let raw_bytes = &raw_bytes[..byte_len];

    // Single-pass: parse inputs → hash → step sim (zero extra allocations)
    let result = fp::run_streaming(raw_bytes);

    let output = ProverOutput {
        winner: result.state.winner,
        scores: result.state.score,
        transcript_hash: result.transcript_hash,
        seed_commit: result.seed_commit,
    };
    risc0_zkvm::guest::env::commit_slice(&output.to_journal_words());
}
