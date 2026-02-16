# SIM_SPEC.md

# Deterministic Simulation Requirements

The simulation must be:

- Pure logic
- Fixed timestep (60Hz)
- Deterministic
- Replayable from transcript

---

# Game Rules

- **2 players**, each with **3 lives**
- **60 second match** (3600 ticks at 60Hz)
- Players shoot each other — taking enough damage costs a life
- On death: respawn with invincibility frames, decrement lives
- **Sudden death**: at a configurable tick (e.g. tick 3000 / 50s), arena walls close inward from both sides, killing any player they touch
- **Win condition**:
  - If a player loses all 3 lives → other player wins immediately
  - If time runs out → player with more lives wins
  - If tied on lives → player with more health wins
  - If still tied → draw (or coin flip via PRNG)

---

# State Structure

GameState:
- tick
- players[]
- projectiles[]
- rng_state
- lives (per player)
- arenaLeft, arenaRight (current arena bounds for sudden death)
- matchOver, winner

PlayerState:
- id
- position (x, y)
- velocity (vx, vy)
- facing
- health
- shootCooldown
- grounded
- stateFlags (Alive, Invincible)
- respawnTimer

---

# Transition Function

nextState = step(prevState, inputs, prevInputs, config)

Inputs:
Map<PlayerID, PlayerInput>

PlayerInput:
- buttons bitmask (Left, Right, Jump, Shoot)
- aimX, aimY

Sub-step order:
1. Check match over — if true, return state unchanged
2. Resolve inputs (missing-input rule: reuse T-1 if absent)
3. Tick cooldowns and invincibility
4. Apply player input (movement/jump/facing)
5. Apply gravity
6. Move + collide with platforms
7. Process shooting (spawn projectiles)
8. Move projectiles, remove expired/OOB
9. Projectile-player collision (damage)
10. Deaths → decrement lives, check for win by elimination
11. Respawn dead players (if lives remain)
12. Sudden death: advance arena walls, kill players outside bounds
13. Check time-up win condition
14. Advance tick

---

# Sudden Death

- Starts at configurable tick (default: tick 3000 = 50s mark)
- Arena walls close inward at a constant rate from both sides
- Any player touching the wall is killed (loses a life)
- Creates urgency and guarantees match resolution

---

# Determinism Constraints

Forbidden inside sim:
- Date.now()
- Math.random()
- floating time deltas
- external APIs

All randomness:
- Deterministic PRNG seeded at match start

---

# Replay Guarantee

Given:
- match params (seed, map, config)
- full input transcript (3600 ticks × 2 players)

Replaying from tick 0 must produce identical final state.

State hash should match at configurable intervals.

---

# ZK Provability Notes

- 3600 ticks is the max circuit size target
- All math must be reproducible in Noir (integer/fixed-point)
- Bounded loops (fixed tick count)
- Fixed array sizes (2 players, bounded projectile count)
