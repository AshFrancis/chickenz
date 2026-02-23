use std::io::Read;
use std::time::Instant;

use chickenz_core::fp::{self, FpInput};
use chickenz_core::{MultiRoundProverInput, ProverInput, ProverOutput};

use chickenz_methods::CHICKENZ_GUEST_ELF;
use chickenz_methods::CHICKENZ_GUEST_ID;

/// Loaded input: either single-round (legacy) or multi-round.
enum LoadedInput {
    Single(ProverInput),
    Multi(MultiRoundProverInput),
}

fn load_json() -> String {
    let args: Vec<String> = std::env::args().collect();

    if args.len() > 1 && !args[1].starts_with("--") {
        std::fs::read_to_string(&args[1]).expect("Failed to read transcript file")
    } else if args.len() > 2 && !args[2].starts_with("--") {
        std::fs::read_to_string(&args[2]).expect("Failed to read transcript file")
    } else {
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .expect("Failed to read from stdin");
        buf
    }
}

fn load_input(json_str: &str) -> LoadedInput {
    // Try multi-round first (has "rounds" key), fall back to single-round
    if let Ok(multi) = serde_json::from_str::<MultiRoundProverInput>(json_str) {
        LoadedInput::Multi(multi)
    } else {
        let single: ProverInput = serde_json::from_str(json_str)
            .expect("Failed to parse input JSON (tried both multi-round and single-round formats)");
        LoadedInput::Single(single)
    }
}

fn to_fp_round(transcript: &[[chickenz_core::PlayerInput; 2]]) -> Vec<[FpInput; 2]> {
    transcript
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
        .collect()
}

/// Pad a byte buffer to u32 alignment and convert to u32 words.
fn bytes_to_words(bytes: &[u8]) -> Vec<u32> {
    let padded_len = (bytes.len() + 3) / 4 * 4;
    let mut padded = bytes.to_vec();
    padded.resize(padded_len, 0);
    padded
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

// ============================================================================
// Monolithic proving (single-guest approach)
// ============================================================================

fn run_monolithic_multi(seed: u32, rounds: &[Vec<[FpInput; 2]>], use_groth16: bool) {
    let raw_bytes = fp::encode_raw_multi_round(seed, rounds);
    eprintln!(
        "Converted to raw bytes: {} bytes ({} rounds)",
        raw_bytes.len(),
        rounds.len()
    );

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

    receipt.verify(CHICKENZ_GUEST_ID).expect("Receipt verification failed");
    eprintln!("Receipt verified locally.");
    print_ids_and_artifacts(&receipt, &CHICKENZ_GUEST_ID, &output, use_groth16);
}

// ============================================================================
// Boundless remote proving (enabled with --features boundless)
// ============================================================================

#[cfg(feature = "boundless")]
async fn run_boundless_multi(seed: u32, rounds: &[Vec<[FpInput; 2]>]) {
    use boundless_market::contracts::FulfillmentData;
    use boundless_market::storage::{StorageUploaderConfig, StorageUploaderType};
    use boundless_market::Client;
    use std::time::Duration;

    // 1. Encode input as raw bytes (multi-round encoding)
    let raw_bytes = fp::encode_raw_multi_round(seed, rounds);
    let byte_len = raw_bytes.len() as u32;
    let words = bytes_to_words(&raw_bytes);

    // Build stdin byte stream matching ExecutorEnv::write_slice layout
    let mut stdin_bytes: Vec<u8> = Vec::new();
    stdin_bytes.extend_from_slice(&byte_len.to_le_bytes());
    for word in &words {
        stdin_bytes.extend_from_slice(&word.to_le_bytes());
    }
    eprintln!(
        "Input encoded: {} raw bytes → {} stdin bytes",
        raw_bytes.len(),
        stdin_bytes.len()
    );

    // 2. Read env vars
    let rpc_url: url::Url = std::env::var("RPC_URL")
        .expect("RPC_URL env var required (e.g. https://sepolia.base.org)")
        .parse()
        .expect("Invalid RPC_URL");
    let private_key: alloy::signers::local::PrivateKeySigner = std::env::var("PRIVATE_KEY")
        .expect("PRIVATE_KEY env var required (hex with 0x prefix)")
        .parse()
        .expect("Invalid PRIVATE_KEY");
    let pinata_jwt = std::env::var("PINATA_JWT").expect("PINATA_JWT env var required for uploading ELF/input to IPFS");

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
    let fulfillment_data = fulfillment.data().expect("Failed to decode fulfillment data");
    let journal_bytes: Vec<u8> = match fulfillment_data {
        FulfillmentData::ImageIdAndJournal(_, journal) => journal.to_vec(),
        _ => panic!("Unexpected fulfillment data type (expected ImageIdAndJournal)"),
    };

    let output = ProverOutput::from_journal_bytes(&journal_bytes);

    eprintln!(
        "Proof received! Seal: {} bytes, Journal: {} bytes",
        seal.len(),
        journal_bytes.len()
    );
    print_result(&output);

    // 8. Write proof_artifacts.json (same format as local proving)
    let image_id_hex = hex::encode(
        CHICKENZ_GUEST_ID
            .iter()
            .flat_map(|w| w.to_le_bytes())
            .collect::<Vec<_>>(),
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
    std::fs::write(
        "proof_artifacts.json",
        serde_json::to_string_pretty(&artifacts).unwrap(),
    )
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
    println!("Transcript hash: {}", hex::encode(output.transcript_hash));
    println!("Seed commit: {}", hex::encode(output.seed_commit));
}

fn print_ids_and_artifacts(
    receipt: &risc0_zkvm::Receipt,
    image_id: &[u32; 8],
    output: &ProverOutput,
    use_groth16: bool,
) {
    let image_id_bytes: Vec<u8> = image_id.iter().flat_map(|w| w.to_le_bytes()).collect();
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
    std::fs::write(output_path, serde_json::to_string_pretty(&artifacts).unwrap()).expect("Failed to write artifacts");
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
    let use_boundless = args.iter().any(|a| a == "--boundless");

    eprintln!("Loading transcript...");
    let json_str = load_json();
    let loaded = load_input(&json_str);

    // Convert to seed + rounds (multi-round format)
    let (seed, rounds) = match &loaded {
        LoadedInput::Multi(multi) => {
            let rounds: Vec<Vec<[FpInput; 2]>> = multi.rounds.iter().map(|r| to_fp_round(r)).collect();
            let total_ticks: usize = rounds.iter().map(|r| r.len()).sum();
            eprintln!(
                "Multi-round transcript loaded: {} rounds, {} total ticks, seed={}",
                rounds.len(),
                total_ticks,
                multi.config.seed
            );
            (multi.config.seed, rounds)
        }
        LoadedInput::Single(single) => {
            eprintln!(
                "Single-round transcript loaded: {} ticks, seed={} (wrapping as 1 round)",
                single.transcript.len(),
                single.config.seed
            );
            let round = to_fp_round(&single.transcript);
            (single.config.seed, vec![round])
        }
    };

    if use_boundless {
        #[cfg(feature = "boundless")]
        {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(run_boundless_multi(seed, &rounds));
        }
        #[cfg(not(feature = "boundless"))]
        {
            eprintln!("ERROR: Boundless feature not enabled.");
            eprintln!("Build with: cargo build -p chickenz-host --features boundless");
            std::process::exit(1);
        }
    } else {
        run_monolithic_multi(seed, &rounds, use_groth16);
    }
}
