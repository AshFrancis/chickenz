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
}

// ── Game State ──────────────────────────────────────────────

export interface GameState {
  readonly tick: Tick;
  readonly players: readonly PlayerState[];
  readonly projectiles: readonly Projectile[];
  readonly rngState: number;
  readonly score: ReadonlyMap<PlayerId, number>;
  readonly nextProjectileId: number;
  readonly arenaLeft: number;
  readonly arenaRight: number;
  readonly matchOver: boolean;
  readonly winner: number; // PlayerId or -1 (no winner / draw)
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
