// ── Primitives ──────────────────────────────────────────────

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export type PlayerId = number;
export type Tick = number;
export type Seed = number;

// ── Input ───────────────────────────────────────────────────

/** Button bitmask constants */
export const Button = {
  Left: 1,
  Right: 2,
  Jump: 4,
  Shoot: 8,
} as const;

export interface PlayerInput {
  readonly buttons: number;
  readonly aimX: number;
  readonly aimY: number;
}

export const NULL_INPUT: PlayerInput = { buttons: 0, aimX: 0, aimY: 0 };

// ── Weapons ────────────────────────────────────────────────

export const enum WeaponType {
  Pistol = 0,
  Shotgun = 1,
  Sniper = 2,
  Rocket = 3,
  SMG = 4,
}

export interface WeaponStats {
  readonly damage: number;
  readonly speed: number;
  readonly cooldown: number;
  readonly lifetime: number;
  readonly ammo: number;
  readonly pellets: number;       // 1 for all except shotgun (5)
  readonly spreadDeg: number;     // 0 for all except shotgun (15)
  readonly splashRadius: number;  // 0 for all except rocket (40)
  readonly splashDamage: number;  // 0 for all except rocket (25)
}

// ── Weapon Pickups ─────────────────────────────────────────

export interface WeaponPickup {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly weapon: WeaponType;
  readonly respawnTimer: number;  // >0 means inactive (counting down)
}

// ── Player ──────────────────────────────────────────────────

export const enum Facing {
  Right = 1,
  Left = -1,
}

export const enum PlayerStateFlag {
  Alive = 1,
  Invincible = 2,
}

export interface PlayerState {
  readonly id: PlayerId;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly facing: Facing;
  readonly health: number;
  readonly lives: number;
  readonly shootCooldown: number;
  readonly grounded: boolean;
  readonly stateFlags: number;
  readonly respawnTimer: number;
  readonly weapon: WeaponType | null;
  readonly ammo: number;
  readonly jumpsLeft: number;     // 0..MAX_JUMPS, reset on ground
  readonly wallSliding: boolean;  // true when sliding down a wall
  readonly wallDir: number;       // -1 wall on left, 1 wall on right, 0 none
}

// ── Projectile ──────────────────────────────────────────────

export interface Projectile {
  readonly id: number;
  readonly ownerId: PlayerId;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly lifetime: number;
  readonly weapon: WeaponType;
}

// ── Map ─────────────────────────────────────────────────────

export interface Platform {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GameMap {
  readonly width: number;
  readonly height: number;
  readonly platforms: readonly Platform[];
  readonly spawnPoints: readonly Vec2[];
  readonly weaponSpawnPoints: readonly Vec2[];
}

// ── Game State ──────────────────────────────────────────────

export interface GameState {
  readonly tick: Tick;
  readonly players: readonly PlayerState[];
  readonly projectiles: readonly Projectile[];
  readonly weaponPickups: readonly WeaponPickup[];
  readonly rngState: number;
  readonly score: ReadonlyMap<PlayerId, number>;
  readonly nextProjectileId: number;
  readonly arenaLeft: number;
  readonly arenaRight: number;
  readonly matchOver: boolean;
  readonly winner: number; // PlayerId or -1 (no winner / draw)
  readonly deathLingerTimer: number; // ticks remaining before matchOver after final kill
}

// ── Config ──────────────────────────────────────────────────

export interface MatchConfig {
  readonly seed: Seed;
  readonly map: GameMap;
  readonly playerCount: number;
  readonly tickRate: number;
  readonly initialLives: number;
  readonly matchDurationTicks: number;
  readonly suddenDeathStartTick: number;
}

// ── Input map ───────────────────────────────────────────────

export type InputMap = ReadonlyMap<PlayerId, PlayerInput>;
