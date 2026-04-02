# Development & Testing Guide

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | 18+ | Runtime (client build tooling) |
| pnpm | 9+ | Monorepo package manager |
| Bun | 1.0+ | Server runtime and test runner |
| Rust | stable | Prover core simulation (`services/prover/core/`) |
| wasm-pack | 0.12+ | Compile Rust sim to WASM (`services/prover/wasm/`) |
| Stellar CLI | latest | Contract interaction (optional, for on-chain features) |

## Local Setup

### 1. Clone and install dependencies

```bash
git clone <repo-url> && cd chickenz
pnpm install
```

### 2. Build WASM simulation

The Rust fixed-point simulation must be compiled to WASM before the server or client can run. This is required after any change to `services/prover/core/` or `services/prover/wasm/`.

```bash
pnpm build:wasm
```

This runs `wasm-pack build --target web` inside `services/prover/wasm/`.

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values. Required for basic local development:

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default 3000) |
| `STELLAR_ADMIN_SECRET` | For ranked/on-chain | Stellar secret key for match registration |
| `SOROBAN_RPC_URL` | For ranked/on-chain | Soroban RPC endpoint |
| `CHICKENZ_CONTRACT` | For ranked/on-chain | Deployed game contract address |
| `VITE_ACCOUNT_WASM_HASH` | For passkey wallets | Smart Account Kit WASM hash |
| `VITE_WEBAUTHN_VERIFIER` | For passkey wallets | WebAuthn verifier contract |
| `VITE_RELAYER_URL` | For passkey wallets | OZ Channels relayer URL |
| `WORKER_API_KEY` | For proof workers | API key for remote proof worker auth |
| `BOUNDLESS_RPC_URL` | For Boundless proving | Base mainnet RPC |
| `BOUNDLESS_PRIVATE_KEY` | For Boundless proving | Ethereum private key |
| `PINATA_JWT` | For IPFS pinning | Pinata API token |
| `RISC0_DEV_MODE` | For dev | Set to `1` for instant fake proofs |

For casual-only local development, only `PORT` is needed (or just use the default).

### 4. Start the server

```bash
bun services/server/src/index.ts
# or
pnpm start
```

For auto-reload during development:

```bash
pnpm dev:server
# runs: bun --watch src/index.ts
```

The server listens on port 3000 (HTTP + WebSocket). SQLite database is created automatically at `services/server/data/chickenz.db`.

### 5. Start the client dev server

```bash
pnpm dev:client
```

This starts Vite at `http://localhost:5173` with HMR. The client connects to the game server WebSocket.

## Project Structure

```
chickenz/
  packages/sim/        -- TS game types/constants (legacy sim, types still used for rendering)
  apps/client/         -- Phaser 2D client (Vite + TypeScript)
  services/server/     -- Bun game server (HTTP + WebSocket + SQLite)
  services/prover/
    core/              -- Rust fixed-point simulation (single source of truth)
    wasm/              -- wasm-bindgen wrapper over core
    guest/             -- RISC Zero zkVM guest program
    host/              -- Proof orchestration (local + Boundless)
  contracts/chickenz/  -- Soroban smart contract
```

## Running Tests

### All server tests (TypeScript)

```bash
bun test ./services/server/src/
```

### Sim package tests (TypeScript)

```bash
bun test ./packages/sim
```

### Rust core tests

```bash
cd services/prover/core && cargo test
```

### Soroban contract tests

```bash
cd contracts/chickenz && cargo test
```

### Single test file

```bash
bun test ./services/server/src/db.test.ts
```

## Test Coverage Summary

### Server Tests (`services/server/src/`)

| File | Tests | Covers |
|---|---|---|
| `db.test.ts` | 56 | Match CRUD, proof status, ELO calculations, transcripts, bot pruning, casual ELO, migrations |
| `GameRoom.test.ts` | 98 | Room lifecycle, player join/leave, game loop, input handling, bot behavior, countdown, scoring |
| `protocol.test.ts` | 44 | Input parsing, button masking, aim clamping, tournament config validation, join codes |
| `prover.test.ts` | 42 | Proof queue, job claiming, result submission, worker heartbeat, deduplication |
| `TournamentRoom.test.ts` | 71 | Bracket generation, seeding, tournament lifecycle, match progression, elimination |
| **Total** | **311** | |

