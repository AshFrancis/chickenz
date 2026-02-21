# Chickenz

## Workflow Rules

- **Deploy script** (`scripts/deploy.sh`): Always commit and push before deploying. Run directly with Bash (timeout 60000). Do NOT use `run_in_background`. Do NOT use TaskOutput to poll. Just call Bash directly and wait for the result inline. The script takes ~30-50 seconds.
- **Short-lived commands** (~under 2 min): Always run inline with Bash, never as background tasks. Background tasks add minutes of polling overhead.

---

Competitive 2D multiplayer platformer shooter with ZK-provable game outcomes settled on Stellar Soroban. Two players compete in 60-second matches with 3 lives each. Five weapons spawn on the map. A sudden death mechanic closes the arena walls at 50s. The full input transcript feeds a RISC Zero ZK proof that verifies the result on-chain.

## Hackathon

**Stellar Hacks: ZK Gaming** on DoraHacks. Deadline: **2026-02-23**.

Submission requirements:
1. **ZK-Powered Mechanic** — ZK proof must power a core game mechanic (not just a demo)
2. **Deployed Onchain Component** — Soroban contract on Stellar Testnet, must call `start_game()` and `end_game()` on the Game Hub: `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG`
3. **Front End** — Functional UI showing gameplay + ZK + onchain connection
4. **Open-source Repo** — Public GitHub with clear README
5. **Video Demo** — 2-3 minute walkthrough

## Status

All phases complete. Deterministic sim (54 TS tests), Rust prover (47 tests), Soroban contracts deployed, multiplayer server with lobby/ELO/replays, Phaser client with prediction + wallet connect.

## Tech Stack

- **Sim core**: TypeScript, pure deterministic functions (`packages/sim`)
- **Client**: Phaser 2D renderer, lobby UI, wallet connect (`apps/client`)
- **Server**: Bun WebSocket, server-authoritative netcode (`services/server`)
- **ZK Prover**: RISC Zero zkVM, Groth16 compression (`services/prover`)
- **Contracts**: Soroban smart contract + Nethermind Groth16 verifier (`contracts/chickenz`)

## Monorepo Layout

```
packages/sim/           Deterministic game logic (pure TS, no I/O, 54 tests)
apps/client/            Phaser renderer, lobby UI, wallet connect
services/server/        Bun WebSocket server — matchmaking, rooms, ELO
services/prover/
  core/                 Rust port of sim (f64 + fixed-point i32, 47 tests)
  guest/                RISC Zero monolithic guest
  chunk-guest/          Chunk prover guest
  match-guest/          Match composer guest
  host/                 Orchestration (monolithic + chunked + Boundless)
contracts/chickenz/     Soroban game contract (deployed on testnet)
```

## Critical Design Invariants

1. **Deterministic sim** — `nextState = step(prevState, inputs, prevInputs, config)`. Given identical inputs and seed, replay from tick 0 must produce identical final state.
2. **60 Hz fixed tick** — all state changes are per-tick; no variable time deltas. Matches are 3600 ticks (60s).
3. **3 lives + sudden death** — each player has 3 lives. At tick 3000 (50s), arena walls close inward. Player with more lives wins at time-up.
4. **Missing-input rule** — if no input at tick T, reuse input from T-1. This rule must be identical across client, server, and ZK verification.
5. **ZK-provable outcome** — the ZK proof verifies that running the deterministic sim with the given inputs + seed produces the claimed winner. This is the core mechanic.
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

**What the proof verifies:**
1. Inputs match the committed transcript (SHA-256)
2. Seed matches seed_commit (SHA-256)
3. Deterministic sim replay produces the claimed final state
4. Winner derived correctly from final state

**Journal layout**: 76 bytes — winner(i32) + scores([u32;2]) + transcript_hash([u8;32]) + seed_commit([u8;32])

**Integration flow:**
1. Match plays out online (server-authoritative)
2. Server records input transcript
3. RISC Zero guest replays sim in zkVM, generates Groth16 proof
4. Proof submitted to Soroban contract
5. Contract verifies proof via Nethermind Groth16 verifier (BN254 pairing)
6. Contract calls `end_game()` on Game Hub with verified winner

## Stellar Game Hub Integration

Game Hub contract (testnet): `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG`

Required calls:
- `start_game(game_id, player1, player2, points1, points2)` — at match start
- `end_game(game_id, winner)` — after ZK proof verifies outcome

## Documentation Index

| File | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Component layout, authority model, data flow |
| [DEV_ROADMAP.md](DEV_ROADMAP.md) | Hackathon sprint plan and progress |
| [SIM_SPEC.md](SIM_SPEC.md) | GameState/PlayerState structures, transition function, determinism |
| [ZK_SETTLEMENT.md](ZK_SETTLEMENT.md) | RISC Zero pipeline, journal layout, settlement flow |
| [MULTIPLAYER.md](MULTIPLAYER.md) | Netcode, prediction, room lifecycle |
| [PROTOCOL.md](PROTOCOL.md) | WebSocket message types, missing-input rule |
| [TRANSCRIPT.md](TRANSCRIPT.md) | Commitment chain, transcript integrity |
