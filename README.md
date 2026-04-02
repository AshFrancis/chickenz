# Chickenz

Competitive 2D platformer shooter with ZK-provable game outcomes settled on Stellar Soroban.

Two players compete in best-of-3 rounds (30 seconds each, 1 life per round). Five weapons spawn on the map (Shotgun, Rocket, Sniper, SMG, Pistol default). A sudden death mechanic closes the arena walls at 20s. The ZK proof replays **both winning rounds** inside RISC Zero's zkVM and cryptographically verifies the match result on-chain — no trusted server needed.

## Quick Start (Local Development)

### Prerequisites

- [Bun](https://bun.sh) v1.0+ (runtime for server + tests)
- [pnpm](https://pnpm.io) v9+ (package manager)
- [Rust](https://rustup.rs) (stable toolchain)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/) (for building the WASM sim)

> **Optional** (only needed for ZK proving and on-chain settlement):
> - [RISC Zero toolchain](https://dev.risczero.com/api/zkvm/install) (`rzup install`)
> - [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli)

### 1. Install dependencies

```bash
git clone https://github.com/AshFrancis/chickenz && cd chickenz
pnpm install
```

### 2. Build the WASM sim

The game sim runs as a WASM module (compiled from Rust). Build it once:

```bash
pnpm build:wasm
```

The server loads WASM directly from `services/prover/wasm/pkg/` — no copy needed.

### 3. Run the game

Open two terminals:

```bash
# Terminal 1: Start the game server (localhost:3000)
pnpm dev:server

# Terminal 2: Start the client dev server (localhost:5173)
pnpm dev:client
```

Open `http://localhost:5173` in two browser tabs to play against yourself. Click "Play vs Bot" to add a bot opponent to casual games.

### 4. Run tests

```bash
# TypeScript sim tests (64 tests)
bun test packages/sim

# Rust core tests (49 tests)
cd services/prover && cargo test -p chickenz-core

# Server tests (311 tests)
bun test services/server

# Soroban contract tests (20 tests)
cd contracts/chickenz && cargo test
```

## How It Works

```
1. Connect wallet, set username, join a ranked match
2. Play best-of-3 rounds online (server-authoritative, 60Hz)
3. Input transcript recorded every tick by the server
4. RISC Zero prover replays both winning rounds in zkVM → Groth16 proof
5. settle_match() verifies proof on-chain → Game Hub end_game(winner)
```

The ZK proof verifies that:
- Both winning rounds were replayed correctly from the same committed seed
- The input transcripts were not tampered with (SHA-256 commitment chain)
- The same player won both rounds, confirming them as the match winner

## Architecture

```
packages/sim/           Deterministic game logic (TypeScript, 64 tests)
apps/client/            Phaser 2D renderer, lobby UI, wallet connect
services/server/        Bun WebSocket server — matchmaking, rooms, ELO, transcripts (311 tests)
services/prover/
  core/                 Rust fixed-point sim (i32, 49 tests, single source of truth)
  wasm/                 WASM build of core (used by client + server)
  guest/                RISC Zero guest — multi-round proof (replays 2 winning rounds)
  host/                 Orchestration (monolithic + Boundless modes)
contracts/chickenz/     Soroban game contract + Groth16 verification (deployed, 20 tests)
```

### ZK Proving Pipeline

The game sim runs at 60Hz for 30 seconds per round (1800 ticks). A best-of-3 match proves the 2 rounds won by the match winner (2-0 or 2-1). To make proving tractable:

1. **Fixed-point arithmetic** — i32 with 8 fractional bits (256 = 1.0) eliminates f64 soft-float in the zkVM
2. **Zero-copy mutation** — `step_mut(&mut State)` avoids copying the game state every tick
3. **Raw byte I/O** — `env::read_slice` / `env::commit_slice` bypasses serde (97% faster deserialization)
4. **Multi-round encoding** — `[round_count][seed][round1_ticks...][round2_ticks...]` — both rounds share one seed

| Optimization | Cycles/round | Reduction |
|---|---|---|
| Original (f64) | 52.4M | — |
| Fixed-point | 11.5M | 4.6x |
| In-place mutation | 8.5M | 1.4x |
| Raw byte I/O | 5.2M | 1.6x |
| SHA-256 precompile | **234K** | **22x** |
| **Total** | **234K** | **224x** |

### On-Chain Contracts (Stellar Testnet)

| Contract | Address |
|---|---|
| Chickenz Game | `CBRDPRKUK3NH2HXOWSNZPG2ZSXXXZBR7GCMN7WLHWINMLNDCJ7NSREKG` |
| Groth16 Verifier | `CDUDXCLMNE7Q4BZJLLB3KACFOS55SS55GSQW2UYHDUXTJKZUDDAJYCIH` |
| Game Hub | `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG` |

The game contract calls `start_game()` and `end_game()` on the Stellar Game Hub. Settlement verifies the Groth16 proof via the Nethermind RISC Zero verifier using Soroban's native BN254 pairing (Protocol 25).

## Environment Variables

Copy the example env file and fill in your keys:

```bash
cp .env.example .env
```

| Variable | Required For | Description |
|---|---|---|
| `PORT` | Server | Server port (default: `3000`) |
| `BOUNDLESS_RPC_URL` | Boundless proving | Ethereum Sepolia RPC for Boundless marketplace |
| `BOUNDLESS_PRIVATE_KEY` | Boundless proving | Ethereum Sepolia wallet private key (0x-prefixed) |
| `PINATA_JWT` | Boundless proving | Pinata JWT for IPFS uploads (ELF + input storage) |
| `STELLAR_ADMIN_SECRET` | On-chain settlement | Stellar secret key for `start_match` / `settle_match` |
| `SOROBAN_RPC_URL` | On-chain settlement | Soroban RPC endpoint (default: testnet) |
| `WORKER_API_KEY` | Proof worker | API key for authenticating remote proof workers |

> **Note**: For local development, no environment variables are needed. The game runs fully without ZK proving or blockchain integration. Env vars are only required for ranked match proving and on-chain settlement.

## Building the ZK Prover

```bash
# Build the prover host binary (requires RISC Zero toolchain)
cd services/prover && cargo build --release -p chickenz-host

# Generate a proof in dev mode (fake proof for testing, instant)
RISC0_DEV_MODE=1 ./scripts/prove.sh transcript.json --local

# Generate a real Groth16 proof via Boundless
./scripts/prove.sh transcript.json
```

## Deploy Contracts

```bash
# Build the game contract WASM
cd contracts/chickenz && stellar contract build

# Deploy to testnet
stellar contract deploy \
  --wasm target/wasm32v1-none/release/chickenz_contract.wasm \
  --source default --network testnet

# Initialize with verifier and Game Hub
stellar contract invoke --id <CONTRACT_ID> --source default --network testnet \
  -- initialize \
  --admin <ADMIN_ADDR> \
  --game_hub CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG \
  --verifier <VERIFIER_ID> \
  --image_id <IMAGE_ID_HEX>
```

## Deploy Server

```bash
# Build client for production
pnpm build

# Deploy to server (builds client, uploads, restarts)
./scripts/deploy.sh
```

## Gameplay

- **Movement**: WASD or Arrow keys
- **Shoot**: Space or Left Shift
- **Aim**: Mouse cursor
- Best of 3 rounds, 1 life per round, 100 HP
- 5 weapons: Pistol (default), Shotgun, Rocket, Sniper, SMG
- Sudden death at 20s: arena walls close inward
- Round winner: last player standing, or most health at time-up

### Online Features

- Quick Play matchmaking (casual or ranked) with bot backfill
- Named rooms with 5-letter join codes and private room support
- Home/away character preferences
- ELO ranking and leaderboard
- Match history with full replay viewer
- Tournament mode with brackets
- Proof status tracking (pending → proving → verified → settled)

## Match Settlement Flow

1. **Connect** Freighter/Lobstr wallet in the browser
2. **Match Start** — server registers match on Game Hub via `start_match(seed_commit)`
3. **Play** — best-of-3 rounds online, server records per-round transcripts
4. **Prove** — RISC Zero prover replays both winning rounds in zkVM → Groth16 proof
5. **Settle** — `settle_match(seal, journal)` verifies proof on-chain
6. **Verified** — Game Hub receives `end_game(winner)` with cryptographic proof

## Tech Stack

- **Game**: TypeScript, Phaser 3, Rust WASM (single source of truth)
- **Server**: Bun, WebSocket, server-authoritative netcode
- **ZK**: RISC Zero zkVM, Groth16 compression, multi-round proof composition
- **Blockchain**: Stellar Soroban (Testnet), Freighter wallet, Game Hub integration
- **Verifier**: Nethermind stellar-risc0-verifier (BN254 native pairing)

## ZK Proof Statement

The Groth16 proof cryptographically guarantees:

1. **Fair randomness** — all rounds used the same seed, matching the `seed_commit` on-chain (SHA-256)
2. **Transcript integrity** — per-round input hashes match `transcript_hash` (SHA-256 chain)
3. **Correct replay** — the deterministic Rust sim (fixed-point i32, identical to WASM and RISC-V) replays both winning rounds from the committed seed and inputs, producing the claimed outcome
4. **Consistent winner** — the same player won both proven rounds

The 76-byte journal committed to the zkVM contains: `winner(i32) + round_wins([u32;2]) + transcript_hash([u8;32]) + seed_commit([u8;32])`. The on-chain verifier checks `verify(seal, image_id, sha256(journal))`.

## Known Limitations

- **Admin-gated settlement**: Only the server admin can call `start_match()` / `settle_match()` on-chain. Player-initiated settlement is planned.
- **Server-controlled seed**: The match seed is generated server-side and committed via SHA-256. A commit-reveal scheme for trustless seed generation is future work.
- **Fixed map for ranked**: The ZK prover uses a hardcoded arena map. Ranked matches are restricted to this map; casual matches rotate freely.
- **Transcript hash not stored on-chain**: The `transcript_hash` is embedded in the ZK proof journal and verified by the Groth16 proof (via `image_id` pinning), but the contract does not store it separately. Off-chain auditors can verify transcripts by recomputing the hash against the journal value.

## Documentation

| File | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Component layout, authority model, data flow |
| [SIM_SPEC.md](SIM_SPEC.md) | Game state, transition function, determinism constraints |
| [ZK_SETTLEMENT.md](ZK_SETTLEMENT.md) | Multi-round proof pipeline, journal layout, settlement flow |
| [MULTIPLAYER.md](MULTIPLAYER.md) | Netcode, prediction, room lifecycle |
| [PROTOCOL.md](PROTOCOL.md) | WebSocket message types, missing-input rule |
| [TRANSCRIPT.md](TRANSCRIPT.md) | Commitment chain, transcript integrity |
| [DEV_ROADMAP.md](DEV_ROADMAP.md) | Development roadmap and progress |

## License

MIT
