# Sim Spec — Deterministic Simulation

The simulation must be pure, deterministic, and replayable from a transcript. The single source of truth is the Rust fixed-point i32 implementation in `services/prover/core/src/fp.rs`, compiled to WASM (client/server) and RISC-V (zkVM guest). A legacy TypeScript implementation exists for type definitions and constants.

---

## Game Rules

- **2 players**, 1 life per round, 100 HP, best of 3 rounds
- **30-second rounds** (1800 ticks at 60Hz)
- **5 weapons**: Pistol, Shotgun, Sniper, Rocket, SMG — picked up from map spawns
- Players deal damage via projectiles and stomps
- **Double jump**: each player has 2 jumps (reset on ground, 1 refunded on wall slide)
- **Wall sliding and wall jumping**: press into a wall while falling to slide; jump from wall to push away
- **Stomping**: land on an opponent's head to ride them, dealing periodic damage; victim can shake off with alternating L/R inputs
- **Sudden death** at tick 1200 (20s): damage zone closes inward over 5 seconds (300 ticks); the zone deals scaling damage but is not a physical wall
- **Death linger**: 30-tick (0.5s) delay before round over after kill; the surviving player can still move during linger
- **Map rotation**: different map each round

### Win Conditions (per round)

1. Player is killed (HP reaches 0) — opponent wins the round (after 30-tick linger)
2. Time runs out — most lives wins; if tied, most health wins
3. Tied on lives and health — player 0 (home) wins tiebreaker (deterministic, no draws)

Match winner: first player to win 2 rounds.

---

## State Structure

```typescript
interface GameState {
  tick: number;
  players: Player[];             // exactly 2
  projectiles: Projectile[];     // fixed-size array, MAX_PROJECTILES = 24
  projCount: number;             // active projectile count
  weaponPickups: WeaponPickup[]; // fixed-size array, MAX_WEAPON_PICKUPS = 4
  pickupCount: number;           // active pickup count
  rngState: number;              // Mulberry32 PRNG state (u32)
  score: [number, number];       // kills per player
  nextProjId: number;
  arenaLeft: number;             // current left zone boundary (sudden death)
  arenaRight: number;            // current right zone boundary (sudden death)
  matchOver: boolean;
  winner: number;                // -1 if no winner yet
  deathLingerTimer: number;      // ticks remaining before matchOver
  prevButtons: [number, number]; // previous tick's button state per player
  // Per-match config (allows warmup/custom modes)
  cfgInitialLives: number;
  cfgMatchDuration: number;      // default 1800
  cfgSuddenDeath: number;        // default 1200
}

interface Player {
  id: number;
  x: number; y: number;         // position (fixed-point)
  vx: number; vy: number;       // velocity (fixed-point)
  facing: 1 | -1;               // direction
  health: number;               // 0-100
  lives: number;                // 0-1
  shootCooldown: number;        // ticks until can fire again
  grounded: boolean;
  stateFlags: number;           // bitmask: Alive (1), Invincible (2)
  respawnTimer: number;         // doubles as invincibility countdown
  weapon: number;               // -1 (WEAPON_NONE) or 0..4
  ammo: number;                 // remaining shots for current weapon
  // Double jump
  jumpsLeft: number;            // 0..MAX_JUMPS (2), reset on ground
  // Wall slide/jump
  wallSliding: boolean;         // true when sliding down a wall
  wallDir: number;              // -1 = wall on left, 1 = wall on right, 0 = none
  // Stomp
  stompedBy: number;            // -1 = none, otherwise rider's player id
  stompingOn: number;           // -1 = none, otherwise victim's player id
  stompShakeProgress: number;   // victim's shake-off progress (0..THRESHOLD)
  stompLastShakeDir: number;    // last shake direction (-1 or 1), forces alternation
  stompAutoRunDir: number;      // random auto-run direction while stomped (-1 or 1)
  stompAutoRunTimer: number;    // ticks until auto-run direction reverses
  stompCooldown: number;        // ticks of immunity after shaking off a stomp
}
```

---

## Transition Function

```
step_mut(state: &mut State, inputs: &[FpInput; 2], map: &Map)
```

The function mutates state in-place. Previous buttons are stored inside `state.prev_buttons` (not passed separately). The missing-input rule (reuse T-1 if absent) is handled by the caller (server/prover), not inside `step_mut`. Per-match config (`cfgMatchDuration`, `cfgSuddenDeath`) is embedded in State, not passed as a separate config argument.

Sub-step order (matches `fp.rs` exactly):

