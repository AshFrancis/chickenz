use crate::types::{WeaponStats, WeaponType};

// All values are per-tick at 60 Hz unless noted.

// Physics
pub const GRAVITY: f64 = 0.5;
pub const PLAYER_SPEED: f64 = 4.0;
pub const ACCELERATION: f64 = 0.8;
pub const DECELERATION: f64 = 0.6;
pub const JUMP_VELOCITY: f64 = -12.0;
pub const MAX_FALL_SPEED: f64 = 12.0;

// Player hitbox
pub const PLAYER_WIDTH: f64 = 24.0;
pub const PLAYER_HEIGHT: f64 = 32.0;

// Legacy projectile defaults
pub const PROJECTILE_SPEED: f64 = 8.0;
pub const PROJECTILE_LIFETIME: i32 = 90;
pub const SHOOT_COOLDOWN: i32 = 15;
pub const PROJECTILE_RADIUS: f64 = 4.0;

// Health / combat
pub const MAX_HEALTH: i32 = 100;
pub const PROJECTILE_DAMAGE: i32 = 25;

// Respawn
pub const RESPAWN_TICKS: i32 = 60;
pub const INVINCIBLE_TICKS: i32 = 60;

// Death linger — delay before match_over so players see the killing blow
pub const DEATH_LINGER_TICKS: i32 = 30;

// Match rules
pub const INITIAL_LIVES: i32 = 1;
pub const MATCH_DURATION_TICKS: u32 = 1800;
pub const SUDDEN_DEATH_START_TICK: u32 = 1200;

// Tick rate
pub const TICK_RATE: u32 = 60;

// Weapon pickup
pub const WEAPON_PICKUP_RESPAWN_TICKS: i32 = 300;
pub const PICKUP_RADIUS: f64 = 16.0;

pub const WEAPON_ROTATION: [WeaponType; 5] = [
    WeaponType::Pistol,
    WeaponType::Shotgun,
    WeaponType::Sniper,
    WeaponType::Rocket,
    WeaponType::SMG,
];

pub fn weapon_stats(weapon: WeaponType) -> WeaponStats {
    match weapon {
        WeaponType::Pistol => WeaponStats {
            damage: 20,
            speed: 8.0,
            cooldown: 12,
            lifetime: 90,
            ammo: 15,
            pellets: 1,
            spread_deg: 0.0,
            splash_radius: 0.0,
            splash_damage: 0,
        },
        WeaponType::Shotgun => WeaponStats {
            damage: 12,
            speed: 7.0,
            cooldown: 30,
            lifetime: 45,
            ammo: 6,
            pellets: 5,
            spread_deg: 15.0,
            splash_radius: 0.0,
            splash_damage: 0,
        },
        WeaponType::Sniper => WeaponStats {
            damage: 80,
            speed: 16.0,
            cooldown: 60,
            lifetime: 120,
            ammo: 3,
            pellets: 1,
            spread_deg: 0.0,
            splash_radius: 0.0,
            splash_damage: 0,
        },
        WeaponType::Rocket => WeaponStats {
            damage: 50,
            speed: 5.0,
            cooldown: 45,
            lifetime: 120,
            ammo: 4,
            pellets: 1,
            spread_deg: 0.0,
            splash_radius: 40.0,
            splash_damage: 25,
        },
        WeaponType::SMG => WeaponStats {
            damage: 10,
            speed: 9.0,
            cooldown: 5,
            lifetime: 60,
            ammo: 40,
            pellets: 1,
            spread_deg: 0.0,
            splash_radius: 0.0,
            splash_damage: 0,
        },
    }
}