### Sim Tests (`packages/sim/__tests__/`)

| File | Tests | Covers |
|---|---|---|
| `step.test.ts` | 31 | Game step logic, state transitions |
| `physics.test.ts` | 24 | Collision, gravity, movement |
| `replay.test.ts` | 3 | Replay determinism |
| `prng.test.ts` | 6 | Mulberry32 PRNG correctness |
| **Total** | **64** | |

### Rust Tests (`services/prover/core/src/`)

| File | Tests | Covers |
|---|---|---|
| `fp.rs` | 13 | Fixed-point i32 arithmetic |
| `step.rs` | 9 | Simulation step logic |
| `weapons.rs` | 7 | Weapon pickup, ammo, firing |
| `physics.rs` | 6 | Collision detection, gravity |
| `prng.rs` | 5 | Mulberry32 PRNG |
| `projectiles.rs` | 4 | Projectile movement, hit detection |
| `hash.rs` | 3 | SHA-256 hashing |
| `init.rs` | 2 | State initialization |
| **Total** | **49** | |

### Contract Tests (`contracts/chickenz/src/test.rs`)

| Tests | Covers |
|---|---|
| 20 | Match registration, settlement, proof verification, admin functions |

## Available Scripts

| Script | Command | Description |
|---|---|---|
| `pnpm dev:client` | `vite` (in `apps/client/`) | Start client dev server with HMR |
| `pnpm dev:server` | `bun --watch src/index.ts` | Start server with auto-reload |
| `pnpm start` | `bun services/server/src/index.ts` | Start server (no auto-reload) |
| `pnpm build` | Build WASM + client | Full production build |
| `pnpm build:wasm` | `wasm-pack build --target web` | Compile Rust sim to WASM |
| `pnpm test` | `bun test packages/sim` | Run sim tests |
| `pnpm typecheck` | `tsc` across all packages | Type-check entire project |
| `pnpm lint` | `eslint` | Lint TypeScript sources |
| `pnpm lint:fix` | `eslint --fix` | Lint and auto-fix |
| `pnpm format` | `prettier --write` | Format all TypeScript and JSON |
| `pnpm format:check` | `prettier --check` | Check formatting without writing |

## Deployment

Deployment targets three production servers (US, EU, Asia). See `CLAUDE.md` for full infrastructure details.

### Using deploy script (Linux/modern bash only)

```bash
# Deploy server to all regions
./scripts/deploy.sh server

# Deploy to specific region
./scripts/deploy.sh server eu
```

Requires `declare -A` (bash 4+). Always commit and push before deploying.

### Manual deployment (macOS)

macOS ships bash 3.2 which does not support `declare -A`. Deploy manually:

```bash
# Build client
cd apps/client && npx vite build && cd ../..

# Copy to each server
scp -r apps/client/dist/* root@178.156.244.26:/root/chickenz/services/server/public/   # US
scp -r apps/client/dist/* root@89.167.92.60:/root/chickenz/services/server/public/      # EU
scp -r apps/client/dist/* root@5.223.61.107:/root/chickenz/services/server/public/      # Asia
```

Static file changes do not require a server restart. For server code changes, SSH in and restart the Bun process.

## Code Style

- **TypeScript**: Strict mode, Bun test runner, ESLint + Prettier
- **Rust**: Fixed-point i32 with 8 fractional bits (256 = 1.0), `step_mut(&mut State)` for zero-copy mutation
- **Test runner**: Bun (`bun:test`) for all TypeScript tests
- **WASM is the source of truth**: The Rust sim in `services/prover/core/` is compiled to WASM for client and server, and to RISC-V for the ZK prover. The TS sim in `packages/sim/` is legacy (types and constants still used, but `step()` is not called).
