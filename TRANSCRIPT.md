# Transcript Model

The transcript is the complete record of player inputs for a match. It is the private witness for the ZK proof.

---

## Structure

**Multi-round format** (used for proving):

```
Encoding: [round_count: 4 LE] [seed: 4 LE] per round: [tick_count: 4 LE] [ticks × 6 bytes]
```

Each tick is 6 bytes: `[buttons_p0, aim_x_p0, aim_y_p0, buttons_p1, aim_x_p1, aim_y_p1]` where aim values are encoded as signed bytes (i8).

Per-round inputs:
- player1_input: { buttons, aimX, aimY }
- player2_input: { buttons, aimX, aimY }

Match metadata:
- seed (shared across all rounds in ranked mode)
- round count (2 — both winning rounds)
- tick count per round (up to 1800)

---

## Hashing

**Per-round hash**: SHA-256 of all tick bytes for that round.

**transcript_hash**: `SHA-256(round1_hash || round2_hash)` — chain of per-round hashes.

This hash is a public input to the ZK circuit. The RISC Zero guest re-hashes the private witness inputs and asserts they match.

**seed_commit**: `SHA-256(seed)` — committed on-chain at match start. The guest verifies the seed embedded in the transcript matches `seed_commit`.

---

## Integrity Guarantees

**Current (server-authoritative):**
- Server records per-round transcripts during gameplay
- Both winning rounds are extracted and encoded for proving
- Transcript feeds RISC Zero zkVM guest, which replays both rounds
- ZK proof guarantees transcript produces the claimed outcome
- Groth16-compressed proof verified on-chain via Soroban
- `seed_commit` verified on-chain (committed before gameplay, proven in journal)

**Future (decentralized):**
- Players sign input batches (non-repudiation)
- Server verifies signatures
- Transcript is append-only
- Anyone-can-settle: third parties can prove and submit

---

## Data Availability

Settlement requires:
- transcript_hash (public, in ZK journal)
- seed_commit (public, on-chain — committed at match start)
- ZK proof: Groth16 seal (260 bytes) + journal (76 bytes)
- The seed is embedded in the journal; no separate reveal needed

**Transcript storage:**
- Persisted in server SQLite (survives room cleanup and server restarts)
- Available via `GET /transcript/{roomId}` API
- Boundless proving uploads the transcript to IPFS as prover input (pinned via Pinata)
- Anyone with the transcript can recompute `transcript_hash` and verify it matches the journal value
