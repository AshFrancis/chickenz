# MULTIPLAYER.md

# Model

- Server authoritative
- Client-side prediction
- Reconciliation rollback
- Remote interpolation
- Server rewind for hit validation

---

# Client → Server

Input:
{
match_id,
player_id,
tick,
seq,
buttons,
aimX,
aimY
}

Rules:
- seq must increase monotonically
- tick must be within allowed window
- one authoritative input per tick

---

# Server → Client

Snapshot:
{
serverTick,
ackSeq,
players[],
projectiles[],
events[]
}

Snapshots sent at 20–30Hz.

---

# Client Prediction

Client stores:
- inputHistory[tick]
- stateHistory[tick]

On snapshot:
1. Compare predicted state at tick T
2. If mismatch > threshold:
    - rollback to T
    - apply server state
    - replay inputs

Render smoothing applies unless error large.

---

# Server Rewind

Server maintains:
- ring buffer of world states (250–500ms)

On hit event:
1. Identify shot tick
2. Rewind to tick
3. Perform hit test
4. Apply result in present

Max rewind window capped (e.g., 200ms).
