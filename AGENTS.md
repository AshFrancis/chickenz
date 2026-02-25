# Chickenz

Competitive 2D multiplayer platformer shooter with ZK-provable game outcomes settled on Stellar Soroban. Two players compete in best-of-3 rounds (30 seconds each, 1 life per round). Five weapons spawn on the map. A sudden death mechanic closes the arena walls at 20s. The full input transcript feeds a RISC Zero ZK proof that verifies the result on-chain.

## Tech Stack

- **Sim core**: Rust fixed-point i32 compiled to WASM (single source of truth). Legacy TS types in `packages/sim`
- **Client**: Phaser 2D renderer, lobby UI, mobile touch controls, tutorial, Stellar wallet connect (`apps/client`)
- **Server**: Bun WebSocket, server-authoritative netcode, bot opponents, adaptive difficulty (`services/server`)
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
bun test packages/sim       # 64 TS sim tests
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
| `RPC_URL` | Boundless only | Ethereum RPC (e.g. Base mainnet) |
| `BOUNDLESS_RPC_URL` | Boundless only | RPC for log polling (needs large block range support) |
| `PRIVATE_KEY` | Boundless only | Ethereum wallet for Boundless market |
| `PINATA_JWT` | Boundless only | IPFS upload for proof inputs |

## Sim Update Checklist

**Every time the sim is updated** (`services/prover/core/src/` — physics, types, constants, weapons, etc.), ALL of the following must be rebuilt/updated:

1. **WASM** (client + server): `pnpm build:wasm`
2. **Prover worker**: rebuild `chickenz-host` on the x86 Linux machine running the worker
3. **Get canonical image ID**: `chickenz-host --image-id` (must use x86 Linux build — see ARM note below)
4. **Update contract**: `stellar contract invoke --id <CONTRACT> --source default --rpc-url https://soroban-testnet.stellar.org --network-passphrase "Test SDF Network ; September 2015" -- set_image_id --image_id <NEW_ID>`
5. **Update client display** (optional): `GUEST_IMAGE_ID` in `apps/client/src/main.ts`
6. **Deploy to production servers**: `./scripts/deploy.sh server`

**IMPORTANT — ARM vs x86 image ID mismatch**: `risc0-build` produces different guest ELFs on ARM (Mac) vs x86 (Linux), resulting in different image IDs even with identical source and toolchain versions. The x86 Linux image ID is canonical — all production servers are x86 Linux and will produce matching IDs. Never use a Mac-built image ID for the contract.

## Critical Design Invariants

1. **Deterministic sim** — `nextState = step(prevState, inputs, prevInputs, config)`. Given identical inputs and seed, replay from tick 0 must produce identical final state.
2. **60 Hz fixed tick** — all state changes are per-tick; no variable time deltas. Rounds are 1800 ticks (30s).
3. **1 life per round + sudden death** — each player has 1 life per round, best of 3. At tick 1200 (20s), arena walls close inward. Player with more health wins at time-up.
4. **Missing-input rule** — if no input at tick T, reuse input from T-1. This rule must be identical across client, server, and ZK verification.
5. **Multi-round ZK proof** — the ZK proof replays both winning rounds (same seed), verifies the same player won both, and commits combined transcript hashes + seed_commit. This is the core mechanic.
6. **Game Hub integration** — every ranked match calls `start_game()` at match start and `end_game()` with the verified winner on the Game Hub contract.
7. **Death linger** — 30-tick (0.5s) delay before `matchOver` after final kill, so both players see the death.
8. **Ranked mode** — requires passkey wallet verification. No bots in ranked. Wallet disconnect leaves room.
9. **Bot indistinguishability** — bots use realistic names (gamer tags + animal names), appear as normal players in lobby and match history. No `[BOT]` prefix exposed to clients.
10. **Audio separation** — SFX always on by default; music (BGM) off by default, toggled independently via music icon or settings checkbox.

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

- `start_game()` at match start, `end_game()` after ZK proof verifies outcome
- Wallet: passkey-based smart accounts via OpenZeppelin Smart Account Kit
- Wallet verification: server verifies credential ID → contract address derivation + optional P-256 signature

## Bot System

