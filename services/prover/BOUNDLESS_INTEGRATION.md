# Boundless Integration Guide for RISC Zero on Apple Silicon

## Overview

**Boundless** is RISC Zero's decentralized proof marketplace that allows developers to submit proof requests without running their own provers. This is essential for Apple Silicon (M1/M2/M3) users because **Groth16 proving only works on x86 architecture** and is not supported on Apple Silicon, even via Docker.

## Key Information

### Apple Silicon Limitation
- **Groth16 prover requires x86 architecture**
- Apple Silicon is NOT supported for local Groth16 proving
- Solution: Use Boundless to outsource proving to remote x86 provers

### Boundless SDK

**Crate**: `boundless-market`
- Latest version: 1.3.3
- Add to Cargo.toml: `boundless-market = "1.3"`
- Documentation: https://docs.rs/boundless-market/latest/boundless_market/

### Network Support
- **Base Mainnet** (production)
- **Base Sepolia** (testnet)
- **Ethereum Sepolia** (testnet)

### Pricing
- Market-driven competitive pricing from decentralized provers
- Estimated: $0.04 to $0.17 per proof (batch of 4,000 transactions)
- Massive computations: less than $30 vs thousands for traditional ZK
- **No free tier** - you must fund requests with ETH to cover max_price

## Complete Rust Example

### Dependencies

```toml
[dependencies]
boundless-market = "1.3"
alloy = { version = "0.8", features = ["full"] }
risc0-zkvm = "1.2"
tokio = { version = "1", features = ["full"] }
anyhow = "1.0"
url = "2.5"
```

### Client Setup

```rust
use boundless_market::{Client, StorageUploaderConfig, Deployment};
use alloy::signers::local::PrivateKeySigner;
use std::time::Duration;
use url::Url;
use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    // Parse environment variables
    let rpc_url = std::env::var("RPC_URL")?.parse::<Url>()?;
    let private_key: PrivateKeySigner = std::env::var("PRIVATE_KEY")?.parse()?;

    // Create Boundless client
    let client = Client::builder()
        .with_rpc_url(rpc_url)
        .with_private_key(private_key)
        .with_deployment(None) // Use default deployment (Base Mainnet)
        .with_uploader_config(&StorageUploaderConfig::default())
        .await?
        .build()
        .await?;

    Ok(())
}
```

### Standard Groth16 Proof Request

```rust
// Build request with Groth16 proof type
let request = client
    .new_request()
    .with_program(GUEST_ELF)  // Your compiled RISC Zero guest binary
    .with_stdin(input_bytes)   // Serialized input data
    .with_groth16_proof();     // Request Groth16 proof (instead of default Merkle)

// Submit to Boundless market
let (request_id, expires_at) = client.submit(request).await?;
println!("Submitted request: {:x}", request_id);

// Wait for fulfillment (poll every 5 seconds)
let fulfillment = client
    .wait_for_request_fulfillment(
        request_id,
        Duration::from_secs(5),
        expires_at,
    )
    .await?;

// Extract proof data
let seal = fulfillment.seal;           // Groth16 proof seal
let data = fulfillment.data()?;
let journal = data.journal().unwrap(); // Public outputs
let image_id = data.image_id().unwrap(); // Guest program ID

println!("Proof generated! Seal: {:x}", seal);
```

### Blake3 Groth16 Variant (for SHA2-expensive environments)

```rust
// Blake3 Groth16 has strict requirements:
// - Only works with ClaimDigestMatch predicates
// - Journal MUST be exactly 32 bytes

let request = client
    .new_request()
    .with_program(ECHO_ELF)
    .with_stdin([255u8; 32].to_vec())  // Exactly 32 bytes
    .with_blake3_groth16_proof();       // Blake3 variant

let (request_id, expires_at) = client.submit(request).await?;
let fulfillment = client
    .wait_for_request_fulfillment(request_id, Duration::from_secs(5), expires_at)
    .await?;

// Verify Blake3 Groth16 seal
use blake3_groth16::{Blake3Groth16ReceiptClaim, verify};
let claim_digest = Blake3Groth16ReceiptClaim::ok(IMAGE_ID, input).claim_digest();
verify::verify_seal(&fulfillment.seal[4..], claim_digest)?; // Skip 4-byte selector
```

