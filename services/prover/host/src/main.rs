use std::io::Read;
use std::time::Instant;

use chickenz_core::fp::{self, FpInput, FpProverInput, CHUNK_PROOF_WORDS};
use chickenz_core::{ProverInput, ProverOutput};

use chickenz_methods::CHICKENZ_GUEST_ELF;
use chickenz_methods::CHICKENZ_GUEST_ID;
use chickenz_methods::CHICKENZ_CHUNK_GUEST_ELF;
use chickenz_methods::CHICKENZ_CHUNK_GUEST_ID;
use chickenz_methods::CHICKENZ_MATCH_GUEST_ELF;
use chickenz_methods::CHICKENZ_MATCH_GUEST_ID;

const CHUNK_SIZE: usize = 360; // ticks per chunk (6 seconds)

fn load_input() -> ProverInput {
    let args: Vec<String> = std::env::args().collect();

    let json_str = if args.len() > 1 && !args[1].starts_with("--") {
        std::fs::read_to_string(&args[1]).expect("Failed to read transcript file")
    } else if args.len() > 2 && !args[2].starts_with("--") {
        std::fs::read_to_string(&args[2]).expect("Failed to read transcript file")
    } else {
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .expect("Failed to read from stdin");
        buf
    };

    serde_json::from_str(&json_str).expect("Failed to parse ProverInput JSON")
}

fn to_fp_input(input: &ProverInput) -> FpProverInput {
    FpProverInput {
        seed: input.config.seed,
        transcript: input
            .transcript
            .iter()
            .map(|tick| {
                [
                    FpInput {
                        buttons: tick[0].buttons,
                        aim_x: tick[0].aim_x as i8,
                        aim_y: tick[0].aim_y as i8,
                    },
                    FpInput {
                        buttons: tick[1].buttons,
                        aim_x: tick[1].aim_x as i8,
                        aim_y: tick[1].aim_y as i8,
                    },
                ]
            })
            .collect(),
    }
}

