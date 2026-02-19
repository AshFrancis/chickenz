#![no_main]

risc0_zkvm::guest::entry!(main);

use chickenz_core::fp::{self, ChunkProof, CHUNK_PROOF_WORDS};
use chickenz_core::ProverOutput;
use sha2::{Digest, Sha256};

/// Match composer guest: verifies a chain of chunk proofs, outputs final result.
///
/// env::verify() adds ZERO execution cycles — it's resolved at the recursion layer.
/// This guest is extremely lightweight: just reads journals, checks hash chain, outputs result.
///
/// Input (all via read_slice):
///   [seed: u32, num_chunks: u32]
///   [chunk_image_id: [u32; 8]]
///   For each chunk: [journal_words: [u32; 30]]
///
/// Output (via commit): ProverOutput
fn main() {
    // 1. Read header
    let mut header = [0u32; 2];
    risc0_zkvm::guest::env::read_slice(&mut header);
    let seed = header[0];
    let num_chunks = header[1] as usize;

    // 2. Read chunk image ID
    let mut chunk_image_id = [0u32; 8];
    risc0_zkvm::guest::env::read_slice(&mut chunk_image_id);

    // 3. Compute expected initial state hash
    let map = fp::arena_map();
    let initial_state = fp::create_initial_state(seed, &map);
    let expected_first_hash = fp::hash_state(&initial_state);

    // 4. Read, verify, and chain each chunk proof
    let mut prev_hash = expected_first_hash;
    let mut transcript_hasher = Sha256::new();
    let mut final_scores = [0u32; 2];
    let mut final_winner = -1i32;
    for i in 0..num_chunks {
        // Read chunk journal (30 u32 words = 120 bytes)
        let mut journal_words = [0u32; CHUNK_PROOF_WORDS];
        risc0_zkvm::guest::env::read_slice(&mut journal_words);

        // Convert to bytes for verification (fixed buffer, no heap)
        let mut journal_bytes = [0u8; CHUNK_PROOF_WORDS * 4];
        for (i, w) in journal_words.iter().enumerate() {
            let b = w.to_le_bytes();
            journal_bytes[i * 4] = b[0];
            journal_bytes[i * 4 + 1] = b[1];
            journal_bytes[i * 4 + 2] = b[2];
            journal_bytes[i * 4 + 3] = b[3];
        }

        // Verify this chunk's proof (zero cycles — resolved at recursion layer)
        risc0_zkvm::guest::env::verify(chunk_image_id, &journal_bytes)
            .expect("chunk proof verification failed");

        // Decode the chunk proof
        let chunk = ChunkProof::from_journal_bytes(&journal_bytes);

        // Verify hash chain: this chunk's input state must match previous output
        assert!(
            chunk.state_hash_in == prev_hash,
            "chunk {}: state hash chain broken",
            i
        );
        prev_hash = chunk.state_hash_out;

        // Accumulate transcript hash (hash of chunk input hashes)
        transcript_hasher.update(&chunk.input_hash);

        // Track final state
        final_scores = chunk.scores;
        final_winner = chunk.winner;
    }

    // 5. Compute final commitments
    let transcript_hash: [u8; 32] = transcript_hasher.finalize().into();
    let seed_commit = fp::hash_seed(seed);

    // 6. Commit final match result
    let output = ProverOutput {
        winner: final_winner,
        scores: final_scores,
        transcript_hash,
        seed_commit,
    };
    risc0_zkvm::guest::env::commit_slice(&output.to_journal_words());
}
