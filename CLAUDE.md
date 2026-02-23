# Chickenz

Competitive 2D multiplayer platformer shooter with ZK-provable game outcomes settled on Stellar Soroban. Two players compete in best-of-3 rounds (30 seconds each, 1 life per round). Five weapons spawn on the map. A sudden death mechanic closes the arena walls at 20s. The full input transcript feeds a RISC Zero ZK proof that verifies the result on-chain.

## Tech Stack

- **Sim core**: Rust fixed-point i32 compiled to WASM (single source of truth). Legacy TS types in `packages/sim`
- **Client**: Phaser 2D renderer, lobby UI, Stellar wallet connect (`apps/client`)
- **Server**: Bun WebSocket, server-authoritative netcode, bot opponents (`services/server`)
- **ZK Prover**: RISC Zero zkVM, Groth16 compression, multi-round proofs (`services/prover`)
- **Contracts**: Soroban smart contract + Nethermind Groth16 verifier (`contracts/chickenz`)
- **Package management**: pnpm (workspaces, dependency resolution) + Bun (runtime, test runner)

## Monorepo Layout

```
packages/sim/           Deterministic game logic (pure TS, no I/O, 64 tests)
apps/client/            Phaser renderer, lobby UI, wallet connect
services/server/        Bun WebSocket server — matchmaking, rooms, ELO, bots
services/prover/
  core/                 Rust fixed-point sim (i32, 50 tests, single source of truth)
  wasm/                 WASM build of core (used by client + server)
  guest/                RISC Zero guest — multi-round proof (2 winning rounds)
  host/                 Orchestration (monolithic + Boundless)
contracts/chickenz/     Soroban game contract (deployed on testnet)
scripts/                deploy.sh, prove.sh, start-match.sh
```

## Development

```sh
# Install dependencies
pnpm install

# Run client (Vite dev server)
pnpm dev:client

# Run server (Bun, requires .env)
pnpm dev:server            # or: bun services/server/src/index.ts

# Build WASM (requires wasm-pack + Rust)
pnpm build:wasm

# Tests
bun test packages/sim      # 64 TS sim tests
cargo test -p chickenz-core # 50 Rust prover tests

# Lint & format
pnpm lint                  # ESLint (errors on any, unused vars, floating promises)
pnpm lint:fix
pnpm format                # Prettier
pnpm format:check

# Deploy (commit + push first)
./scripts/deploy.sh        # Full: client build + server restart
./scripts/deploy.sh client # Client only
./scripts/deploy.sh server # Server only

# ZK proof generation
./scripts/prove.sh <transcript.json> --local      # Local STARK
./scripts/prove.sh <transcript.json>              # Local Groth16
./scripts/prove.sh <transcript.json> --boundless  # Boundless marketplace
```

### Environment Variables (`.env`)

Server requires these in `.env` at the project root (see `.env.example`):

| Variable | Required | Purpose |
|---|---|---|
| `STELLAR_ADMIN_SECRET` | For ranked | Stellar admin key for start_game/end_game txns |
| `WORKER_API_KEY` | For proofs | Auth key for proof worker → server API |
| `RPC_URL` | Boundless only | Ethereum RPC (e.g. Base Sepolia) |
| `PRIVATE_KEY` | Boundless only | Ethereum wallet for Boundless market |
| `PINATA_JWT` | Boundless only | IPFS upload for proof inputs |

## Workflow Rules

- **Deploy script** (`scripts/deploy.sh`): Always commit and push before deploying. Run directly with Bash (timeout 60000). Do NOT use `run_in_background`. Do NOT use TaskOutput to poll. Just call Bash directly and wait for the result inline. The script takes ~30-50 seconds.
- **Short-lived commands** (~under 2 min): Always run inline with Bash, never as background tasks. Background tasks add minutes of polling overhead.

## Critical Design Invariants

1. **Deterministic sim** — `nextState = step(prevState, inputs, prevInputs, config)`. Given identical inputs and seed, replay from tick 0 must produce identical final state.
2. **60 Hz fixed tick** — all state changes are per-tick; no variable time deltas. Rounds are 1800 ticks (30s).
3. **1 life per round + sudden death** — each player has 1 life per round, best of 3. At tick 1200 (20s), arena walls close inward. Player with more health wins at time-up.
4. **Missing-input rule** — if no input at tick T, reuse input from T-1. This rule must be identical across client, server, and ZK verification.
5. **Multi-round ZK proof** — the ZK proof replays both winning rounds (same seed), verifies the same player won both, and commits combined transcript hashes + seed_commit. This is the core mechanic.
6. **Game Hub integration** — every ranked match calls `start_game()` at match start and `end_game()` with the verified winner on the Game Hub contract.
7. **Death linger** — 30-tick (0.5s) delay before `matchOver` after final kill, so both players see the death.
8. **Ranked mode** — requires Freighter wallet verification (Stellar Signed Message prefix + SHA-256). No bots in ranked. Wallet disconnect leaves room.

## Code Conventions

**Sim core** (`packages/sim/` and `services/prover/core/`):
- No wall-clock time, no `Math.random()`, no floating-point deltas, no I/O
- Pure function: `(state, inputs, prevInputs, config) → state`
- Rust uses fixed-point i32 with 8 fractional bits (256 = 1.0)
- WASM exports use `-1` for null values (weapon, stompedBy, stompingOn)

**TypeScript**:
- Strict mode, ESLint with `no-explicit-any: error`
- Prettier formatting (120 char width, double quotes, trailing commas)
- `packages/sim` types/constants are used for rendering but `step()` is never called (WASM is source of truth)

**Rust**:
- `cargo clippy` clean, `cargo fmt` enforced
- Guest uses raw byte I/O (`env::read_slice`/`commit_slice`) — no serde overhead

## ZK Architecture

See [ZK_SETTLEMENT.md](ZK_SETTLEMENT.md) for full details.

- **Monolithic guest**: replays both winning rounds in a single zkVM execution (~468K cycles)
- **Groth16 compression**: via Boundless marketplace or local RISC Zero toolchain
- **On-chain verification**: Nethermind Groth16 verifier on Soroban (BN254 pairing)
- **Journal**: 76 bytes — winner + scores + transcript_hash + seed_commit
- **Multi-round encoding**: `[round_count: 4 LE] [seed: 4 LE] per round: [tick_count: 4 LE] [ticks × 6 bytes]`

## Stellar Integration

See contract source in `contracts/chickenz/src/lib.rs`.

- **Game Hub** (testnet): `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG`
- `start_game()` at match start, `end_game()` after ZK proof verifies outcome
- Wallet verification: Freighter `signMessage()` → server verifies with `"Stellar Signed Message:\n"` prefix + SHA-256

## Additional Docs

| File | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Component layout, authority model, data flow |
| [SIM_SPEC.md](SIM_SPEC.md) | GameState/PlayerState structures, transition function |
| [ZK_SETTLEMENT.md](ZK_SETTLEMENT.md) | RISC Zero pipeline, journal layout, settlement flow |
| [MULTIPLAYER.md](MULTIPLAYER.md) | Netcode, prediction, room lifecycle |
| [PROTOCOL.md](PROTOCOL.md) | WebSocket message types, missing-input rule |