### Using Program URLs (for large binaries)

```rust
// Upload program to IPFS/S3 and use URL instead of embedding binary
let request = client
    .new_request()
    .with_program_url("https://your-storage.com/guest.bin".parse()?)
    .with_stdin(input_bytes)
    .with_groth16_proof();
```

## Proof Type Comparison

| Proof Type | Use Case | Cost | Restrictions |
|------------|----------|------|--------------|
| **Merkle Inclusion** (default) | Standard on-chain verification | Cheapest | Batched verification only |
| **Groth16** | Cross-chain, custom verification | More expensive | Standard RISC Zero proofs |
| **Blake3 Groth16** | BitVM, SHA2-expensive environments | Most expensive | 32-byte journals only |

## Environment Variables

```bash
# Required
export RPC_URL="https://base.llamarpc.com"  # Base Mainnet
# OR
export RPC_URL="https://sepolia.base.org"   # Base Sepolia testnet

export PRIVATE_KEY="0x..."  # Ethereum wallet private key (needs ETH for gas + proof payment)

# Optional storage (for large programs/inputs)
export PINATA_JWT="..."     # IPFS via Pinata (free tier available)
# OR
export S3_ACCESS_KEY="..."
export S3_SECRET_KEY="..."
export S3_BUCKET="..."
export AWS_REGION="us-east-1"
```

## Storage Configuration

For programs or inputs larger than 1KB, use external storage:

```rust
use boundless_market::storage::{StorageUploaderConfig, StorageUploaderType};

let storage_config = StorageUploaderConfig::builder()
    .storage_uploader(StorageUploaderType::Pinata)  // or S3, GoogleCloud
    .build()?;

let client = Client::builder()
    .with_rpc_url(rpc_url)
    .with_uploader_config(&storage_config)
    .await?
    // ...
```

**Pinata free tier** is recommended and covers most Boundless use cases.

## Stellar Integration

### Current Status (as of Feb 2026)
- **Futurenet**: RISC Zero Groth16 verifier is LIVE
- **Testnet**: bn254 functions deployed (Jan 7, 2026)
- **Mainnet**: bn254 functions deployed (Jan 22, 2026)

### Stellar Soroban Groth16 Verifier

**Repository**: https://github.com/NethermindEth/stellar-risc0-verifier

Nethermind built the RISC Zero Groth16 verifier contract for Stellar Soroban. The verifier uses bn254 cryptographic primitives that were added to Stellar in January 2026.

**Compatibility**: Boundless-generated Groth16 proofs ARE compatible with the Stellar verifier contract, as they both use standard RISC Zero Groth16 format.

### Workflow for Stellar

1. Generate proof via Boundless (on Apple Silicon):
```rust
let fulfillment = client
    .wait_for_request_fulfillment(request_id, duration, expires_at)
    .await?;
let seal = fulfillment.seal;  // Standard Groth16 seal
```

2. Submit to Stellar Soroban contract:
```rust
// Deploy or invoke the Nethermind RISC Zero verifier on Stellar
// Pass seal, image_id, and journal_digest to verify() function
```

3. Verifier contract checks the Groth16 proof on-chain using bn254 primitives

## Complete Working Example

Here's a minimal but complete example based on the Boundless `counter` example:

