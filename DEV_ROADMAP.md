# Hackathon Sprint — Stellar Hacks: ZK Gaming

**Deadline: 2026-02-23**

## Phase 1 — Deterministic Game Sim ✅

- Pure TypeScript sim core: `step()`, types, PRNG, physics, projectiles, weapons, hashing
- 54 tests passing (PRNG, physics, weapons, lives, sudden death, time-up, replay determinism)
- Phaser client: local 2-player, keyboard input, 60Hz fixed timestep

## Phase 2 — Multiplayer Server ✅

- Bun WebSocket server (`services/server/`)
- Server-authoritative sim at 60Hz, clients send inputs only
- Client-side prediction with rollback reconciliation
- Lobby system: quick play, named rooms, private rooms, password protection, join codes
- ELO ranking, match history, leaderboard
- Server records full input transcript for ZK proving

## Phase 3 — RISC Zero ZK Prover ✅

- Rust port of sim core with cross-validated tests (47 Rust tests, matches TS output)
- Fixed-point i32 arithmetic (8 frac bits) — eliminates f64 soft-float in zkVM
- Monolithic guest: 3600 ticks in single execution (5.2M cycles, 10x reduction from original)
- Chunked composition: 10 × 360-tick chunks + match composer via `env::verify()`
- Raw byte I/O: `env::read_slice` / `env::commit_slice` (no serde)
- Journal: 76 bytes fixed layout (winner, scores, transcript_hash, seed_commit)

## Phase 4 — Soroban Contract + Game Hub ✅

- Chickenz contract: `start_match()`, `settle_match()` with Groth16 verification
- Cross-contract calls to Game Hub (`start_game`, `end_game`)
- Groth16 verifier: Nethermind stellar-risc0-verifier (BN254 native pairing, Protocol 25)
- Deployed and initialized on Stellar Testnet

## Phase 5 — Frontend Integration ✅

- Stellar wallet connection via WalletKit (Freighter/Lobstr)
- Online lobby with matchmaking, room browser, leaderboard, match history
- Dynamic camera zoom, audio system, username display
- Replay viewer with playback controls
- Proof status tracking (pending → proving → verified → settled)

## Phase 6 — Polish & Submit

- [x] Clean up documentation
- [ ] Record 2-3 minute video demo
- [ ] Final testing of end-to-end settlement flow
- [ ] Push to public GitHub repo
- [ ] Submit on DoraHacks

---

## Post-Hackathon Roadmap

- Player-signed input batches for non-repudiation
- Boundless proving marketplace integration
- Mainnet deployment
- Tournament mode, spectator view
- Mobile-responsive UI