- **BotLobbyManager** (`services/server/src/BotLobbyManager.ts`): maintains 3-5 fake "waiting" rooms in the lobby. When a human joins one, a real GameRoom is created with a bot opponent. Fake rooms churn with 45-120s TTLs.
- **Auto-join**: human-created casual rooms get a bot after 5s if no human joins (`watchHumanRoom()`/`cancelWatch()`).
- **Bot names**: 40% gamer names (e.g. `Sc00m`, `Krypt0`), 60% animal names (e.g. `Fox4821`). Tracked in a `Set` to avoid duplicates, released when bot match ends.
- **Continuous difficulty**: 0.0–1.0 scale interpolated between easy/medium/hard anchors. Default 0.3 (from casual ELO 800). Maps `difficulty = clamp((elo - 500) / 1000, 0, 1)`.
- **Adaptive rounds**: mercy round (one of first 2 rounds, difficulty reduced 0.2-0.35), score-based adjustment (bot leading → reduce, trailing → increase). AFK detection disables mercy.
- **Bot taunts**: 50% chance per round win, sets `Button.Taunt` during death linger.

## Casual ELO

Hidden matchmaking rating for casual/bot matches. Stored in `casual_elo` table (SQLite). Default 800, K-factor 24. Updated after bot matches only (ranked uses visible ELO). Drives bot difficulty for next match.

## Mobile Controls

- **Touch detection**: `"ontouchstart" in window || navigator.maxTouchPoints > 0` → adds `body.touch` class
- **Virtual joystick** (`apps/client/src/input/TouchControls.ts`): fixed circle bottom-left, drag direction maps to movement/jump/taunt. Spin gesture triggers rapid L/R for stomp escape.
- **Shoot button**: fixed circle bottom-right, visual press feedback
- **Jump pulsing**: jump held for ~47 frames then released for 3 — creates rising edges so sim re-triggers jump on each landing
- **Integration**: `InputManager.setTouchState()` — touch buttons OR'd with keyboard buttons each frame

## Tutorial

- **First-time detection**: `localStorage.getItem("chickenz-tutorial-done")`
- **8 steps**: movement → jump → double jump → weapon pickup → shoot → stomp escape → kill → done
- **Completion tracking**: per-step conditions (movement ticks, jump detected, double jump, weapon pickup, shot fired, stomp escape, P2 killed, auto-advance timer)
- **Integration**: `tutorial.tick()` called each WASM tick from GameScene, returns P2 input + optional state modifier

## Audio System

- **SFX**: always on by default, volume controlled by `chickenz-sfx-volume` (0-100)
- **Music (BGM)**: off by default, toggled independently via `chickenz-music-muted`
- **Migration**: old `chickenz-muted` key migrated on first load via `chickenz-audio-migrated` flag
- **Top bar icon**: musical note, click toggles music only (not SFX)

## Shareable Links

- `?join=CODE` → auto-fill join code and trigger join (with cross-region lookup)
- `?replay=roomId&region=us` → auto-load and play replay from specified region
- Share buttons in warmup screen (copies join link) and match history (copies replay link)
- Static OG meta tags in `index.html` for social media previews

## Multi-Region Servers

- Three regions: US, EU, Asia — each runs an independent Bun server
- Client `RegionManager` measures pings to all regions, opens lobby WS to each reachable one, merges room lists
- Home region persisted in localStorage, defaults to lowest ping
- Ping threshold: 160ms (high-ping regions shown dimmed but still selectable)
- Static files served by Bun from `services/server/public/` (not `apps/client/dist/`)
- Each server needs `SERVER_REGION` and `CANONICAL_HOST` env vars set

## Additional Docs

| File | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Component layout, authority model, data flow |
| [SIM_SPEC.md](SIM_SPEC.md) | GameState/PlayerState structures, transition function |
| [ZK_SETTLEMENT.md](ZK_SETTLEMENT.md) | RISC Zero pipeline, journal layout, settlement flow |
| [MULTIPLAYER.md](MULTIPLAYER.md) | Netcode, prediction, room lifecycle |
| [PROTOCOL.md](PROTOCOL.md) | WebSocket message types, missing-input rule |
