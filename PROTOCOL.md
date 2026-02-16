# PROTOCOL.md

# Transport

- WebSocket (initial phase)
- 60Hz input send
- 20–30Hz snapshot send

---

# Message Types

## Input
tick: number
seq: number
buttons: number
aimX: number
aimY: number

## Snapshot
serverTick: number
ackSeq: number
stateDelta: object

## SignedInputBatch
t0: number
t1: number
batch_hash: bytes32
signature: bytes

Signature covers:
H(match_id || t0 || t1 || batch_hash || prev_commitment)

---

# Missing Input Rule

If no input at tick T:
input[T] = input[T-1]

This rule must be identical across:
- client prediction
- server sim
- ZK replay
