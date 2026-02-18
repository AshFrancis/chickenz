# Chickenz

Competitive 2D platformer shooter with ZK-provable game outcomes settled on Stellar Soroban.

Two players compete in 60-second matches with 3 lives each. Five weapons spawn on the map (Shotgun, Rocket, Sniper, SMG, Pistol default). A sudden death mechanic closes the arena walls at 50s. The full input transcript feeds a RISC Zero ZK proof that cryptographically verifies the match result on-chain — no trusted server needed.

Built for [Stellar Hacks: ZK Gaming](https://dorahacks.io/hackathon/stellar-hacks-zk-gaming) hackathon.

## How It Works

```
1. Connect wallet, set username, join a room
2. Play 60-second match online (server-authoritative, 60Hz)
3. Input transcript recorded every tick by the server
4. RISC Zero prover replays sim in zkVM, generates Groth16 proof
5. settle_match() verifies proof on-chain → Game Hub end_game(winner)
```

The ZK proof verifies that:
- The deterministic sim was replayed correctly from the committed seed
- The input transcript was not tampered with (SHA-256 commitment)
- The claimed winner matches the sim's final state

## Architecture

```
packages/sim/           Deterministic game logic (TypeScript, 54 tests)
apps/client/            Phaser 2D renderer, lobby UI, wallet connect
services/server/        Bun WebSocket server — matchmaking, rooms, ELO, transcripts
services/prover/
  core/                 Rust port of sim (f64 + fixed-point i32, 47 tests)
  guest/                RISC Zero monolithic guest (5.2M cycles)
  chunk-guest/          Chunk prover (360 ticks per chunk)
  match-guest/          Match composer (verifies chunk chain)
  host/                 Orchestration (monolithic + chunked + Boundless modes)
contracts/chickenz/     Soroban game contract + Groth16 verification (deployed)
```

### ZK Proving Pipeline

The game sim runs at 60Hz for 60 seconds (3600 ticks). To make proving tractable:

1. **Fixed-point arithmetic** — i32 with 8 fractional bits (256 = 1.0) eliminates f64 soft-float in the zkVM
2. **Zero-copy mutation** — `step_mut(&mut State)` avoids copying the game state every tick
3. **Raw byte I/O** — `env::read_slice` / `env::commit_slice` bypasses serde (97% faster deserialization)
4. **Chunked composition** — 10 chunks of 360 ticks proved independently, composed via `env::verify()` (zero execution cycles)

| Optimization | Cycles | Reduction |
|---|---|---|
| Original (f64) | 52.4M | — |
| Fixed-point | 11.5M | 4.6x |
| In-place mutation | 8.5M | 1.4x |
| Raw byte I/O | 5.2M | 1.6x |
| **Total** | **5.2M** | **10x** |

### On-Chain Contracts (Testnet)

| Contract | Address |
|---|---|
| Chickenz Game | `CDYU5GFNDBIFYWLW54QV3LPDNQTER6ID3SK4QCCBVUY7NU76ESBP7LZP` |
| Groth16 Verifier | `CDUDXCLMNE7Q4BZJLLB3KACFOS55SS55GSQW2UYHDUXTJKZUDDAJYCIH` |
| Game Hub | `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG` |

The game contract calls `start_game()` and `end_game()` on the Stellar Game Hub. Settlement verifies the Groth16 proof via the Nethermind RISC Zero verifier using Soroban's native BN254 pairing (Protocol 25).

## Setup

### Prerequisites

- [Bun](https://bun.sh) (runtime for server + tests)
- [pnpm](https://pnpm.io) (package manager)
- [Rust](https://rustup.rs) (stable + nightly)
- [RISC Zero toolchain](https://dev.risczero.com/api/zkvm/install) (`rzup install`)
- [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli) (`cargo install stellar-cli`)

### Install & Run

```bash
# Install dependencies
pnpm install

# Run the game client (localhost:5173)
pnpm dev:client

# Run the game server (localhost:3000)
pnpm dev:server

# Run TypeScript sim tests (54 tests)
bun test packages/sim

# Run Rust prover tests (47 tests)
cd services/prover && cargo test -p chickenz-core
```

### Build & Deploy

```bash
# Build the ZK prover
cd services/prover && cargo build --release -p chickenz-host

# Generate a proof (dev mode — fake proof for testing)
RISC0_DEV_MODE=1 ./target/release/chickenz-host transcript.json --chunked --local

# Generate a real STARK proof (slow, needs ~16GB RAM)
./target/release/chickenz-host transcript.json --chunked --local

# Generate Groth16 proof via Bonsai (requires API key)
BONSAI_API_KEY=<key> BONSAI_API_URL=<url> ./target/release/chickenz-host transcript.json --chunked
```

### Deploy Contracts

```bash
# Build the game contract
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

### Deploy Server (Fly.io)

```bash
# Build client for production
pnpm --filter @chickenz/client build

# Deploy to Fly.io
fly deploy
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `RISC0_DEV_MODE` | No | Set to `1` for fake proofs during development |
| `BONSAI_API_KEY` | For Boundless | API key for the Bonsai proving service |
| `BONSAI_API_URL` | For Boundless | URL for the Bonsai proving service |
| `PORT` | No | Server port (default: 3000) |

## Gameplay

- **P1**: WASD to move, Space to shoot, mouse to aim
- **P2**: Arrow keys to move, Shift to shoot, mouse to aim
- 3 lives per player, 100 HP, weapon damage varies by type
- 5 weapons: Pistol (default), Shotgun, Rocket, Sniper, SMG
- Sudden death at 50s: arena walls close inward
- Winner: last player standing, or most lives/health at time-up

### Online Features

- Quick Play matchmaking or named rooms with optional passwords
- 5-letter join codes for private rooms
- ELO ranking and leaderboard
- Match history with replay viewer
- Proof status tracking (pending → proving → verified → settled)

## Match Settlement Flow

1. **Connect** Freighter/Lobstr wallet in the browser
2. **New Match** — registers on the Game Hub via `start_match()`
3. **Play** — 60-second online match, server records transcript
4. **Prove** — run the RISC Zero prover on the transcript
5. **Settle** — upload proof artifacts, calls `settle_match()` on-chain
6. **Verified** — Game Hub receives `end_game(winner)` with cryptographic proof

## Tech Stack

- **Game**: TypeScript, Phaser 3, deterministic fixed-timestep sim
- **Server**: Bun, WebSocket, server-authoritative netcode
- **ZK**: RISC Zero zkVM, Groth16 compression, chunked proof composition
- **Blockchain**: Stellar Soroban (Testnet), Freighter wallet, Game Hub integration
- **Verifier**: Nethermind stellar-risc0-verifier (BN254 native pairing)

## Documentation

| File | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Component layout, authority model, data flow |
| [SIM_SPEC.md](SIM_SPEC.md) | GameState/PlayerState structures, transition function, determinism |
| [ZK_SETTLEMENT.md](ZK_SETTLEMENT.md) | RISC Zero pipeline, journal layout, settlement flow |
| [MULTIPLAYER.md](MULTIPLAYER.md) | Netcode, prediction, room lifecycle |
| [PROTOCOL.md](PROTOCOL.md) | WebSocket message types, missing-input rule |
| [TRANSCRIPT.md](TRANSCRIPT.md) | Commitment chain, transcript integrity |
| [DEV_ROADMAP.md](DEV_ROADMAP.md) | Hackathon sprint plan and progress |

## License

MIT
