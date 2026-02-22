# Multiplayer Architecture

## Implementation Status: Fully Implemented

The server-authoritative multiplayer system is live with the following features:

- Server-authoritative sim at 60Hz
- Client-side prediction with rollback reconciliation
- Online lobby with quick play, named rooms, private rooms
- Join codes (5-letter, excludes I/O for readability)
- ELO ranking system, leaderboard, match history
- Replay viewer (fetch transcript, step through at variable speed)
- Username system with profanity filter (leet-speak normalization)

---

## Client → Server

```json
{
  "type": "input",
  "buttons": 5,
  "aimX": 0.707,
  "aimY": -0.707
}
```

Rules:
- Client sends input on change (not every tick) — server uses missing-input rule for gaps
- Missing input → server reuses previous tick's input (deterministic rule)
- `buttons` is a bitmask: Left=1, Right=2, Jump=4, Shoot=8, Taunt=16

---

## Server → Client

State broadcast at 60Hz (every tick):

```json
{
  "type": "state",
  "tick": 142,
  "lastButtons": [5, 0],
  "players": [...],
  "projectiles": [...],
  "weaponPickups": [...],
  "scores": [2, 1],
  "arenaLeft": 0,
  "arenaRight": 800,
  "matchOver": false,
  "winner": -1,
  "deathLingerTimer": 0,
  "rngState": 1831565813,
  "nextProjectileId": 7
}
```

---

## Client Prediction

The client uses a `PredictionManager` that:
1. Stores an `InputBuffer` of recent local inputs (ring buffer)
2. Runs local WASM sim `step()` ahead of server state for responsive feel
3. On receiving server state: compares predicted vs actual
4. On mismatch: rolls back to server state, replays buffered inputs

Both client and server use the same Rust sim compiled to WASM (single source of truth).

---

## Netcode Philosophy: "Favor the Victim"

The server resolves all hits on its current authoritative state — it never rewinds to check if a shot "should have hit" on the attacker's screen. This means:

- A player can **never** be hit by a bullet they already dodged on their screen
- The attacker may **miss** shots that looked like hits on their screen (due to latency)
- This is a deliberate design choice: defensive play is rewarded, and high-latency players have a disadvantage on offense but not defense

---

## Room Lifecycle

```
create/quickplay → waiting (1/2) → matched (2/2) → playing → ended
                                                              ↓
                                                    players return to lobby
                                                    transcript persisted to DB
```

- In-memory rooms cleaned up 2 minutes after match ends
- Transcripts persisted to SQLite DB (survive room cleanup and server restarts)
- Available via `GET /transcript/{roomId}` — tries in-memory first, falls back to DB
- Match history stored in SQLite with ELO rankings, proof status, wallet verification
- Bot matches: auto-join casual quickplay after 20s if no human joins
