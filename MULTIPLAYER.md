# Multiplayer Architecture

## Implementation Status: Fully Implemented

The server-authoritative multiplayer system is live with the following features:

- Server-authoritative sim at 60Hz
- Client-side prediction with rollback reconciliation
- Online lobby with quick play, named rooms, private rooms, password protection
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
- One input per tick per player
- Missing input → server reuses previous tick's input (deterministic rule)
- `buttons` is a bitmask: Left=1, Right=2, Jump=4, Shoot=8

---

## Server → Client

State broadcast at 60Hz (every tick):

```json
{
  "type": "state",
  "tick": 142,
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
2. Runs local sim `step()` ahead of server state for responsive feel
3. On receiving server state: compares predicted vs actual
4. On mismatch: rolls back to server state, replays buffered inputs

This gives instant-feeling controls while maintaining server authority.

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
                                                    transcript stored (5 min TTL)
```

- Rooms are cleaned up 5 minutes after match ends
- Transcripts available via `GET /transcript/{roomId}` for ZK proving
- Match history stored in memory (last 50 matches)
