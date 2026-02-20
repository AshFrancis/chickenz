import type { WeaponStats } from "./types";
import { WeaponType } from "./types";

// All values are per-tick at 60 Hz unless noted

// Physics
export const GRAVITY = 0.5;
export const PLAYER_SPEED = 4.0;
export const ACCELERATION = 0.8;
export const DECELERATION = 0.6;
export const JUMP_VELOCITY = -12.0;
export const MAX_FALL_SPEED = 12.0;

// Player hitbox
export const PLAYER_WIDTH = 24;
export const PLAYER_HEIGHT = 32;

// Double jump / wall slide
export const MAX_JUMPS = 2;
export const WALL_SLIDE_SPEED = 2.0;
export const WALL_JUMP_VX = 7.0;
export const WALL_JUMP_VY = -10.0;

// Legacy projectile defaults (used as fallback)
export const PROJECTILE_SPEED = 8.0;
export const PROJECTILE_LIFETIME = 90; // ticks (1.5s)
export const SHOOT_COOLDOWN = 15; // ticks (0.25s)
export const PROJECTILE_RADIUS = 4;

// Health / combat
export const MAX_HEALTH = 100;
export const PROJECTILE_DAMAGE = 25; // 4 hits to kill (legacy, per-weapon now)
// Respawn
export const RESPAWN_TICKS = 60; // 1s respawn delay
export const INVINCIBLE_TICKS = 60; // 1s

// Death linger — delay before matchOver so players see the killing blow
export const DEATH_LINGER_TICKS = 30; // 0.5s

// Match rules
export const INITIAL_LIVES = 1;
export const MATCH_DURATION_TICKS = 1800; // 30s at 60 Hz
export const SUDDEN_DEATH_START_TICK = 1200; // 20s

// Tick rate
export const TICK_RATE = 60;
export const TICK_DT_MS = 1000 / TICK_RATE; // ~16.667ms

// ── Weapon Stats ──────────────────────────────────────────

export const WEAPON_STATS: Record<WeaponType, WeaponStats> = {
  [WeaponType.Pistol]: {
    damage: 20,
    speed: 8.0,
    cooldown: 12,
    lifetime: 90,
    ammo: 15,
    pellets: 1,
    spreadDeg: 0,
    splashRadius: 0,
    splashDamage: 0,
  },
  [WeaponType.Shotgun]: {
    damage: 12,
    speed: 7.0,
    cooldown: 30,
    lifetime: 45,
    ammo: 6,
    pellets: 5,
    spreadDeg: 15,
    splashRadius: 0,
    splashDamage: 0,
  },
  [WeaponType.Sniper]: {
    damage: 80,
    speed: 16.0,
    cooldown: 60,
    lifetime: 120,
    ammo: 3,
    pellets: 1,
    spreadDeg: 0,
    splashRadius: 0,
    splashDamage: 0,
  },
  [WeaponType.Rocket]: {
    damage: 50,
    speed: 5.0,
    cooldown: 45,
    lifetime: 120,
    ammo: 4,
    pellets: 1,
    spreadDeg: 0,
    splashRadius: 40,
    splashDamage: 25,
  },
  [WeaponType.SMG]: {
    damage: 10,
    speed: 9.0,
    cooldown: 5,
    lifetime: 60,
    ammo: 40,
    pellets: 1,
    spreadDeg: 0,
    splashRadius: 0,
    splashDamage: 0,
  },
};

// Weapon pickup respawn time
export const WEAPON_PICKUP_RESPAWN_TICKS = 300; // 5 seconds

// Weapon type rotation order for spawn points
export const WEAPON_ROTATION: WeaponType[] = [
  WeaponType.Pistol,
  WeaponType.Shotgun,
  WeaponType.Sniper,
  WeaponType.Rocket,
  WeaponType.SMG,
];