/// Pad a byte buffer to u32 alignment and convert to u32 words.
fn bytes_to_words(bytes: &[u8]) -> Vec<u32> {
    let padded_len = (bytes.len() + 3) / 4 * 4;
    let mut padded = bytes.to_vec();
    padded.resize(padded_len, 0);
    padded.chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Encode chunk inputs as raw bytes (tick_count × 6 bytes)
fn encode_chunk_inputs(transcript: &[[FpInput; 2]], start: usize, count: usize) -> Vec<u8> {
    let end = (start + count).min(transcript.len());
    let actual_count = end - start;
    let mut buf = Vec::with_capacity(actual_count * 6);
    for i in start..end {
        buf.push(transcript[i][0].buttons);
        buf.push(transcript[i][0].aim_x as u8);
        buf.push(transcript[i][0].aim_y as u8);
        buf.push(transcript[i][1].buttons);
        buf.push(transcript[i][1].aim_x as u8);
        buf.push(transcript[i][1].aim_y as u8);
    }
    buf
}

// ============================================================================
// Monolithic proving (original single-guest approach)
// ============================================================================

fn run_monolithic(fp_input: &FpProverInput, use_groth16: bool) {
    let raw_bytes = fp::encode_raw_input(fp_input);
    eprintln!("Converted to raw bytes: {} bytes", raw_bytes.len());

    let mode = if use_groth16 { "Groth16" } else { "local STARK" };
    eprintln!("Starting monolithic proof generation ({mode})...");

    let byte_len = raw_bytes.len() as u32;
    let words = bytes_to_words(&raw_bytes);

    let env = risc0_zkvm::ExecutorEnv::builder()
        .write_slice(&[byte_len])
        .write_slice(&words)
        .build()
        .expect("Failed to build executor env");

    let prover = risc0_zkvm::default_prover();
    let opts = if use_groth16 {
        risc0_zkvm::ProverOpts::groth16()
    } else {
        risc0_zkvm::ProverOpts::default()
    };

    let start = Instant::now();
    let prove_info = prover
        .prove_with_opts(env, CHICKENZ_GUEST_ELF, &opts)
        .expect("Proof generation failed");
    let elapsed = start.elapsed();

    let receipt = prove_info.receipt;
    eprintln!("{mode} proof generated in {:.1}s", elapsed.as_secs_f64());
    eprintln!("Stats: {} segment(s)", prove_info.stats.segments);
    eprintln!(
        "Total cycles: {} ({:.1}M)",
        prove_info.stats.total_cycles,
        prove_info.stats.total_cycles as f64 / 1_000_000.0
    );
    eprintln!("User cycles: {}", prove_info.stats.user_cycles);

    let output = ProverOutput::from_journal_bytes(&receipt.journal.bytes);
    print_result(&output);

    receipt
        .verify(CHICKENZ_GUEST_ID)
        .expect("Receipt verification failed");
    eprintln!("Receipt verified locally.");
    print_ids_and_artifacts(&receipt, &CHICKENZ_GUEST_ID, &output, use_groth16);
}

// ============================================================================
// Chunked proving (chunk guests + match composer)
// ============================================================================

fn run_chunked(fp_input: &FpProverInput, use_groth16: bool) {
    let total_ticks = fp_input.transcript.len();
    let num_chunks = (total_ticks + CHUNK_SIZE - 1) / CHUNK_SIZE;
    eprintln!(
        "Chunked proving: {} ticks / {} = {} chunks of {} ticks",
        total_ticks, CHUNK_SIZE, num_chunks, CHUNK_SIZE
    );

    // Step 1: Run sim natively to get state at each chunk boundary
    eprintln!("Computing chunk boundary states...");
    let map = fp::arena_map();
    let mut state = fp::create_initial_state(fp_input.seed, &map);
    let mut boundary_states = vec![state.clone()]; // state before each chunk

    for chunk_idx in 0..num_chunks {
        let start_tick = chunk_idx * CHUNK_SIZE;
        let end_tick = (start_tick + CHUNK_SIZE).min(total_ticks);

        for t in start_tick..end_tick {
            fp::step_mut(&mut state, &fp_input.transcript[t], &map);
            if state.match_over {
                break;
            }
        }
        boundary_states.push(state.clone());
        if state.match_over {
            // Fill remaining boundary states
            for _ in (chunk_idx + 1)..num_chunks {
                boundary_states.push(state.clone());
            }
            break;
        }
    }
    eprintln!("Final state: winner={}, scores={:?}", state.winner, state.score);

    // Step 2: Prove each chunk
    let prover = risc0_zkvm::default_prover();
    let opts = risc0_zkvm::ProverOpts::default(); // chunks always use STARK
    let mut chunk_receipts = Vec::with_capacity(num_chunks);
    let mut total_chunk_cycles = 0u64;

    let chunks_start = Instant::now();
    for chunk_idx in 0..num_chunks {
        let start_tick = chunk_idx * CHUNK_SIZE;
        let ticks_in_chunk = (CHUNK_SIZE).min(total_ticks - start_tick);

        let state_bytes = fp::encode_state(&boundary_states[chunk_idx]);
        let input_bytes = encode_chunk_inputs(&fp_input.transcript, start_tick, ticks_in_chunk);

        let state_words = bytes_to_words(&state_bytes);
        let input_words = bytes_to_words(&input_bytes);

        let env = risc0_zkvm::ExecutorEnv::builder()
            .write_slice(&[state_bytes.len() as u32, ticks_in_chunk as u32])
            .write_slice(&state_words)
            .write_slice(&input_words)
            .build()
            .expect("Failed to build chunk env");

        let chunk_start = Instant::now();
        let prove_info = prover
            .prove_with_opts(env, CHICKENZ_CHUNK_GUEST_ELF, &opts)
            .expect(&format!("Chunk {chunk_idx} proof failed"));
        let chunk_elapsed = chunk_start.elapsed();

        total_chunk_cycles += prove_info.stats.total_cycles;
        eprintln!(
            "  Chunk {}/{}: {:.1}s, {} cycles ({} segments)",
            chunk_idx + 1,
            num_chunks,
            chunk_elapsed.as_secs_f64(),
            prove_info.stats.total_cycles,
            prove_info.stats.segments,
        );

        chunk_receipts.push(prove_info.receipt);
    }
    let chunks_elapsed = chunks_start.elapsed();
    eprintln!(
        "All chunks proved in {:.1}s ({} total cycles)",
        chunks_elapsed.as_secs_f64(),
        total_chunk_cycles,
    );

    // Step 3: Prove match composer (verifies chunk chain)
    eprintln!("Proving match composer...");

    let mut env_builder = risc0_zkvm::ExecutorEnv::builder();

    // Write header: seed, num_chunks
    env_builder.write_slice(&[fp_input.seed, num_chunks as u32]);

    // Write chunk image ID
    env_builder.write_slice(&CHICKENZ_CHUNK_GUEST_ID);

    // Write each chunk's journal and add as assumption
    for receipt in &chunk_receipts {
        let journal_bytes = &receipt.journal.bytes;
        // Journal is CHUNK_PROOF_WORDS × 4 = 120 bytes
        assert_eq!(
            journal_bytes.len(),
            CHUNK_PROOF_WORDS * 4,
            "Unexpected journal size: {}",
            journal_bytes.len()
        );
        let journal_words = bytes_to_words(journal_bytes);
        assert_eq!(journal_words.len(), CHUNK_PROOF_WORDS);
        env_builder.write_slice(&journal_words);
        env_builder.add_assumption(receipt.clone());
    }

    let composer_opts = if use_groth16 {
        risc0_zkvm::ProverOpts::groth16()
    } else {
        risc0_zkvm::ProverOpts::default()
    };

    let env = env_builder.build().expect("Failed to build composer env");

    let composer_start = Instant::now();
    let prove_info = prover
        .prove_with_opts(env, CHICKENZ_MATCH_GUEST_ELF, &composer_opts)
        .expect("Composer proof failed");
    let composer_elapsed = composer_start.elapsed();

    let receipt = prove_info.receipt;
    let mode = if use_groth16 { "Groth16" } else { "local STARK" };
    eprintln!(
        "Composer proof ({mode}) in {:.1}s, {} cycles ({} segments)",
        composer_elapsed.as_secs_f64(),
        prove_info.stats.total_cycles,
        prove_info.stats.segments,
    );

    let total_elapsed = chunks_start.elapsed();
    eprintln!("Total wall-clock: {:.1}s", total_elapsed.as_secs_f64());

    // Verify and output
    let output = ProverOutput::from_journal_bytes(&receipt.journal.bytes);
    print_result(&output);

    receipt
        .verify(CHICKENZ_MATCH_GUEST_ID)
        .expect("Receipt verification failed");
    eprintln!("Composite receipt verified locally.");
    print_ids_and_artifacts(&receipt, &CHICKENZ_MATCH_GUEST_ID, &output, use_groth16);
}

// ============================================================================
// Boundless remote proving (enabled with --features boundless)
// ============================================================================

#[cfg(feature = "boundless")]
async fn run_boundless(fp_input: &FpProverInput) {
    use std::time::Duration;
    use boundless_market::storage::{StorageUploaderConfig, StorageUploaderType};
    use boundless_market::contracts::FulfillmentData;
    use boundless_market::Client;

    // 1. Encode input as raw bytes (same encoding as monolithic)
    let raw_bytes = fp::encode_raw_input(fp_input);
    let byte_len = raw_bytes.len() as u32;
    let words = bytes_to_words(&raw_bytes);

    // Build stdin byte stream matching ExecutorEnv::write_slice layout
    let mut stdin_bytes: Vec<u8> = Vec::new();
    stdin_bytes.extend_from_slice(&byte_len.to_le_bytes());
    for word in &words {
        stdin_bytes.extend_from_slice(&word.to_le_bytes());
    }
    eprintln!("Input encoded: {} raw bytes → {} stdin bytes", raw_bytes.len(), stdin_bytes.len());

    // 2. Read env vars
    let rpc_url: url::Url = std::env::var("RPC_URL")
        .expect("RPC_URL env var required (e.g. https://sepolia.base.org)")
        .parse()
        .expect("Invalid RPC_URL");
    let private_key: alloy::signers::local::PrivateKeySigner = std::env::var("PRIVATE_KEY")
        .expect("PRIVATE_KEY env var required (hex with 0x prefix)")
        .parse()
        .expect("Invalid PRIVATE_KEY");
    let pinata_jwt = std::env::var("PINATA_JWT")
        .expect("PINATA_JWT env var required for uploading ELF/input to IPFS");

    // 3. Build storage config for Pinata (IPFS)
    let storage_config = StorageUploaderConfig::builder()
        .storage_uploader(StorageUploaderType::Pinata)
        .pinata_jwt(pinata_jwt)
        .build()
        .expect("Failed to build storage config");

    // 4. Build Boundless client
    eprintln!("Connecting to Boundless market...");
    let client = Client::builder()
        .with_rpc_url(rpc_url)
        .with_uploader_config(&storage_config)
        .await
        .expect("Failed to configure storage uploader")
        .with_private_key(private_key)
        .build()
        .await
        .expect("Failed to build Boundless client");

    // 5. Submit proof request (monolithic guest, standalone Groth16)
    // Using default pricing (SDK maximizes fulfillment chances)
    eprintln!("Submitting proof request to Boundless...");
    let request = client
        .new_request()
        .with_program(CHICKENZ_GUEST_ELF)
        .with_stdin(stdin_bytes)
        .with_groth16_proof();

    let (request_id, expires_at) = client
        .submit_onchain(request)
        .await
        .expect("Failed to submit proof request");
    eprintln!("Submitted! Request ID: {:x}", request_id);
    eprintln!("Expires at block: {}", expires_at);
    eprintln!("Waiting for proof generation (polling every 5s)...");
    let boundless_start = Instant::now();

    // 6. Wait for fulfillment
    let fulfillment = client
        .wait_for_request_fulfillment(request_id, Duration::from_secs(5), expires_at)
        .await
        .expect("Proof generation failed or timed out");
    let boundless_elapsed = boundless_start.elapsed();
    eprintln!("Boundless proof fulfilled in {:.1}s", boundless_elapsed.as_secs_f64());

    // 7. Extract seal and journal
    let seal = fulfillment.seal.to_vec();
    let fulfillment_data = fulfillment
        .data()
        .expect("Failed to decode fulfillment data");
    let journal_bytes: Vec<u8> = match fulfillment_data {
        FulfillmentData::ImageIdAndJournal(_, journal) => journal.to_vec(),
        _ => panic!("Unexpected fulfillment data type (expected ImageIdAndJournal)"),
    };

    let output = ProverOutput::from_journal_bytes(&journal_bytes);

    eprintln!("Proof received! Seal: {} bytes, Journal: {} bytes", seal.len(), journal_bytes.len());
    print_result(&output);

    // 8. Write proof_artifacts.json (same format as local proving)
    let image_id_hex = hex::encode(
        CHICKENZ_GUEST_ID.iter().flat_map(|w| w.to_le_bytes()).collect::<Vec<_>>()
    );
    let artifacts = serde_json::json!({
        "seal": hex::encode(&seal),
        "image_id": image_id_hex,
        "journal": hex::encode(&journal_bytes),
        "output": {
            "winner": output.winner,
            "scores": output.scores,
            "transcript_hash": hex::encode(output.transcript_hash),
            "seed_commit": hex::encode(output.seed_commit),
        }
    });
    std::fs::write("proof_artifacts.json", serde_json::to_string_pretty(&artifacts).unwrap())
        .expect("Failed to write artifacts");
    eprintln!("Artifacts written to proof_artifacts.json");
    println!("\n=== Ready for Soroban submission ===");
}

// ============================================================================
// Output helpers
// ============================================================================

fn print_result(output: &ProverOutput) {
    println!("=== Proof Result ===");
    println!("Winner: {}", output.winner);
    println!("Scores: P0={}, P1={}", output.scores[0], output.scores[1]);
    println!(
        "Transcript hash: {}",
        hex::encode(output.transcript_hash)
    );
    println!("Seed commit: {}", hex::encode(output.seed_commit));
}

fn print_ids_and_artifacts(
    receipt: &risc0_zkvm::Receipt,
    image_id: &[u32; 8],
    output: &ProverOutput,
    use_groth16: bool,
) {
    let image_id_bytes: Vec<u8> = image_id
        .iter()
        .flat_map(|w| w.to_le_bytes())
        .collect();
    let image_id_hex = hex::encode(&image_id_bytes);
    eprintln!("Image ID: {}", image_id_hex);

    let journal_bytes = receipt.journal.bytes.clone();
    eprintln!("Journal size: {} bytes", journal_bytes.len());

    // Try to extract Groth16 seal; fall back to empty if not available (dev mode)
    let seal = if use_groth16 {
        match receipt.inner.groth16() {
            Ok(g) => {
                eprintln!("Seal size: {} bytes", g.seal.len());
                g.seal.clone()
            }
            Err(_) => {
                eprintln!("WARNING: No Groth16 seal (dev mode?). Writing artifacts with empty seal.");
                vec![]
            }
        }
    } else {
        vec![]
    };

    let artifacts = serde_json::json!({
        "seal": hex::encode(&seal),
        "image_id": image_id_hex,
        "journal": hex::encode(&journal_bytes),
        "output": {
            "winner": output.winner,
            "scores": output.scores,
            "transcript_hash": hex::encode(output.transcript_hash),
            "seed_commit": hex::encode(output.seed_commit),
        }
    });

    let output_path = "proof_artifacts.json";
    std::fs::write(output_path, serde_json::to_string_pretty(&artifacts).unwrap())
        .expect("Failed to write artifacts");
    eprintln!("Artifacts written to {output_path}");

    if !seal.is_empty() {
        println!("\n=== Ready for Soroban submission ===");
    } else {
        println!("\n=== Artifacts written (dev/STARK mode — not submittable on-chain) ===");
        println!("Image ID: {image_id_hex}");
        println!("Journal: {} bytes", journal_bytes.len());
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let use_groth16 = !args.iter().any(|a| a == "--local");
    let use_chunked = args.iter().any(|a| a == "--chunked");
    let use_boundless = args.iter().any(|a| a == "--boundless");

    eprintln!("Loading transcript...");
    let input = load_input();
    eprintln!(
        "Transcript loaded: {} ticks, seed={}",
        input.transcript.len(),
        input.config.seed
    );

    let fp_input = to_fp_input(&input);

    if use_boundless {
        #[cfg(feature = "boundless")]
        {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(run_boundless(&fp_input));
        }
        #[cfg(not(feature = "boundless"))]
        {
            eprintln!("ERROR: Boundless feature not enabled.");
            eprintln!("Build with: cargo build -p chickenz-host --features boundless");
            std::process::exit(1);
        }
    } else if use_chunked {
        run_chunked(&fp_input, use_groth16);
    } else {
        run_monolithic(&fp_input, use_groth16);
    }
}