```rust
use std::time::Duration;
use alloy::signers::local::PrivateKeySigner;
use anyhow::{Context, Result};
use boundless_market::{Client, Deployment, StorageUploaderConfig};
use url::Url;

// Your RISC Zero guest ELF binary
const MY_GUEST_ELF: &[u8] = include_bytes!("../target/riscv-guest/riscv32im-risc0-zkvm-elf/release/my_guest");

#[tokio::main]
async fn main() -> Result<()> {
    let rpc_url: Url = std::env::var("RPC_URL")?.parse()?;
    let private_key: PrivateKeySigner = std::env::var("PRIVATE_KEY")?.parse()?;

    // Create Boundless client
    let client = Client::builder()
        .with_rpc_url(rpc_url)
        .with_deployment(None)  // Use default (Base Mainnet)
        .with_uploader_config(&StorageUploaderConfig::default())
        .await?
        .with_private_key(private_key)
        .build()
        .await
        .context("failed to build boundless client")?;

    // Prepare input data
    let input_data = 42u32.to_le_bytes();

    // Build and submit Groth16 proof request
    let request = client
        .new_request()
        .with_program(MY_GUEST_ELF)
        .with_stdin(&input_data)
        .with_groth16_proof();  // KEY: Request Groth16 instead of default Merkle

    let (request_id, expires_at) = client.submit(request).await?;
    println!("✓ Submitted request: 0x{:x}", request_id);

    // Poll for fulfillment (check every 5 seconds)
    println!("⏳ Waiting for proof generation...");
    let fulfillment = client
        .wait_for_request_fulfillment(
            request_id,
            Duration::from_secs(5),
            expires_at,
        )
        .await?;

    // Extract proof components
    let seal = fulfillment.seal;
    let data = fulfillment.data()?;
    let journal = data.journal().expect("missing journal");
    let image_id = data.image_id().expect("missing image_id");

    println!("✓ Proof generated!");
    println!("  Image ID: {:?}", image_id);
    println!("  Journal length: {} bytes", journal.len());
    println!("  Seal length: {} bytes", seal.len());

    // Now you can submit this to Stellar Soroban verifier contract
    // stellar_contract.verify(seal, image_id, journal_digest).await?;

    Ok(())
}
```

## Key Differences from Local Proving

### Local (x86 only)
```rust
use risc0_zkvm::{default_prover, ExecutorEnv, ProverOpts};

let env = ExecutorEnv::builder().write_slice(&input).build()?;
let receipt = default_prover()
    .prove_with_ctx(env, &VerifierContext::default(), GUEST_ELF, &ProverOpts::groth16())?
    .receipt;
```

### Boundless (works on Apple Silicon)
```rust
use boundless_market::Client;

let client = Client::builder().with_rpc_url(url).build().await?;
let request = client.new_request()
    .with_program(GUEST_ELF)
    .with_stdin(&input)
    .with_groth16_proof();
let fulfillment = client.submit(request).await?;
```

## Troubleshooting

### "Groth16 prover only works on x86"
- **Solution**: Use Boundless instead of local proving

### "Request failed: insufficient funds"
- **Cause**: Your wallet doesn't have enough ETH to pay max_price
- **Solution**: Fund your wallet with ETH on the target network (Base/Sepolia)

### "Timeout waiting for fulfillment"
- **Cause**: No provers accepted your request (price too low or network issues)
- **Solution**: Increase max_price or check network status

### "Blake3 Groth16 requires 32-byte journal"
- **Cause**: Your guest program outputs journal != 32 bytes
- **Solution**: Use standard `.with_groth16_proof()` or ensure exactly 32-byte output

## Resources

- **Boundless Docs**: https://docs.boundless.network/
- **Boundless Market SDK**: https://docs.rs/boundless-market/
- **RISC Zero Docs**: https://dev.risczero.com/
- **Stellar RISC Zero Verifier**: https://github.com/NethermindEth/stellar-risc0-verifier
- **Stellar Blog Post**: https://stellar.org/blog/developers/risc-zero-verifier
- **Example Code**: https://github.com/boundless-xyz/boundless/tree/main/examples

## Next Steps for Your Project

1. Add `boundless-market = "1.3"` to `services/prover/Cargo.toml`
2. Set up environment variables (RPC_URL, PRIVATE_KEY)
3. Modify your prover service to use Boundless client instead of local proving
4. Test with Base Sepolia testnet first
5. Deploy Nethermind RISC Zero verifier to Stellar testnet
6. Wire up proof submission from Boundless → Stellar verifier contract
7. Test end-to-end: game → proof request → Boundless → verify on Stellar
8. Deploy to mainnet for hackathon submission
