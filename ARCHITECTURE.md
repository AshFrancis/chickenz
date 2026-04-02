# Architecture

Chickenz is a competitive 2D multiplayer platform shooter with ZK-provable outcomes settled on Stellar Soroban.

Core loop: play match online → server records transcript → generate RISC Zero ZK proof → settle on-chain via Game Hub.

---

## Components

```
packages/sim/           Deterministic game logic (pure TS, no I/O, 64 tests)
apps/client/            Phaser renderer, lobby UI, mobile touch controls, tutorial, wallet connect
  src/input/            InputManager (keyboard + touch), TouchControls (virtual joystick/shoot)
  src/tutorial/         Tutorial system (6-step guided overlay on warmup)
  src/net/              NetworkManager, RegionManager (multi-region ping + lobby merge)
services/server/        Bun WebSocket server — matchmaking, rooms, ELO, bots, on-chain settlement (311 tests)
  src/BotAI.ts          Bot AI with continuous difficulty interpolation (0.0–1.0)
  src/BotLobbyManager   Fake waiting rooms + auto-join system
  src/GameRoom.ts       Game rooms with adaptive bot difficulty + mercy rounds
services/prover/
  core/                 Rust sim (fixed-point i32, single source of truth, 49 tests)
  wasm/                 WASM crate — wasm-bindgen wrapper (used by client + server)
  guest/                RISC Zero guest (multi-round, ~234K cycles/round)
  host/                 Orchestration (monolithic + Boundless modes)
contracts/chickenz/     Soroban game contract + Groth16 verification (deployed, 20 tests)
```

---

## Data Flow

```
Browser                          Server                    Blockchain
  │                                │                          │
  ├─ Connect wallet ──────────────→│                          │
  ├─ Set username ────────────────→│                          │
  ├─ Quick Play / Create Room ────→│                          │
  │                                ├─ Match players           │
  │                                ├─ start_match() ────────→ │ Game Hub
  │←── matched(playerId, seed) ────┤                          │
  │                                │                          │
  │  ┌─ 30-second round (bo3) ──┐  │                          │
  │  │ Client sends inputs ────→│  │                          │
  │  │ Server runs WASM sim 60Hz│  │                          │
  │  │ Server broadcasts state  │  │                          │
  │  │ Client predicts + renders│  │                          │
  │  └──────────────────────────┘  │                          │
  │                                │                          │
  │←── ended(winner, scores) ──────┤                          │
  │                                ├─ Store transcript        │
  │                                ├─ Generate ZK proof ────┐ │
  │                                │  (worker or Boundless) │ │
  │                                ├─ settle_match(seal) ──→│ │ 
  │                                │                        └→│ Verifier → Game Hub
  │←── Settlement confirmed ───────┤                          │
```

---

## Authority Model

**Online multiplayer (current):**
- Server runs authoritative sim at 60Hz
- Clients send inputs, receive state snapshots
- Client-side prediction with rollback reconciliation
- Server records full input transcript for ZK proving
- "Favor the victim" netcode: hits resolved on server's current state, never rewound

**ZK settlement:**
- Transcript feeds RISC Zero prover (identical Rust sim in zkVM)
- Groth16 proof submitted to Soroban contract
- Contract verifies proof, calls Game Hub `end_game(winner)`
- No trust required in the server — proof is cryptographic

---

## Timeline Model

- Fixed tick rate: 60Hz (16.67ms per tick)
- All state changes occur per tick — no variable time deltas
- Inputs are bound to tick numbers
- Missing inputs reuse previous tick's input (deterministic rule)
- Rounds last 1800 ticks (30 seconds), best of 3 rounds per match

---

## On-Chain Architecture

```
┌─────────────┐     start_game()     ┌──────────────┐
│  Chickenz    │ ──────────────────→  │  Game Hub     │
│  Contract    │                      │  (Testnet)    │
│              │     end_game()       │               │
│              │ ──────────────────→  │               │
└──────┬───────┘                      └───────────────┘
       │
       │  verify(seal, image_id, journal_digest)
       ▼
┌──────────────┐
│  Groth16     │
│  Verifier    │  Nethermind stellar-risc0-verifier
│  (BN254)     │  Protocol 25 native pairing
└──────────────┘
```

---

## ZK Integration

**RISC Zero zkVM** replays the deterministic sim inside a zero-knowledge virtual machine. The guest program executes the identical Rust game logic (fixed-point i32 arithmetic) and commits the match result as a 76-byte journal.

**Groth16 compression** converts the RISC Zero STARK proof into a 256-byte Groth16 proof verifiable on Soroban via BN254 pairing (Protocol 25).

**Boundless** is an optional proving marketplace — submit the transcript, receive a Groth16 proof back without running local hardware.

See [ZK_SETTLEMENT.md](ZK_SETTLEMENT.md) for the full settlement flow and journal layout.

---

## Bot System

The bot system makes the game feel alive by ensuring players always find opponents:

```
BotLobbyManager
  ├─ Maintains 3-5 fake "waiting" rooms in lobby
  ├─ Fake rooms churn with 45-120s TTLs (close + reopen)
  ├─ When human joins fake room → create real GameRoom + add bot
  └─ Watch human-created rooms → add bot after 5s if no human joins

BotAI
  ├─ Continuous difficulty: 0.0 (easy) → 0.5 (medium) → 1.0 (hard)
  ├─ Parameters interpolated: dodgeChance, shootChance, decisionInterval, etc.
  ├─ Platform navigation state machine (approach → jump → land)
  └─ Taunts opponent 50% of rounds won

GameRoom (adaptive difficulty)
  ├─ Mercy round: one of first 2 rounds, difficulty reduced 0.2-0.35
  ├─ Score-based: bot leading → reduce difficulty, trailing → increase
  └─ AFK detection: <5 input changes in 60 ticks → disable mercy
```

Bot difficulty is driven by hidden **casual ELO** (default 800, K=24). Mapping: `difficulty = clamp((elo - 500) / 1000, 0, 1)`.

---

## Audio Architecture

SFX and music are independently controlled:

- **SFX** (sound effects): always on by default, volume via `chickenz-sfx-volume`
- **Music** (BGM): off by default, toggled via `chickenz-music-muted`
- Top bar shows a musical note icon — toggles music only
- `GameScene.setMusicMuted()` controls BGM; `playSound()`/`playSoundInterrupt()` always play SFX

---

## Mobile Support

Touch devices get virtual controls:

- **Detection**: `"ontouchstart" in window` → `body.touch` class
- **Joystick**: canvas-based, bottom-left, follow-thumb pattern, maps to movement + jump + taunt
- **Shoot button**: fixed bottom-right, touch feedback
- **Integration**: `requestAnimationFrame` loop feeds `InputManager.setTouchState()` — touch buttons OR'd with keyboard

---

## Tutorial

First-time players see a 6-step guided tutorial during warmup:

1. Movement (A/D or joystick) — complete after 30 ticks of movement
2. Jump (W or joystick up) — complete on first jump
3. Weapon pickup — complete on pickup
4. Shoot (SPACE or red button) — complete on first shot
5. Sudden death info — auto-advance 3s
6. Goal info — auto-advance 3s

Tracked via `localStorage("chickenz-tutorial-done")`. Skip button available at every step.

---

## Multi-Region Architecture

Three regional servers (US, EU, Asia) operate independently:

- Client `RegionManager` pings all regions, opens parallel lobby WebSocket connections
- Room lists from all regions merged and displayed with region flags
- Home region auto-selected by lowest ping, persisted in localStorage
- Game connections go to a single region at a time
- Wallet verification tokens stored per-region
