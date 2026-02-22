# Hackathon Sprint — Stellar Hacks: ZK Gaming

**Deadline: 2026-02-23**

## Phase 1 — Deterministic Game Sim ✅

- Pure TypeScript sim core: `step()`, types, PRNG, physics, projectiles, weapons, hashing
- 64 tests passing (PRNG, physics, weapons, lives, sudden death, time-up, replay determinism)
- Phaser client: local 2-player, keyboard input, 60Hz fixed timestep

## Phase 2 — Multiplayer Server ✅

- Bun WebSocket server (`services/server/`)
- Server-authoritative sim at 60Hz, clients send inputs only
- Client-side prediction with rollback reconciliation
- Lobby system: quick play, named rooms, private rooms, join codes
- ELO ranking, match history, leaderboard
- Server records full input transcript for ZK proving
- Bot opponents for casual quickplay (auto-join after 20s)
- Tournament mode with brackets and spectator support

## Phase 3 — RISC Zero ZK Prover ✅

- Rust sim core (single source of truth): 52 tests, compiled to WASM + RISC-V
- Fixed-point i32 arithmetic (8 frac bits) — eliminates f64 soft-float in zkVM
- **Multi-round proof**: replays both winning rounds (~468K cycles total with SHA-256 precompile)
- Chunked composition: 10 × 360-tick chunks + match composer via `env::verify()` (single-round)
- Raw byte I/O: `env::read_slice` / `env::commit_slice` (no serde)
- Journal: 76 bytes fixed layout (winner, round_wins, transcript_hash, seed_commit)
- Ranked: arena-only map, single seed across all rounds (seed_commit matches on-chain)

## Phase 4 — Soroban Contract + Game Hub ✅

- Chickenz contract: `start_match()`, `settle_match()` with Groth16 verification
- Cross-contract calls to Game Hub (`start_game`, `end_game`)
- `start_match()` called at match start (before gameplay), not after
- Groth16 verifier: Nethermind stellar-risc0-verifier (BN254 native pairing, Protocol 25)
- Deployed and initialized on Stellar Testnet

## Phase 5 — Frontend Integration ✅

- Stellar wallet connection via WalletKit (Freighter/Lobstr)
- Online lobby with matchmaking, room browser, leaderboard, match history
- Dynamic camera zoom, audio system, username display
- Replay viewer with playback controls
- Proof status tracking (pending → proving → verified → settled)
- Home/away character preferences with back-to-lobby from waiting rooms

## Phase 6 — Polish & Submit ✅

- [x] Clean up documentation (README, CLAUDE.md, ZK_SETTLEMENT.md)
- [x] Consolidate env files (.env.example)
- [x] Multi-round ZK proof (proves both winning rounds)
- [ ] Record 2-3 minute video demo
- [ ] Push to public GitHub repo
- [ ] Submit on DoraHacks

---

## Post-Hackathon Roadmap

- Player-signed input batches for non-repudiation
- Boundless proving marketplace integration
- Mainnet deployment
- Mobile-responsive UI
