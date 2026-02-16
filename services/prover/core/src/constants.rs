// All values are per-tick at 60 Hz unless noted.

// Physics
pub const GRAVITY: f64 = 0.5;
pub const PLAYER_SPEED: f64 = 4.0;
pub const ACCELERATION: f64 = 0.8;
pub const DECELERATION: f64 = 0.6;
pub const JUMP_VELOCITY: f64 = -12.0;
pub const MAX_FALL_SPEED: f64 = 12.0;

// Stomp
pub const STOMP_VELOCITY_THRESHOLD: f64 = 2.0;
pub const STOMP_BOUNCE: f64 = -8.0;

// Player hitbox
pub const PLAYER_WIDTH: f64 = 24.0;
pub const PLAYER_HEIGHT: f64 = 32.0;

// Projectiles
pub const PROJECTILE_SPEED: f64 = 8.0;
pub const PROJECTILE_LIFETIME: i32 = 90;
pub const SHOOT_COOLDOWN: i32 = 15;
pub const PROJECTILE_RADIUS: f64 = 4.0;

// Health / combat
pub const MAX_HEALTH: i32 = 100;
pub const PROJECTILE_DAMAGE: i32 = 25;

// Respawn
pub const RESPAWN_TICKS: i32 = 60;
pub const INVINCIBLE_TICKS: i32 = 36;

// Match rules
pub const INITIAL_LIVES: i32 = 3;
pub const MATCH_DURATION_TICKS: u32 = 3600;
pub const SUDDEN_DEATH_START_TICK: u32 = 3000;

// Tick rate
pub const TICK_RATE: u32 = 60;
