# Sim Spec — Deterministic Simulation

The simulation must be pure, deterministic, and replayable from a transcript. It runs identically in three environments: TypeScript (client/server), Rust f64 (reference), and Rust fixed-point i32 (zkVM guest).

---

## Game Rules

- **2 players**, 1 life per round, 100 HP, best of 3 rounds
- **30-second rounds** (1800 ticks at 60Hz)
- **5 weapons**: Pistol, Shotgun, Rocket, Sniper, SMG — picked up from map spawns
- Players deal damage via projectiles
- **Sudden death** at tick 1200 (20s): arena walls close inward
- **Death linger**: 30-tick (0.5s) delay before round over after kill
- **Map rotation**: different map each round

### Win Conditions (per round)

1. Player is killed → opponent wins the round (after linger)
2. Time runs out → most health wins
3. Tied on health → deterministic coin flip via PRNG

Match winner: first player to win 2 rounds.

---

## State Structure

```typescript
interface GameState {
  tick: number;
  players: PlayerState[];        // exactly 2
  projectiles: Projectile[];     // variable length, bounded
  weaponPickups: WeaponPickup[]; // map-defined spawn points
  rngState: number;              // Mulberry32 PRNG state
  score: Map<number, number>;    // kills per player
  nextProjectileId: number;
  arenaLeft: number;             // current left wall (sudden death)
  arenaRight: number;            // current right wall (sudden death)
  matchOver: boolean;
  winner: number;                // -1 if no winner yet
  deathLingerTimer: number;      // ticks remaining before matchOver
}

interface PlayerState {
  id: number;
  x: number; y: number;         // position
  vx: number; vy: number;       // velocity
  facing: 1 | -1;               // direction
  health: number;               // 0-100
  lives: number;                // 0-1
  shootCooldown: number;        // ticks until can fire again
  grounded: boolean;
  stateFlags: number;           // bitmask: Alive, Invincible
  respawnTimer: number;         // >0 means inactive (respawning)
  weapon: number | null;        // WeaponType or null (unarmed)
  ammo: number;                 // remaining shots for current weapon
}
```

---

## Transition Function

```
nextState = step(prevState, inputs, prevInputs, config)
```

Sub-step order (16 steps):

1. **Match over check** — if `matchOver`, return unchanged
2. **Death linger** — if `deathLingerTimer > 0`, decrement and skip gameplay
3. **Resolve inputs** — missing-input rule: reuse T-1 if absent
4. **Tick cooldowns** — decrement shoot cooldown, invincibility, respawn timers
5. **Apply movement** — horizontal acceleration from input, facing direction
6. **Apply gravity** — constant downward acceleration
7. **Move and collide** — AABB platform collision, one-way platforms
8. **Weapon pickups** — player overlaps spawn point, equip weapon + ammo
9. **Process shooting** — spawn projectiles based on weapon type and cooldown
10. **Move projectiles** — advance position, remove expired/OOB
11. **Projectile hits** — damage players, remove on hit, check eliminations
12. **Respawn pickups** — tick respawn timers on collected pickups
13. **Sudden death** — advance arena walls after tick 1200, kill OOB players
14. **Time-up** — check if tick >= 1800, determine winner by health
15. **Advance tick** — increment tick counter

---

## Determinism Constraints

Forbidden inside sim:
- `Date.now()`, `performance.now()`, or any wall-clock time
- `Math.random()` — all randomness via Mulberry32 PRNG seeded at match start
- Floating-point time deltas — use integer tick counts only
- External API calls, I/O, or side effects

The sim core is a pure function: `(state, inputs, prevInputs, config) → state`.

---

## Replay Guarantee

Given identical match params (seed, map, config) and full input transcript (up to 1800 ticks per round x 2 players), replaying from tick 0 must produce an identical final state. State hashes can be verified at configurable intervals.

---

## ZK Provability

- Up to 1800 ticks per round replayed inside RISC Zero zkVM (not Noir)
- Fixed-point i32 with 8 fractional bits (256 = 1.0) for zkVM efficiency
- Bounded loops, fixed array sizes (2 players, bounded projectile count)
- Three implementations kept in sync: TypeScript, Rust f64, Rust fixed-point i32
- Cross-validation tests ensure all three produce identical match outcomes
