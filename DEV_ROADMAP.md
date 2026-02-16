# DEV_ROADMAP.md

# Hackathon Sprint — Stellar Hacks: ZK Gaming

**Deadline: 2026-02-23**

## Phase 1 – Deterministic Offline Game ✅

- Sim core: `step()`, types, PRNG, physics, projectiles, hashing
- 29 tests passing (PRNG, physics, step, replay determinism)
- Phaser client: local 2-player, keyboard input, 60Hz fixed timestep

## Phase 2 – Multiplayer Server

- Node.js + WebSocket authoritative server (`apps/server`)
- Server runs sim at 60Hz, clients send inputs only
- Client-side prediction + reconciliation on snapshot mismatch
- Matchmaking: simple lobby or direct connect (2 players)
- Server records full input transcript for ZK proving
- Shared protocol types (`packages/protocol`)

## Phase 3 – Noir ZK Circuit

- Port sim logic to Noir (or implement a simplified verifier circuit)
- Circuit replays game from seed + inputs, asserts final outcome
- Public inputs: match_id, seed_commit, transcript_hash, winner
- Private witness: seed, full input transcript
- Test: prove a short match (e.g. 300-600 ticks), verify proof

**Key constraint**: Noir circuits operate on fixed-size inputs and finite fields. The sim may need simplification for provability (fewer ticks, integer-only math, bounded loops).

## Phase 4 – Soroban Contract + Game Hub

- Write Chickenz Soroban contract in Rust
- `start_match()`: calls Game Hub `start_game()`, stores match params
- `settle_match()`: accepts ZK proof, verifies, calls Game Hub `end_game()` with winner
- Game Hub contract: `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG`
- Deploy to Stellar Testnet

## Phase 5 – Frontend Integration

- Add Stellar wallet connection (Freighter or CreitTech wallet kit)
- Wire match flow: connect wallet → matchmake → play online → record transcript → generate proof → submit settlement
- Show proof status and on-chain settlement in UI
- Display Game Hub interaction (start/end game events)

## Phase 6 – Polish & Submit

- Clean up README with setup instructions, architecture overview, screenshots
- Push to public GitHub repo
- Record 2-3 minute video demo showing:
  - Online multiplayer gameplay
  - ZK proof generation
  - On-chain settlement via Game Hub
- Submit on DoraHacks

---

# Post-Hackathon Roadmap (Future)

## Competitive Hardening
- Server rewind for lag-compensated hit validation
- Disconnect handling, desync smoothing

## Transcript Integrity
- Player-signed input batches, commitment chain, replay verification

## Production ZK
- Chunked proving, recursive aggregation, mainnet deployment
