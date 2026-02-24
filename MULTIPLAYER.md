# Multiplayer Architecture

## Implementation Status: Fully Implemented

The server-authoritative multiplayer system is live with the following features:

- Server-authoritative sim at 60Hz
- Client-side prediction with rollback reconciliation
- Online lobby with quick play, named rooms, private rooms
- Join codes (5-letter, excludes I/O for readability)
- ELO ranking system (ranked) + hidden casual ELO (bot matchmaking)
- Replay viewer (fetch transcript, step through at variable speed)
- Username system with profanity filter (leet-speak normalization)
- Multi-region servers (US, EU, Asia) with cross-region lobby
- Bot opponents with adaptive difficulty and lobby presence
- Mobile touch controls (virtual joystick + shoot button)
- Tutorial system for first-time players
- Shareable links (`?join=CODE`, `?replay=roomId&region=us`)

---

## Client → Server

```json
{
  "type": "input",
  "buttons": 5,
  "aimX": 1,
  "aimY": -1
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

---

## Bot System

Bots are designed to be indistinguishable from human players:

**Lobby Presence** (`BotLobbyManager`):
- Maintains 3-5 fake "waiting" rooms with realistic names
- Fake rooms churn with 45-120s TTLs — lobby always has rooms to join
- When a human joins a fake room, a real GameRoom+bot is created
- Human-created casual rooms get auto-bot after 5s with no human opponent

**Bot Names**:
- 40% gamer names (e.g. `CorkIe`, `Sc00m`, `Krypt0`), 60% animal names (e.g. `Fox4821`)
- Names tracked in Set to avoid duplicates, released when match ends
- No `[BOT]` prefix — bots appear identical to human players in lobby and match history

**Adaptive Difficulty**:
- Continuous 0.0–1.0 scale interpolated between easy/medium/hard anchors
- Default 0.3 (from casual ELO 800). Mapping: `difficulty = clamp((elo - 500) / 1000, 0, 1)`
- Mercy round: one of the first 2 rounds has difficulty reduced by 0.2-0.35
- Score-based adjustment: bot leading → reduce difficulty, player leading → full strength
- AFK detection: < 5 input changes in 60 ticks → disable mercy mode

**Hidden Casual ELO**:
- Separate `casual_elo` table (default 800, K-factor 24)
- Updated after bot matches only (ranked uses visible ELO)
- Drives bot difficulty for the player's next match

---

## Multi-Region Architecture

Three servers (US, EU, Asia) operate independently:

```
Client RegionManager
  ├─ Ping all regions on load (WebSocket handshake timing)
  ├─ Auto-select lowest-ping region as "home"
  ├─ Open parallel lobby WS to each reachable region
  ├─ Merge room lists with region flags
  └─ Game connection targets a single region at a time
```

- Regional subdomains: `us.chickenz.io`, `eu.chickenz.io`, `asia.chickenz.io`
- Ping threshold: 160ms — high-ping regions shown dimmed but selectable
- Home region persisted in `localStorage("chickenz-home-region")`
- Wallet verification tokens stored per-region

---

## Mobile Touch Controls

Touch devices (detected via `"ontouchstart" in window`) get virtual controls:

- **Joystick** (bottom-left): canvas-based, follow-thumb pattern, 60px radius, 15% dead zone
  - Horizontal: Left/Right movement
  - Vertical up: Jump, vertical down: Taunt
- **Shoot button** (bottom-right): 80px fixed position, visual press feedback
- **Integration**: `requestAnimationFrame` loop feeds `InputManager.setTouchState()`, touch buttons OR'd with keyboard
- Controls hidden during lobby/menus, shown only during active gameplay
