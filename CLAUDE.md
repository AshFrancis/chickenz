# Chickenz

Competitive 2D multiplayer platformer shooter with ZK-provable game outcomes settled on Stellar Soroban. Two players compete in 60-second matches with 3 lives each. A sudden death mechanic closes the arena walls at 50s. The full input transcript feeds a ZK proof that verifies the result on-chain.

## Hackathon

**Stellar Hacks: ZK Gaming** on DoraHacks. Deadline: **2026-02-23**.

Submission requirements:
1. **ZK-Powered Mechanic** — ZK proof must power a core game mechanic (not just a demo)
2. **Deployed Onchain Component** — Soroban contract on Stellar Testnet, must call `start_game()` and `end_game()` on the Game Hub: `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG`
3. **Front End** — Functional UI showing gameplay + ZK + onchain connection
4. **Open-source Repo** — Public GitHub with clear README
5. **Video Demo** — 2-3 minute walkthrough

## Status

**Phase 1 complete.** Deterministic sim core (`packages/sim`) implemented with 29 passing tests. Phaser client runs local 2-player. Next: ZK prover + Soroban contract + Game Hub integration.

## Tech Stack

- **Sim core**: TypeScript, pure deterministic functions (`packages/sim`) — DONE
- **Client**: Phaser 2D renderer + local input (`apps/client`) — DONE
- **ZK Prover**: Noir circuits verified via Boundless on Stellar (`services/prover`)
- **Contracts**: Soroban smart contract, integrates with Stellar Game Hub (`contracts/chickenz`)

## Monorepo Layout

```
packages/sim/        Deterministic game state transition (pure logic, no I/O) ✅
apps/client/         Phaser renderer, input handling, local 2-player ✅
services/prover/     Noir circuit + Boundless proof orchestration
contracts/chickenz/  Soroban contract — game lifecycle + proof verification
```

## Critical Design Invariants

1. **Deterministic sim** — `nextState = step(prevState, inputs, prevInputs, config)`. Given identical inputs and seed, replay from tick 0 must produce identical final state. State hashes verified at configurable intervals.
2. **60 Hz fixed tick** — all state changes are per-tick; no variable time deltas. Matches are 3600 ticks (60s).
3. **3 lives + sudden death** — each player has 3 lives. At tick 3000 (50s), arena walls close inward. Player with more lives wins at time-up.
4. **Missing-input rule** — if no input at tick T, reuse input from T-1. This rule must be identical across client, server, and ZK verification.
5. **ZK-provable outcome** — the ZK proof verifies that running the deterministic sim with the given inputs + seed produces the claimed winner. This is the core mechanic.
6. **Game Hub integration** — every match calls `start_game()` at match start and `end_game()` with the verified winner on the Game Hub contract.

## Code Conventions (Sim Core)

Forbidden inside `packages/sim`:
- `Date.now()`, `performance.now()`, or any wall-clock time
- `Math.random()` — all randomness via deterministic PRNG seeded at match start
- Floating-point time deltas — use integer tick counts only
- External API calls, I/O, or side effects

The sim core must be a pure function: `(state, inputs, prevInputs, config) → state`. TypeScript strict mode required.

## ZK Architecture (Noir + Boundless)

**Framework**: Noir (Aztec's DSL for ZK circuits), proving via Boundless verifier network.

**What the proof verifies:**
1. Inputs match the committed transcript
2. Seed matches seed_commit
3. Deterministic sim replay produces the claimed final state
4. Winner derived correctly from final state

**Public inputs**: match_id, players, seed_commit, transcript_root, final_outcome
**Private witness**: full input transcript, seed, intermediate state hashes

**Integration flow:**
1. Match plays out in browser (client sim)
2. Input transcript is recorded
3. Noir circuit replays the sim and generates proof
4. Proof submitted to Soroban contract
5. Contract verifies proof, calls `end_game()` on Game Hub with winner

## Stellar Game Hub Integration

Game Hub contract (testnet): `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG`

Required calls:
- `start_game(game_id, player1, player2, points1, points2)` — at match start
- `end_game(game_id, winner)` — after ZK proof verifies outcome

## Documentation Index

| File | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Component layout, authority model, data flow |
| [DEV_ROADMAP.md](DEV_ROADMAP.md) | Hackathon sprint plan |
| [SIM_SPEC.md](SIM_SPEC.md) | GameState/PlayerState structures, transition function, determinism constraints |
| [ZK_SETTLEMENT.md](ZK_SETTLEMENT.md) | Noir circuit design, Boundless integration, settlement flow |
| [PROTOCOL.md](PROTOCOL.md) | Message types, missing-input rule |
| [TRANSCRIPT.md](TRANSCRIPT.md) | Commitment chain, transcript integrity |

## Development Phase Guidance

Phase 1 is complete. Focus now on hackathon deliverables:
1. Noir ZK circuit that replays sim and proves outcome
2. Soroban contract with Game Hub integration
3. Wire frontend: wallet connect → start game → play → prove → settle
4. README, deploy to testnet, record demo video