1. **Match over check** — if `matchOver`, increment tick, let the surviving player move (input + gravity + collide), update `prevButtons`, then return early
2. **Death linger** — if `deathLingerTimer > 0`, increment tick, decrement timer; when timer reaches 0, set `matchOver = true` and clear all projectiles, pickups, and player weapons; let the surviving player move during linger; update `prevButtons` and return early
3. **Increment tick** — `tick += 1`
4. **Tick cooldowns** — for each alive player: decrement `shootCooldown`, decrement invincibility `respawnTimer` (clear INVINCIBLE flag when it reaches 0), decrement `stompCooldown` (only if not currently stomped)
5. **Apply input + gravity + move/collide** — for each player, in sequence: apply horizontal acceleration from input and set facing direction (skip if stomped or stomping); apply gravity with wall-slide capped fall speed (skip if stomping); move by velocity, resolve AABB platform collisions, clamp to arena boundaries, detect wall slides, refund jumps on ground/wall (skip if stomping)
6. **Stomp detection** — after movement, check if a falling player's feet overlap another player's head; if so, initiate stomp: lock rider on top of victim, set random auto-run direction and timer via PRNG
7. **Process active stomps** — for each stomped victim: apply periodic damage (every `STOMP_DAMAGE_INTERVAL` ticks); if victim dies, launch rider upward, score the kill; run auto-run movement with random direction reversals; detect shake-off from alternating L/R edge inputs; if shake progress reaches threshold, break free and apply stomp cooldown; otherwise lock rider position to victim
8. **Weapon pickups** — alive player overlaps an active spawn point: equip weapon and set ammo
9. **Shooting** — for each alive player with SHOOT pressed, weapon equipped, ammo remaining, and cooldown expired: set cooldown, spawn projectiles (wall-sliding forces aim away from wall), decrement ammo, drop weapon when ammo reaches 0
10. **Move projectiles** — advance position, decrement lifetime; remove expired, out-of-bounds, or solid-hitting projectiles (compact array in-place); apply rocket splash damage on any projectile destruction
11. **Projectile hits** — check each projectile against each player (skip owner, skip dead, skip invincible); apply damage, rocket splash on hit; remove projectile on hit
12. **Deaths + lives** — for players killed by projectile or splash hits: decrement lives, zero velocity, break any active stomp links (both as rider and victim)
13. **Elimination check** — if exactly 1 player alive, start death linger and set winner; if 0 alive, start linger with player 0 as winner
14. **Sudden death zone** — after `cfgSuddenDeath` tick: advance `arenaLeft`/`arenaRight` inward over `SUDDEN_DEATH_DURATION` (300 ticks); apply burst damage every 10 ticks to players outside the zone (damage scales with zone progress); check for zone-caused eliminations (score-based tiebreaker if both die: higher score wins, player 0 breaks ties)
15. **Time-up** — if tick reaches `cfgMatchDuration` with no winner: set `matchOver`, determine winner by lives then health then player 0 tiebreaker
16. **Score tracking** — record kills from projectile and splash hit KillLists (stomp kills are scored in step 7)
17. **Tick pickup timers** — decrement respawn timers on collected weapon pickups
18. **Update prev_buttons** — store current buttons for next tick's edge detection

---

## Determinism Constraints

Forbidden inside sim:
- `Date.now()`, `performance.now()`, or any wall-clock time
- `Math.random()` — all randomness via Mulberry32 PRNG seeded at match start
- Floating-point time deltas — use integer tick counts only
- External API calls, I/O, or side effects

The sim core is a pure function of `(state, inputs, map)`. All per-match configuration is embedded in State. Previous input state is stored in `state.prev_buttons`.

---

## Replay Guarantee

Given identical match params (seed, map, config) and full input transcript (up to 1800 ticks per round x 2 players), replaying from tick 0 must produce an identical final state. State hashes can be verified at configurable intervals.

---

## ZK Provability

- Up to 1800 ticks per round replayed inside RISC Zero zkVM (not Noir)
- Fixed-point i32 with 8 fractional bits (256 = 1.0) for zkVM efficiency
- Bounded loops, fixed array sizes (2 players, 24 max projectiles, 4 max pickups)
- Zero heap allocations in the hot path — all arrays are fixed-size
- `step_mut` mutates in-place (no copies) for minimal cycle count
- Single Rust fixed-point i32 implementation compiled to WASM and RISC-V
- Cross-validation tests ensure WASM and zkVM produce identical outcomes
