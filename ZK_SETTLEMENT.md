# ZK Settlement

The ZK proof is the core mechanic: it cryptographically proves that a game was played fairly and the claimed winner is correct, without revealing the full game transcript on-chain.

**Stack**: RISC Zero zkVM + Groth16 compression + Nethermind Soroban verifier

---

## What the Proof Verifies

1. **Fair randomness** — seed matches the committed `seed_commit` (SHA-256)
2. **Transcript integrity** — input transcript matches `transcript_hash` (SHA-256)
3. **Correct replay** — deterministic sim with seed + inputs produces the claimed final state
4. **Correct winner** — winner derived from final state (elimination or score comparison)

---

## Journal Layout (76 bytes)

The guest program commits a fixed-size journal to the zkVM:

```
Offset  Size   Field            Encoding
0       4      winner           i32 (little-endian): 0 or 1
4       4      score_p1         u32 (little-endian): player 0 kills
8       4      score_p2         u32 (little-endian): player 1 kills
12      32     transcript_hash  [u8; 32]: SHA-256 of input transcript
44      32     seed_commit      [u8; 32]: SHA-256 of match seed
---
Total: 76 bytes (19 u32 words)
```

On-chain, the verifier receives `SHA-256(journal)` as a `BytesN<32>`.

---

## Proving Pipeline

### Monolithic Mode (5.2M cycles)

Single guest program replays all 3600 ticks:

```
Input:  seed (u32) + transcript (3600 × 2 × PlayerInput)
Guest:  init_state(seed) → step_mut() × 3600 → commit journal
Output: Groth16 seal (260 bytes) + journal (76 bytes)
```

### Chunked Mode (6.8M total cycles)

10 chunks of 360 ticks, composed via proof recursion:

```
Chunk Guest (×10):
  Input:  chunk_index, seed, transcript_slice, prev_state_hash
  Verify: env::verify(prev_chunk_proof) if chunk > 0
  Exec:   step_mut() × 360
  Output: chunk proof with state hash chain

Match Composer:
  Input:  10 chunk proofs
  Verify: env::verify() for each chunk (zero execution cycles)
  Output: Final journal (winner, scores, hashes)
```

---

## Optimizations

| Technique | Cycles | Speedup |
|---|---|---|
| Original (f64 soft-float) | 52.4M | — |
| Fixed-point i32 (8 frac bits) | 11.5M | 4.6x |
| In-place mutation (`step_mut`) | 8.5M | 1.4x |
| Raw byte I/O (no serde) | 5.2M | 1.6x |
| **Total reduction** | **5.2M** | **10x** |

Key decisions:
- `i32` with 8 fractional bits (256 = 1.0) — eliminates f64 soft-float overhead in RISC-V
- `step_mut(&mut State)` — zero-copy, avoids cloning 500+ byte state per tick
- `env::read_slice` / `env::commit_slice` — raw bytes, no serde framework

---

## Settlement Flow

```
1. Match ends → server stores transcript
2. Client calls start_match() on Chickenz contract
   → Contract calls Game Hub start_game()
3. Prover replays transcript in RISC Zero zkVM
   → Produces Groth16 seal (260 bytes) + journal (76 bytes)
4. Client calls settle_match(seal, journal) on Chickenz contract
   → Contract calls Groth16 verifier: verify(seal, image_id, sha256(journal))
   → Contract decodes journal: winner, scores, transcript_hash, seed_commit
   → Contract validates seed_commit matches stored value
   → Contract calls Game Hub end_game(winner)
```

---

## Soroban Contract Interface

```rust
// Register a new match on the Game Hub
fn start_match(
    env: Env,
    match_id: BytesN<32>,
    player1: Address,
    player2: Address,
    seed_commit: BytesN<32>,
) -> Result<(), Error>;

// Verify proof and settle on Game Hub
fn settle_match(
    env: Env,
    match_id: BytesN<32>,
    seal: Bytes,          // 260 bytes: 4-byte selector + 256-byte Groth16 proof
    journal: Bytes,       // 76 bytes: winner + scores + hashes
) -> Result<(), Error>;
```

---

## Deployed Contracts (Testnet)

| Contract | Address |
|---|---|
| Chickenz Game | `CDYU5GFNDBIFYWLW54QV3LPDNQTER6ID3SK4QCCBVUY7NU76ESBP7LZP` |
| Groth16 Verifier | `CDUDXCLMNE7Q4BZJLLB3KACFOS55SS55GSQW2UYHDUXTJKZUDDAJYCIH` |
| Game Hub | `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG` |

Match-guest image ID: `c48f7169630d597526348ba1f9375186bfd1e821b52a6ec75957aabe179713d3`

---

## Trust Model

**Hackathon (current):**
- Server runs authoritative sim, records transcript
- Any party with the transcript can generate the ZK proof
- Contract trusts only the cryptographic proof — not the server

**Production (future):**
- Players sign input batches (non-repudiation)
- Anyone-can-settle: any third party can prove and submit
- Boundless proving marketplace for trustless proof generation
