# Protocol

## Transport

- WebSocket (Bun server, port 3000)
- Input sent on change (client → server), server reuses last input for gaps
- 60Hz state broadcast (server → client, every tick)

---

## Message Types

### Client → Server

**Input** (sent on change during gameplay)
```
type: "input"
tick: number        // optional: target tick for precise alignment
buttons: number     // bitmask: Left=1, Right=2, Jump=4, Shoot=8, Taunt=16
aimX: number        // -1, 0, or 1 (aim direction horizontal)
aimY: number        // -1, 0, or 1 (aim direction vertical)
```

**Lobby Actions**
```
type: "set_username" | "quickplay" | "create" | "join_room" | "join_code" | "leave" | "set_wallet" | "list_rooms" | "add_bot"
type: "create_tournament" | "join_tournament_code"
```

### Server → Client

**State** (sent every tick during gameplay)
```
type: "state"
tick: number
lastButtons: [number, number]   // last applied buttons per player
players: SerializedPlayer[]     // 2 players (fp → f64 from WASM export)
projectiles: SerializedProjectile[]
weaponPickups: SerializedWeaponPickup[]
scores: [number, number]
arenaLeft: number               // sudden death zone left edge
arenaRight: number              // sudden death zone right edge
matchOver: boolean
winner: number                  // -1 if no winner yet
deathLingerTimer: number
rngState: number
nextProjectileId: number
```

**Match Lifecycle**
```
type: "waiting"       // room created, waiting for opponent (includes joinCode)
type: "matched"       // match found, includes playerId, seed, mapIndex, mode, characters
type: "round_start"   // new round beginning, includes seed, mapIndex, round number
type: "round_end"     // round finished, includes winner and roundWins
type: "ended"         // match over, includes winner, scores, roundWins, mode
type: "lobby"         // lobby state update (rooms list)
type: "error"         // error message (string)
```

**Tournament Messages**
```
type: "tournament_lobby"       // tournament waiting room state
type: "tournament_match_start" // tournament match beginning (fighter or spectator role)
type: "tournament_match_end"   // tournament match result + updated bracket
type: "tournament_end"         // tournament over, final standings
type: "spectate_state"         // spectator state broadcast (same fields as "state")
type: "spectate_round_end"     // spectator round end notification
type: "spectate_round_start"   // spectator new round notification
```

---

## Missing Input Rule

If no input at tick T:
```
input[T] = input[T-1]
```

This rule must be identical across:
- client prediction
- server sim
- ZK replay
