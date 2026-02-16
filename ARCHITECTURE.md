# ARCHITECTURE.md

# System Overview

Chickenz is a competitive 2D multiplayer platform shooter with ZK-provable outcomes settled on Stellar Soroban.

Core loop: play game → record transcript → generate ZK proof → settle on-chain via Game Hub.

---

# Components

```
packages/sim/        Deterministic game state transition (pure TS, no I/O) ✅
apps/client/         Phaser renderer + local input + wallet + settlement UI ✅ (gameplay)
services/prover/     Noir circuit + Boundless proof orchestration
contracts/chickenz/  Soroban contract — match lifecycle + proof verification
```

---

# Data Flow (Hackathon MVP)

1. **Connect**: Player connects Stellar wallet
2. **Start**: Client calls Chickenz contract → `start_match()` → Game Hub `start_game()`
3. **Play**: Local 2-player match in browser, deterministic sim at 60Hz
4. **Record**: Client captures full input transcript (per-tick inputs for both players)
5. **Prove**: Input transcript + seed fed to Noir circuit → ZK proof of correct outcome
6. **Settle**: Proof submitted to Chickenz contract → verifies → Game Hub `end_game(winner)`

---

# Authority Model

**Hackathon (local 2-player):**
- Client runs sim, both players on same machine
- Transcript is the canonical record
- ZK proof makes the outcome trustless

**Future (networked):**
- Server authoritative, clients predict
- Players sign input batches
- Server or any party can generate proof from transcript

---

# Timeline Model

- Fixed tick: 60Hz
- All state changes occur per tick
- Inputs are bound to tick numbers
- Missing inputs = reuse last input (deterministic rule)

---

# On-Chain Architecture

```
┌─────────────┐     start_game()     ┌──────────────┐
│  Chickenz    │ ──────────────────→  │  Game Hub     │
│  Contract    │                      │  (Testnet)    │
│              │     end_game()       │               │
│              │ ──────────────────→  │               │
└──────┬───────┘                      └───────────────┘
       │
       │  verify proof
       │  store match state
       │
   Soroban (Stellar Testnet)
```

---

# ZK Integration

**Noir** circuit replays the deterministic sim and proves the outcome is correct.
**Boundless** network handles proof generation and on-chain verification on Stellar.

See [ZK_SETTLEMENT.md](ZK_SETTLEMENT.md) for circuit design and settlement flow.
