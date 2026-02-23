# Chickenz

## Workflow Rules

- **Deploy script** (`scripts/deploy.sh`): Always commit and push before deploying. Run directly with Bash (timeout 60000). Do NOT use `run_in_background`. Do NOT use TaskOutput to poll. Just call Bash directly and wait for the result inline. The script takes ~30-50 seconds.
- **Short-lived commands** (~under 2 min): Always run inline with Bash, never as background tasks. Background tasks add minutes of polling overhead.

---

Competitive 2D multiplayer platformer shooter with ZK-provable game outcomes settled on Stellar Soroban. Two players compete in best-of-3 rounds (30 seconds each, 1 life per round). Five weapons spawn on the map. A sudden death mechanic closes the arena walls at 20s. The full input transcript feeds a RISC Zero ZK proof that verifies the result on-chain.

## Status

All phases complete. Deterministic sim (64 TS tests), Rust prover (52 tests), Soroban contracts deployed, multiplayer server with lobby/ELO/replays/bots/tournaments, Phaser client with prediction + wallet connect.

## Tech Stack

- **Sim core**: Rust fixed-point i32 compiled to WASM (single source of truth). Legacy TS types in `packages/sim`
- **Client**: Phaser 2D renderer, lobby UI, wallet connect (`apps/client`)
- **Server**: Bun WebSocket, server-authoritative netcode, bot opponents (`services/server`)
- **ZK Prover**: RISC Zero zkVM, Groth16 compression, multi-round proofs (`services/prover`)
- **Contracts**: Soroban smart contract + Nethermind Groth16 verifier (`contracts/chickenz`)

## Monorepo Layout

```
packages/sim/           Deterministic game logic (pure TS, no I/O, 64 tests)
apps/client/            Phaser renderer, lobby UI, wallet connect
services/server/        Bun WebSocket server — matchmaking, rooms, ELO, bots
services/prover/
  core/                 Rust fixed-point sim (i32, 52 tests, single source of truth)
  wasm/                 WASM build of core (used by client + server)
  guest/                RISC Zero guest — multi-round proof (2 winning rounds)
  host/                 Orchestration (monolithic + Boundless)
contracts/chickenz/     Soroban game contract (deployed on testnet)
```

## Critical Design Invariants

1. **Deterministic sim** — `nextState = step(prevState, inputs, prevInputs, config)`. Given identical inputs and seed, replay from tick 0 must produce identical final state.
2. **60 Hz fixed tick** — all state changes are per-tick; no variable time deltas. Rounds are 1800 ticks (30s).
3. **1 life per round + sudden death** — each player has 1 life per round, best of 3. At tick 1200 (20s), arena walls close inward. Player with more health wins at time-up.
4. **Missing-input rule** — if no input at tick T, reuse input from T-1. This rule must be identical across client, server, and ZK verification.
5. **Multi-round ZK proof** — the ZK proof replays both winning rounds (same seed), verifies the same player won both, and commits combined transcript hashes + seed_commit. This is the core mechanic.
6. **Game Hub integration** — every match calls `start_game()` at match start and `end_game()` with the verified winner on the Game Hub contract.
7. **Death linger** — 30-tick (0.5s) delay before `matchOver` after final kill, so both players see the death.

## Code Conventions (Sim Core)

Forbidden inside `packages/sim`:
- `Date.now()`, `performance.now()`, or any wall-clock time
- `Math.random()` — all randomness via deterministic PRNG seeded at match start
- Floating-point time deltas — use integer tick counts only
- External API calls, I/O, or side effects

The sim core must be a pure function: `(state, inputs, prevInputs, config) → state`. TypeScript strict mode required.

## ZK Architecture (RISC Zero + Groth16)

**Framework**: RISC Zero zkVM with Groth16 compression via Boundless/Bonsai.

**What the proof verifies (multi-round):**
1. Both winning rounds replayed with the same committed seed (SHA-256)
2. Input transcripts match combined transcript_hash (SHA-256 chain of per-round hashes)
3. Deterministic sim replay produces correct final state per round
4. Same player won both rounds → confirmed as match winner

**Multi-round encoding**: `[round_count: 4 LE] [seed: 4 LE] per round: [tick_count: 4 LE] [ticks × 6 bytes]`

**Journal layout**: 76 bytes — winner(i32) + round_wins([u32;2]) + transcript_hash([u8;32]) + seed_commit([u8;32])

**Integration flow:**
1. Match plays out online (server-authoritative, best-of-3 rounds)
2. Server records per-round input transcripts
3. RISC Zero guest replays both winning rounds in zkVM, generates Groth16 proof
4. Proof submitted to Soroban contract
5. Contract verifies proof via Nethermind Groth16 verifier (BN254 pairing)
6. Contract calls `end_game()` on Game Hub with verified winner

## Stellar Game Hub Integration

Game Hub contract (testnet): `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG`

Required calls:
- `start_game(game_id, session_id, player1, player2, player1_points, player2_points)` — at match start
- `end_game(session_id, player1_won)` — after ZK proof verifies outcome

## Documentation Index

| File | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Component layout, authority model, data flow |
| [DEV_ROADMAP.md](DEV_ROADMAP.md) | Development roadmap and progress |
| [SIM_SPEC.md](SIM_SPEC.md) | GameState/PlayerState structures, transition function, determinism |
| [ZK_SETTLEMENT.md](ZK_SETTLEMENT.md) | RISC Zero pipeline, journal layout, settlement flow |
| [MULTIPLAYER.md](MULTIPLAYER.md) | Netcode, prediction, room lifecycle |
| [PROTOCOL.md](PROTOCOL.md) | WebSocket message types, missing-input rule |
| [TRANSCRIPT.md](TRANSCRIPT.md) | Commitment chain, transcript integrity |
