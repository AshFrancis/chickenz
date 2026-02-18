# Architecture

Chickenz is a competitive 2D multiplayer platform shooter with ZK-provable outcomes settled on Stellar Soroban.

Core loop: play match online → server records transcript → generate RISC Zero ZK proof → settle on-chain via Game Hub.

---

## Components

```
packages/sim/           Deterministic game logic (pure TS, no I/O, 54 tests)
apps/client/            Phaser renderer, lobby UI, wallet connect, settlement
services/server/        Bun WebSocket server — matchmaking, rooms, ELO, transcripts
services/prover/
  core/                 Rust port of sim (f64 + fixed-point i32, 47 tests)
  guest/                RISC Zero monolithic guest (3600 ticks, 5.2M cycles)
  chunk-guest/          Chunk prover guest (360 ticks per chunk)
  match-guest/          Match composer guest (verifies chunk proof chain)
  host/                 Orchestration (monolithic + chunked + Boundless modes)
contracts/chickenz/     Soroban game contract + Groth16 verification (deployed)
```

---

## Data Flow

```
Browser                          Server                    Blockchain
  │                                │                          │
  ├─ Connect wallet ──────────────→│                          │
  ├─ Set username ────────────────→│                          │
  ├─ Quick Play / Create Room ───→│                          │
  │                                ├─ Match players           │
  │←── matched(playerId, seed) ───┤                          │
  │                                │                          │
  │  ┌─ 60-second match ────────┐ │                          │
  │  │ Client sends inputs ────→│ │                          │
  │  │ Server runs sim at 60Hz  │ │                          │
  │  │ Server broadcasts state  │ │                          │
  │  │ Client predicts + renders│ │                          │
  │  └─────────────────────────┘ │                          │
  │                                │                          │
  │←── ended(winner, scores) ─────┤                          │
  │                                ├─ Store transcript        │
  │                                │                          │
  ├─ start_match() ───────────────────────────────────────→  │ Game Hub
  │                                │                          │
  ├─ Generate ZK proof (prover host) ─────────────────────┐  │
  │                                │                       │  │
  ├─ settle_match(seal, journal) ─────────────────────────→│  │ Verifier
  │                                │                       └→ │ Game Hub
  │←── Settlement confirmed ──────────────────────────────── │
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
- Matches last 3600 ticks (60 seconds)

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
