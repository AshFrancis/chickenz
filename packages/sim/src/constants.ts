// All values are per-tick at 60 Hz unless noted

// Physics
export const GRAVITY = 0.5;
export const PLAYER_SPEED = 4.0;
export const ACCELERATION = 0.8;
export const DECELERATION = 0.6;
export const JUMP_VELOCITY = -12.0;
export const MAX_FALL_SPEED = 12.0;

// Stomp
export const STOMP_VELOCITY_THRESHOLD = 2.0; // min downward vy to stomp
export const STOMP_BOUNCE = -8.0; // bounce up after stomping

// Player hitbox
export const PLAYER_WIDTH = 24;
export const PLAYER_HEIGHT = 32;

// Projectiles
export const PROJECTILE_SPEED = 8.0;
export const PROJECTILE_LIFETIME = 90; // ticks (1.5s)
export const SHOOT_COOLDOWN = 15; // ticks (0.25s)
export const PROJECTILE_RADIUS = 4;

// Health / combat
export const MAX_HEALTH = 100;
export const PROJECTILE_DAMAGE = 25; // 4 hits to kill

// Respawn
export const RESPAWN_TICKS = 60; // 1s
export const INVINCIBLE_TICKS = 36; // 0.6s

// Match rules
export const INITIAL_LIVES = 3;
export const MATCH_DURATION_TICKS = 3600; // 60s at 60 Hz
export const SUDDEN_DEATH_START_TICK = 3000; // 50s

// Tick rate
export const TICK_RATE = 60;
export const TICK_DT_MS = 1000 / TICK_RATE; // ~16.667ms
