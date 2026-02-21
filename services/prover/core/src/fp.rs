//! Fixed-point game simulation for efficient zkVM execution.
//! Uses i32 with 8 fractional bits (256 = 1.0), eliminating all f64 soft-float.
//! Zero heap allocations in the hot path — all arrays are fixed-size.

#![allow(clippy::needless_range_loop)] // Index loops are intentional in no-alloc zkVM code

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Max projectiles alive at once. With weapons (shotgun 5 pellets), increase cap.
pub const MAX_PROJECTILES: usize = 24;
/// Max weapon pickups on the map.
pub const MAX_WEAPON_PICKUPS: usize = 4;

// -- Fixed-point arithmetic --------------------------------------------------

pub type Fp = i32;
pub const FRAC: u32 = 8;
pub const ONE: Fp = 1 << FRAC; // 256

/// Fixed-point multiply: (a * b) >> FRAC
#[inline(always)]
pub fn mul(a: Fp, b: Fp) -> Fp {
    ((a as i64 * b as i64) >> FRAC) as Fp
}

/// Fixed-point divide: (a << FRAC) / b
#[inline(always)]
pub fn div(a: Fp, b: Fp) -> Fp {
    (((a as i64) << FRAC) / b as i64) as Fp
}

/// Convert integer to fixed-point
#[inline(always)]
pub const fn fp(v: i32) -> Fp {
    v * ONE
}

// -- Constants ---------------------------------------------------------------

pub const GRAVITY: Fp = 128; // 0.5
pub const PLAYER_SPEED: Fp = 1024; // 4.0
pub const ACCELERATION: Fp = 205; // 0.8 (204.8 rounded)
pub const DECELERATION: Fp = 154; // 0.6 (153.6 rounded)
pub const JUMP_VELOCITY: Fp = -2688; // -10.5
pub const MAX_FALL_SPEED: Fp = 3072; // 12.0

pub const PLAYER_WIDTH: Fp = 6144; // 24
pub const PLAYER_HEIGHT: Fp = 8192; // 32

pub const PROJECTILE_SPEED: Fp = 2048; // 8.0
pub const PROJECTILE_LIFETIME: i32 = 90;
pub const SHOOT_COOLDOWN: i32 = 15;

pub const MAX_HEALTH: i32 = 100;
pub const PROJECTILE_DAMAGE: i32 = 25;

pub const RESPAWN_TICKS: i32 = 60;
pub const INVINCIBLE_TICKS: i32 = 60;
pub const DEATH_LINGER_TICKS: i32 = 30;
pub const INITIAL_LIVES: i32 = 1;
pub const MATCH_DURATION_TICKS: i32 = 1800; // 30s
pub const SUDDEN_DEATH_START_TICK: i32 = 1200; // 20 seconds
pub const SUDDEN_DEATH_DURATION: i32 = 300; // 5 seconds to close
pub const ZONE_MAX_DPS: i32 = 20; // damage per second at full close

// Double jump
pub const MAX_JUMPS: i32 = 2;

// Wall slide & wall jump
pub const WALL_SLIDE_SPEED: Fp = 512; // 2.0
pub const WALL_JUMP_VX: Fp = 1792; // 7.0
pub const WALL_JUMP_VY: Fp = -2560; // -10.0

// Stomp
pub const STOMP_DAMAGE_INTERVAL: i32 = 2;
pub const STOMP_DAMAGE_PER_HIT: i32 = 1;
pub const STOMP_SHAKE_PER_PRESS: i32 = 17;
pub const STOMP_SHAKE_THRESHOLD: i32 = 100;
pub const STOMP_SHAKE_DECAY: i32 = 1;
pub const STOMP_AUTO_RUN_MIN: i32 = 20;
pub const STOMP_AUTO_RUN_MAX: i32 = 60;
pub const STOMP_COOLDOWN_TICKS: i32 = 90;

pub mod button {
    pub const LEFT: u8 = 1;
    pub const RIGHT: u8 = 2;
    pub const JUMP: u8 = 4;
    pub const SHOOT: u8 = 8;
}

pub mod flag {
    pub const ALIVE: u32 = 1;
    pub const INVINCIBLE: u32 = 2;
}

pub const FACING_RIGHT: i32 = 1;
pub const FACING_LEFT: i32 = -1;

// -- Weapon constants --------------------------------------------------------

/// Weapon type: -1 = unarmed, 0=Pistol, 1=Shotgun, 2=Sniper, 3=Rocket, 4=SMG
pub const WEAPON_NONE: i8 = -1;
pub const WEAPON_PISTOL: i8 = 0;
pub const WEAPON_SHOTGUN: i8 = 1;
pub const WEAPON_SNIPER: i8 = 2;
pub const WEAPON_ROCKET: i8 = 3;
pub const WEAPON_SMG: i8 = 4;
pub const WEAPON_COUNT: usize = 5;

pub const WEAPON_PICKUP_RESPAWN_TICKS: i32 = 300;
pub const PICKUP_RADIUS: Fp = 4096; // 16.0

/// Weapon rotation order for spawn points.
pub const WEAPON_ROTATION: [i8; WEAPON_COUNT] = [
    WEAPON_PISTOL, WEAPON_SHOTGUN, WEAPON_SNIPER, WEAPON_ROCKET, WEAPON_SMG,
];

/// Weapon stats: [damage, speed(fp), cooldown, lifetime, ammo, pellets, splash_radius(fp), splash_damage]
#[derive(Clone, Copy)]
pub struct FpWeaponStats {
    pub damage: i32,
    pub speed: Fp,
    pub cooldown: i32,
    pub lifetime: i32,
    pub ammo: i32,
    pub pellets: i32,
    pub splash_radius: Fp,
    pub splash_damage: i32,
}

/// Const lookup table — indexed by weapon type (0..5). No branching, no function call overhead.
pub const WEAPON_STATS: [FpWeaponStats; WEAPON_COUNT] = [
    // 0: Pistol
    FpWeaponStats {
        damage: 20, speed: 2048 /*8.0*/, cooldown: 12, lifetime: 90,
        ammo: 15, pellets: 1, splash_radius: 0, splash_damage: 0,
    },
    // 1: Shotgun
    FpWeaponStats {
        damage: 12, speed: 1792 /*7.0*/, cooldown: 30, lifetime: 45,
        ammo: 6, pellets: 5, splash_radius: 0, splash_damage: 0,
    },
    // 2: Sniper
    FpWeaponStats {
        damage: 80, speed: 4096 /*16.0*/, cooldown: 60, lifetime: 120,
        ammo: 3, pellets: 1, splash_radius: 0, splash_damage: 0,
    },
    // 3: Rocket
    FpWeaponStats {
        damage: 50, speed: 1792 /*7.0*/, cooldown: 45, lifetime: 120,
        ammo: 4, pellets: 1, splash_radius: 10240 /*40.0*/, splash_damage: 25,
    },
    // 4: SMG
    FpWeaponStats {
        damage: 10, speed: 2304 /*9.0*/, cooldown: 5, lifetime: 60,
        ammo: 40, pellets: 1, splash_radius: 0, splash_damage: 0,
    },
];

/// Look up weapon stats by type. Falls back to Pistol for invalid values.
#[inline(always)]
pub fn fp_weapon_stats(weapon: i8) -> FpWeaponStats {
    if weapon >= 0 && (weapon as usize) < WEAPON_COUNT {
        WEAPON_STATS[weapon as usize]
    } else {
        WEAPON_STATS[0] // fallback: Pistol
    }
}

// -- Types -------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct FpInput {
    pub buttons: u8,
    pub aim_x: i8,
    pub aim_y: i8,
}

pub const NULL_INPUT: FpInput = FpInput {
    buttons: 0,
    aim_x: 0,
    aim_y: 0,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FpProverInput {
    pub seed: u32,
    pub transcript: Vec<[FpInput; 2]>,
}

/// Decode raw bytes into seed + transcript (no serde overhead in zkVM).
/// Format: [seed: 4 bytes LE] [tick_count: 4 bytes LE] [tick × 6 bytes: p0.buttons p0.aim_x p0.aim_y p1.buttons p1.aim_x p1.aim_y]
pub fn decode_raw_input(data: &[u8]) -> (u32, Vec<[FpInput; 2]>) {
    let seed = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    let tick_count = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
    let mut transcript = Vec::with_capacity(tick_count);
    let mut offset = 8;
    for _ in 0..tick_count {
        let p0 = FpInput {
            buttons: data[offset],
            aim_x: data[offset + 1] as i8,
            aim_y: data[offset + 2] as i8,
        };
        let p1 = FpInput {
            buttons: data[offset + 3],
            aim_x: data[offset + 4] as i8,
            aim_y: data[offset + 5] as i8,
        };
        transcript.push([p0, p1]);
        offset += 6;
    }
    (seed, transcript)
}

/// Encode FpProverInput as raw bytes for the guest.
pub fn encode_raw_input(input: &FpProverInput) -> Vec<u8> {
    let mut buf = Vec::with_capacity(8 + input.transcript.len() * 6);
    buf.extend_from_slice(&input.seed.to_le_bytes());
    buf.extend_from_slice(&(input.transcript.len() as u32).to_le_bytes());
    for tick in &input.transcript {
        buf.push(tick[0].buttons);
        buf.push(tick[0].aim_x as u8);
        buf.push(tick[0].aim_y as u8);
        buf.push(tick[1].buttons);
        buf.push(tick[1].aim_x as u8);
        buf.push(tick[1].aim_y as u8);
    }
    buf
}

#[derive(Clone, Copy, Debug)]
pub struct Player {
    pub id: i32,
    pub x: Fp,
    pub y: Fp,
    pub vx: Fp,
    pub vy: Fp,
    pub facing: i32,
    pub health: i32,
    pub lives: i32,
    pub shoot_cooldown: i32,
    pub grounded: bool,
    pub state_flags: u32,
    pub respawn_timer: i32,
    pub weapon: i8,  // WEAPON_NONE (-1) or 0..4
    pub ammo: i32,
    // Double jump
    pub jumps_left: i32,
    // Wall slide/jump
    pub wall_sliding: bool,
    pub wall_dir: i32, // -1 = wall on left, 1 = wall on right, 0 = none
    // Stomp
    pub stomped_by: i32,   // -1 = none, otherwise player id
    pub stomping_on: i32,  // -1 = none, otherwise player id
    pub stomp_shake_progress: i32,
    pub stomp_last_shake_dir: i32,
    pub stomp_auto_run_dir: i32,
    pub stomp_auto_run_timer: i32,
    pub stomp_cooldown: i32,
}

#[derive(Clone, Copy, Debug)]
pub struct Projectile {
    pub id: i32,
    pub owner_id: i32,
    pub x: Fp,
    pub y: Fp,
    pub vx: Fp,
    pub vy: Fp,
    pub lifetime: i32,
    pub weapon: i8,
}

#[derive(Clone, Copy, Debug)]
pub struct WeaponPickup {
    pub id: i32,
    pub x: Fp,
    pub y: Fp,
    pub weapon: i8,
    pub respawn_timer: i32,
}

#[derive(Clone, Copy, Debug)]
pub struct Platform {
    pub x: Fp,
    pub y: Fp,
    pub width: Fp,
    pub height: Fp,
}

#[derive(Clone, Copy, Debug)]
pub struct SpawnPoint {
    pub x: Fp,
    pub y: Fp,
}

pub const NUM_PLATFORMS: usize = 8;
pub const NUM_SPAWNS: usize = 4;
pub const NUM_WEAPON_SPAWNS: usize = 4;

#[derive(Clone, Debug)]
pub struct Map {
    pub width: Fp,
    pub height: Fp,
    pub platforms: [Platform; NUM_PLATFORMS],
    pub spawns: [SpawnPoint; NUM_SPAWNS],
    pub weapon_spawns: [SpawnPoint; NUM_WEAPON_SPAWNS],
}

#[derive(Clone, Debug)]
pub struct State {
    pub tick: i32,
    pub players: [Player; 2],
    pub projectiles: [Projectile; MAX_PROJECTILES],
    pub proj_count: u8,
    pub weapon_pickups: [WeaponPickup; MAX_WEAPON_PICKUPS],
    pub pickup_count: u8,
    pub rng_state: u32,
    pub score: [u32; 2],
    pub next_proj_id: i32,
    pub arena_left: Fp,
    pub arena_right: Fp,
    pub match_over: bool,
    pub winner: i32,
    pub death_linger_timer: i32,
    pub prev_buttons: [u8; 2],
    // Per-match config (allows warmup/custom modes)
    pub cfg_initial_lives: i32,
    pub cfg_match_duration: i32,
    pub cfg_sudden_death: i32,
}

/// Sentinel projectile (unused slot)
pub const EMPTY_PROJECTILE: Projectile = Projectile {
    id: -1, owner_id: -1, x: 0, y: 0, vx: 0, vy: 0, lifetime: 0, weapon: WEAPON_NONE,
};

/// Sentinel weapon pickup (unused slot)
pub const EMPTY_PICKUP: WeaponPickup = WeaponPickup {
    id: -1, x: 0, y: 0, weapon: WEAPON_NONE, respawn_timer: 0,
};

/// Small fixed-size list for kill events (max 4 per tick)
#[derive(Clone, Copy, Debug)]
pub struct KillList {
    pub data: [(i32, i32); 4],
    pub len: u8,
}

impl Default for KillList {
    fn default() -> Self { Self::new() }
}

impl KillList {
    pub const fn new() -> Self {
        KillList { data: [(-1, -1); 4], len: 0 }
    }
    pub fn push(&mut self, killer: i32, victim: i32) {
        if (self.len as usize) < self.data.len() {
            self.data[self.len as usize] = (killer, victim);
            self.len += 1;
        }
    }
    pub fn contains_victim(&self, id: i32) -> bool {
        for i in 0..self.len as usize {
            if self.data[i].1 == id { return true; }
        }
        false
    }
    pub fn iter(&self) -> impl Iterator<Item = &(i32, i32)> {
        self.data[..self.len as usize].iter()
    }
}

// -- PRNG (pure integer) -----------------------------------------------------

pub fn prng_int_range(state: u32, min: i32, max: i32) -> (i32, u32) {
    let s = state.wrapping_add(0x6D2B79F5);
    let t = (s as u64).wrapping_mul((s ^ (s >> 15)) as u64);
    let t = t.wrapping_add(t.wrapping_mul(t | 1));
    let result = ((t ^ (t >> 14)) >> 16) as u32;
    let range = (max - min + 1) as u32;
    let val = ((result as u64 * range as u64) >> 32) as i32;
    (min + val, s)
}

// -- Map + Init --------------------------------------------------------------

pub fn arena_map() -> Map {
    Map {
        width: fp(960),
        height: fp(540),
        platforms: [
            Platform { x: fp(0), y: fp(512), width: fp(960), height: fp(32) },
            Platform { x: fp(128), y: fp(416), width: fp(176), height: fp(16) },
            Platform { x: fp(672), y: fp(416), width: fp(176), height: fp(16) },
            Platform { x: fp(352), y: fp(304), width: fp(256), height: fp(16) },
            Platform { x: fp(64), y: fp(208), width: fp(144), height: fp(16) },
            Platform { x: fp(752), y: fp(208), width: fp(144), height: fp(16) },
            Platform { x: 0, y: 0, width: 0, height: 0 }, // unused
            Platform { x: 0, y: 0, width: 0, height: 0 }, // unused
        ],
        spawns: [
            SpawnPoint { x: fp(144), y: fp(480) },
            SpawnPoint { x: fp(832), y: fp(480) },
            SpawnPoint { x: fp(432), y: fp(272) },
            SpawnPoint { x: fp(480), y: fp(176) },
        ],
        weapon_spawns: [
            SpawnPoint { x: fp(192), y: fp(384) },
            SpawnPoint { x: fp(736), y: fp(384) },
            SpawnPoint { x: fp(464), y: fp(272) },
            SpawnPoint { x: fp(464), y: fp(480) },
        ],
    }
}

pub fn create_initial_state(seed: u32, map: &Map) -> State {
    create_initial_state_cfg(seed, map, INITIAL_LIVES, MATCH_DURATION_TICKS, SUDDEN_DEATH_START_TICK)
}

pub fn create_initial_state_cfg(
    seed: u32, map: &Map,
    initial_lives: i32, match_duration: i32, sudden_death: i32,
) -> State {
    let mut weapon_pickups = [EMPTY_PICKUP; MAX_WEAPON_PICKUPS];
    for i in 0..NUM_WEAPON_SPAWNS {
        weapon_pickups[i] = WeaponPickup {
            id: i as i32,
            x: map.weapon_spawns[i].x,
            y: map.weapon_spawns[i].y,
            weapon: WEAPON_ROTATION[i % WEAPON_COUNT],
            respawn_timer: 0,
        };
    }

    State {
        tick: 0,
        players: [
            Player {
                id: 0,
                x: map.spawns[0].x,
                y: map.spawns[0].y,
                vx: 0, vy: 0,
                facing: FACING_RIGHT,
                health: MAX_HEALTH,
                lives: initial_lives,
                shoot_cooldown: 0,
                grounded: false,
                state_flags: flag::ALIVE,
                respawn_timer: 0,
                weapon: WEAPON_NONE,
                ammo: 0,
                jumps_left: MAX_JUMPS,
                wall_sliding: false,
                wall_dir: 0,
                stomped_by: -1,
                stomping_on: -1,
                stomp_shake_progress: 0,
                stomp_last_shake_dir: 0,
                stomp_auto_run_dir: 0,
                stomp_auto_run_timer: 0,
                stomp_cooldown: 0,
            },
            Player {
                id: 1,
                x: map.spawns[1].x,
                y: map.spawns[1].y,
                vx: 0, vy: 0,
                facing: FACING_LEFT,
                health: MAX_HEALTH,
                lives: initial_lives,
                shoot_cooldown: 0,
                grounded: false,
                state_flags: flag::ALIVE,
                respawn_timer: 0,
                weapon: WEAPON_NONE,
                ammo: 0,
                jumps_left: MAX_JUMPS,
                wall_sliding: false,
                wall_dir: 0,
                stomped_by: -1,
                stomping_on: -1,
                stomp_shake_progress: 0,
                stomp_last_shake_dir: 0,
                stomp_auto_run_dir: 0,
                stomp_auto_run_timer: 0,
                stomp_cooldown: 0,
            },
        ],
        projectiles: [EMPTY_PROJECTILE; MAX_PROJECTILES],
        proj_count: 0,
        weapon_pickups,
        pickup_count: NUM_WEAPON_SPAWNS as u8,
        rng_state: seed,
        score: [0, 0],
        next_proj_id: 0,
        arena_left: 0,
        arena_right: map.width,
        match_over: false,
        winner: -1,
        death_linger_timer: 0,
        prev_buttons: [0, 0],
        cfg_initial_lives: initial_lives,
        cfg_match_duration: match_duration,
        cfg_sudden_death: sudden_death,
    }
}

// -- Physics -----------------------------------------------------------------

#[inline(always)]
fn apply_input_mut(p: &mut Player, buttons: u8, prev_buttons: u8, aim_x: i8) {
    if p.state_flags & flag::ALIVE == 0 { return; }

    // If being stomped, skip movement (victim is auto-run controlled)
    if p.stomped_by >= 0 { return; }
    // If stomping on someone, skip movement (rider is locked to victim)
    if p.stomping_on >= 0 { return; }

    let mut target_vx: Fp = 0;
    if buttons & button::LEFT != 0 {
        target_vx -= PLAYER_SPEED;
    }
    if buttons & button::RIGHT != 0 {
        target_vx += PLAYER_SPEED;
    }

    if target_vx != 0 {
        if p.vx < target_vx {
            p.vx = (p.vx + ACCELERATION).min(target_vx);
        } else if p.vx > target_vx {
            p.vx = (p.vx - ACCELERATION).max(target_vx);
        }
    } else if p.vx > 0 {
        p.vx = (p.vx - DECELERATION).max(0);
    } else if p.vx < 0 {
        p.vx = (p.vx + DECELERATION).min(0);
    }

    // Jump edge detection: pressed now, not pressed last tick
    let jump_edge = (buttons & button::JUMP != 0) && (prev_buttons & button::JUMP == 0);

    if jump_edge {
        if p.wall_sliding && p.jumps_left > 0 {
            // Wall jump: push away from wall
            p.vx = WALL_JUMP_VX * (-p.wall_dir);
            p.vy = WALL_JUMP_VY;
            p.jumps_left -= 1;
            p.wall_sliding = false;
            p.wall_dir = 0;
        } else if p.jumps_left > 0 {
            // Normal/double jump
            p.vy = JUMP_VELOCITY;
            p.jumps_left -= 1;
        }
    }

    if aim_x > 0 {
        p.facing = FACING_RIGHT;
    } else if aim_x < 0 {
        p.facing = FACING_LEFT;
    }
}

#[inline(always)]
fn apply_gravity_mut(p: &mut Player) {
    if p.state_flags & flag::ALIVE == 0 { return; }
    // Skip gravity for stomp rider (rider is locked to victim in stomp processing)
    if p.stomping_on >= 0 { return; }
    let max_fall = if p.wall_sliding { WALL_SLIDE_SPEED } else { MAX_FALL_SPEED };
    p.vy = (p.vy + GRAVITY).min(max_fall);
}

#[inline(always)]
fn move_and_collide_mut(p: &mut Player, buttons: u8, map: &Map) {
    if p.state_flags & flag::ALIVE == 0 { return; }
    // Skip movement for stomp rider (rider is locked to victim in stomp processing)
    if p.stomping_on >= 0 { return; }

    p.x += p.vx;
    p.y += p.vy;
    p.grounded = false;

    // Platform collision — all platforms are solid (full AABB)
    for plat in &map.platforms {
        // Skip empty/padding platforms
        if plat.width == 0 || plat.height == 0 { continue; }
        // Check overlap
        if p.x + PLAYER_WIDTH > plat.x
            && p.x < plat.x + plat.width
            && p.y + PLAYER_HEIGHT > plat.y
            && p.y < plat.y + plat.height
        {
            let overlap_left = (p.x + PLAYER_WIDTH) - plat.x;
            let overlap_right = (plat.x + plat.width) - p.x;
            let overlap_top = (p.y + PLAYER_HEIGHT) - plat.y;
            let overlap_bottom = (plat.y + plat.height) - p.y;
            let min_overlap = overlap_left.min(overlap_right).min(overlap_top).min(overlap_bottom);

            if min_overlap == overlap_top {
                p.y = plat.y - PLAYER_HEIGHT;
                p.vy = 0;
                p.grounded = true;
            } else if min_overlap == overlap_bottom {
                p.y = plat.y + plat.height;
                p.vy = 0;
            } else if min_overlap == overlap_left {
                p.x = plat.x - PLAYER_WIDTH;
                p.vx = 0;
            } else {
                p.x = plat.x + plat.width;
                p.vx = 0;
            }
        }
    }

    // Arena boundary clamping (use map bounds — zone is damage-only, not physical)
    if p.x < 0 {
        p.x = 0;
    }
    if p.x + PLAYER_WIDTH > map.width {
        p.x = map.width - PLAYER_WIDTH;
    }
    if p.y < 0 {
        p.y = 0;
        p.vy = 0;
    }
    if p.y + PLAYER_HEIGHT > map.height {
        p.y = map.height - PLAYER_HEIGHT;
        p.vy = 0;
        p.grounded = true;
    }

    // Wall slide detection (2E)
    let pressing_left = buttons & button::LEFT != 0;
    let pressing_right = buttons & button::RIGHT != 0;
    p.wall_sliding = false;
    p.wall_dir = 0;

    if !p.grounded && p.vy > 0 {
        // Map boundary walls (not zone — zone is damage-only)
        if p.x <= 0 && pressing_left {
            p.wall_sliding = true;
            p.wall_dir = -1;
        } else if p.x + PLAYER_WIDTH >= map.width && pressing_right {
            p.wall_sliding = true;
            p.wall_dir = 1;
        }

        // Platform side walls (2-pixel tolerance band)
        if !p.wall_sliding {
            for plat in &map.platforms {
                // Vertical overlap check
                if p.y + PLAYER_HEIGHT > plat.y && p.y < plat.y + plat.height {
                    // Right side into left edge of platform
                    if pressing_right && p.x + PLAYER_WIDTH >= plat.x && p.x + PLAYER_WIDTH <= plat.x + 512 {
                        p.wall_sliding = true;
                        p.wall_dir = 1;
                        break;
                    }
                    // Left side into right edge of platform
                    if pressing_left && p.x <= plat.x + plat.width && p.x >= plat.x + plat.width - 512 {
                        p.wall_sliding = true;
                        p.wall_dir = -1;
                        break;
                    }
                }
            }
        }
    }

    // Wall sliding: character and gun face away from the wall_dir side
    if p.wall_sliding {
        p.facing = p.wall_dir;
        p.vx = 0;
    }

    // Jump refund: grounded resets to MAX_JUMPS, wall slide grants 1 if exhausted
    if p.grounded {
        p.jumps_left = MAX_JUMPS;
    } else if p.wall_sliding && p.jumps_left == 0 {
        p.jumps_left = 1;
    }
}

// -- Weapon pickup logic -----------------------------------------------------

#[inline(always)]
fn player_overlaps_pickup(p: &Player, pickup: &WeaponPickup) -> bool {
    pickup.x + PICKUP_RADIUS > p.x
        && pickup.x - PICKUP_RADIUS < p.x + PLAYER_WIDTH
        && pickup.y + PICKUP_RADIUS > p.y
        && pickup.y - PICKUP_RADIUS < p.y + PLAYER_HEIGHT
}

#[inline(always)]
fn resolve_weapon_pickups(state: &mut State) {
    for pi in 0..state.pickup_count as usize {
        if state.weapon_pickups[pi].respawn_timer > 0 {
            continue;
        }
        for i in 0..2 {
            if state.players[i].state_flags & flag::ALIVE == 0 { continue; }
            if player_overlaps_pickup(&state.players[i], &state.weapon_pickups[pi]) {
                let stats = fp_weapon_stats(state.weapon_pickups[pi].weapon);
                state.players[i].weapon = state.weapon_pickups[pi].weapon;
                state.players[i].ammo = stats.ammo;
                state.players[i].shoot_cooldown = 0;
                state.weapon_pickups[pi].respawn_timer = WEAPON_PICKUP_RESPAWN_TICKS;
                break;
            }
        }
    }
}

#[inline(always)]
fn tick_pickup_timers(state: &mut State) {
    for pi in 0..state.pickup_count as usize {
        if state.weapon_pickups[pi].respawn_timer <= 0 { continue; }
        state.weapon_pickups[pi].respawn_timer -= 1;
        if state.weapon_pickups[pi].respawn_timer <= 0 {
            let (idx, new_rng) = prng_int_range(state.rng_state, 0, (WEAPON_COUNT as i32) - 1);
            state.rng_state = new_rng;
            state.weapon_pickups[pi].weapon = WEAPON_ROTATION[idx as usize];
        }
    }
}

// -- Projectiles -------------------------------------------------------------

/// Spawn a single projectile from a player's position toward their aim direction.
#[inline(always)]
fn spawn_projectile(player: &Player, aim_x: i8, aim_y: i8, id: i32, weapon: i8, speed: Fp) -> Projectile {
    let (nx, ny) = if aim_x == 0 && aim_y == 0 {
        // Wall sliding: shoot away from wall (not into it)
        let dir = if player.wall_sliding { -player.wall_dir } else { player.facing };
        (dir * ONE, 0)
    } else if aim_y == 0 {
        (if aim_x > 0 { ONE } else { -ONE }, 0)
    } else if aim_x == 0 {
        (0, if aim_y > 0 { ONE } else { -ONE })
    } else {
        // Diagonal: 1/sqrt(2) ~ 181/256
        let d: Fp = 181;
        (if aim_x > 0 { d } else { -d }, if aim_y > 0 { d } else { -d })
    };

    // Spawn at player edge in aim direction
    let offset_x = mul(nx, PLAYER_WIDTH / 2);
    let offset_y = mul(ny, PLAYER_HEIGHT / 2);

    Projectile {
        id,
        owner_id: player.id,
        x: player.x + PLAYER_WIDTH / 2 + offset_x,
        y: player.y + PLAYER_HEIGHT / 2 + offset_y,
        vx: mul(nx, speed),
        vy: mul(ny, speed),
        lifetime: fp_weapon_stats(weapon).lifetime,
        weapon,
    }
}

/// Spawn weapon projectiles (handles shotgun multi-pellet spread).
/// Returns number of projectiles spawned.
#[inline(always)]
fn spawn_weapon_projectiles(
    state: &mut State,
    player_idx: usize,
    aim_x: i8,
    aim_y: i8,
) -> u8 {
    let weapon = state.players[player_idx].weapon;
    if weapon == WEAPON_NONE { return 0; }

    let stats = fp_weapon_stats(weapon);
    let mut spawned = 0u8;

    if stats.pellets == 1 {
        // Single projectile
        if (state.proj_count as usize) < MAX_PROJECTILES {
            let p = state.players[player_idx];
            let proj = spawn_projectile(&p, aim_x, aim_y, state.next_proj_id, weapon, stats.speed);
            state.projectiles[state.proj_count as usize] = proj;
            state.proj_count += 1;
            state.next_proj_id += 1;
            spawned = 1;
        }
    } else {
        // Multi-pellet (shotgun): spread perpendicular to aim direction
        let (nx, ny) = if aim_x == 0 && aim_y == 0 {
            let p = &state.players[player_idx];
            let dir = if p.wall_sliding { -p.wall_dir } else { p.facing };
            (dir * ONE, 0)
        } else if aim_y == 0 {
            (if aim_x > 0 { ONE } else { -ONE }, 0)
        } else if aim_x == 0 {
            (0, if aim_y > 0 { ONE } else { -ONE })
        } else {
            let d: Fp = 181;
            (if aim_x > 0 { d } else { -d }, if aim_y > 0 { d } else { -d })
        };

        // Perpendicular direction: (-ny, nx)
        let perp_x = -ny;
        let perp_y = nx;

        // Spawn at edge
        let offset_x = mul(nx, PLAYER_WIDTH / 2);
        let offset_y = mul(ny, PLAYER_HEIGHT / 2);
        let sx = state.players[player_idx].x + PLAYER_WIDTH / 2 + offset_x;
        let sy = state.players[player_idx].y + PLAYER_HEIGHT / 2 + offset_y;

        // Match TS: total arc = 14° (7° each side), 5 pellets at offsets -2,-1,0,1,2
        // Outer pellet at offset ±2 should be at ±7°: sin(3.5°) ≈ 0.061 → 16/256 per step
        const SPREAD_STEP: Fp = 16;

        for i in 0..stats.pellets {
            if (state.proj_count as usize) >= MAX_PROJECTILES { break; }

            let offset = (i - stats.pellets / 2) as Fp;
            // Add PRNG jitter: ±6/256 per pellet
            let (jitter, new_rng) = prng_int_range(state.rng_state, -6, 6);
            state.rng_state = new_rng;
            let perp_amount = offset * SPREAD_STEP + jitter;

            // Final velocity = base + perpendicular spread
            // perp_amount is in fp (33 ≈ sin 7.5°), mul gives fp result — no extra /ONE
            let spread = mul(perp_amount, stats.speed);
            let vx = mul(nx, stats.speed) + mul(perp_x, spread);
            // Upward bias: nudge pellets slightly upward (matches TS: dy -= 0.06)
            // 0.06 in fp = 15; mul(15, speed) ≈ 0.06 * speed in velocity space
            let vy = mul(ny, stats.speed) + mul(perp_y, spread) - mul(15, stats.speed);

            state.projectiles[state.proj_count as usize] = Projectile {
                id: state.next_proj_id,
                owner_id: state.players[player_idx].id,
                x: sx,
                y: sy,
                vx,
                vy,
                lifetime: stats.lifetime,
                weapon,
            };
            state.proj_count += 1;
            state.next_proj_id += 1;
            spawned += 1;
        }
    }

    spawned
}

#[inline(always)]
fn is_out_of_bounds(proj: &Projectile, map: &Map) -> bool {
    let m: Fp = 50 << 8; // 50px in fixed-point
    proj.x < -m || proj.x > map.width + m || proj.y < -m || proj.y > map.height + m
}

/// Check if a projectile hits any platform, map boundary, ceiling, or floor.
/// Uses map bounds (not arena/zone bounds) — bullets pass through the death zone.
#[inline(always)]
fn hits_solid(proj: &Projectile, map: &Map) -> bool {
    // Check platform collision (4px buffer above surface for visual consistency)
    let buf: Fp = 4 << FRAC;
    for i in 0..NUM_PLATFORMS {
        let plat = &map.platforms[i];
        if plat.width == 0 { continue; }
        if proj.x >= plat.x && proj.x <= plat.x + plat.width
            && proj.y >= plat.y - buf && proj.y <= plat.y + plat.height
        {
            return true;
        }
    }
    // Map boundary walls (NOT zone — bullets pass through zone)
    if proj.x <= 0 || proj.x >= map.width { return true; }
    // Ceiling and floor
    if proj.y <= 0 || proj.y >= map.height { return true; }
    false
}

#[inline(always)]
fn aabb_hit(px: Fp, py: Fp, rx: Fp, ry: Fp, rw: Fp, rh: Fp) -> bool {
    px >= rx && px <= rx + rw && py >= ry && py <= ry + rh
}

/// Apply rocket splash damage to all players within radius (Manhattan distance).
/// `skip_id` is the player who took the direct hit (to avoid double-damage).
#[inline(always)]
fn apply_fp_splash_damage(
    ex: Fp, ey: Fp, owner_id: i32, skip_id: Option<i32>,
    players: &mut [Player; 2],
    kills: &mut KillList,
) {
    let stats = fp_weapon_stats(WEAPON_ROCKET);
    let radius = stats.splash_radius;
    let max_dmg = stats.splash_damage;

    for i in 0..2 {
        if players[i].state_flags & flag::ALIVE == 0 { continue; }
        if players[i].state_flags & flag::INVINCIBLE != 0 { continue; }
        if players[i].id == owner_id { continue; }
        // Skip direct-hit victim to prevent double-damage
        if skip_id == Some(players[i].id) { continue; }

        let pcx = players[i].x + PLAYER_WIDTH / 2;
        let pcy = players[i].y + PLAYER_HEIGHT / 2;
        let dist = (pcx - ex).abs() + (pcy - ey).abs();

        if dist < radius {
            // Linear falloff: dmg = max_dmg * (1 - dist/radius)
            let dmg = max_dmg - (max_dmg as i64 * dist as i64 / radius as i64) as i32;
            if dmg > 0 {
                let new_hp = players[i].health - dmg;
                if new_hp <= 0 {
                    let victim_id = players[i].id;
                    players[i].health = 0;
                    players[i].state_flags = 0;
                    kills.push(owner_id, victim_id);
                } else {
                    players[i].health = new_hp;
                }
            }
        }
    }
}

/// Resolve projectile hits in-place. Returns kill list.
#[inline(always)]
fn resolve_hits_mut(state: &mut State) -> KillList {
    let mut hit_flags: [bool; MAX_PROJECTILES] = [false; MAX_PROJECTILES];
    let mut kills = KillList::new();

    for pi in 0..state.proj_count as usize {
        if hit_flags[pi] { continue; }
        let proj_owner = state.projectiles[pi].owner_id;
        let proj_x = state.projectiles[pi].x;
        let proj_y = state.projectiles[pi].y;
        let proj_weapon = state.projectiles[pi].weapon;

        for i in 0..2 {
            if state.players[i].id == proj_owner { continue; }
            if state.players[i].state_flags & flag::ALIVE == 0 { continue; }
            if state.players[i].state_flags & flag::INVINCIBLE != 0 { continue; }

            if aabb_hit(proj_x, proj_y, state.players[i].x, state.players[i].y, PLAYER_WIDTH, PLAYER_HEIGHT) {
                hit_flags[pi] = true;
                let victim_id = state.players[i].id;
                let damage = fp_weapon_stats(proj_weapon).damage;
                let new_hp = state.players[i].health - damage;
                if new_hp <= 0 {
                    state.players[i].health = 0;
                    state.players[i].state_flags = 0;
                    kills.push(proj_owner, victim_id);
                } else {
                    state.players[i].health = new_hp;
                }

                // Rocket splash damage on impact (skip direct-hit victim)
                if proj_weapon == WEAPON_ROCKET {
                    apply_fp_splash_damage(proj_x, proj_y, proj_owner, Some(victim_id), &mut state.players, &mut kills);
                }

                break;
            }
        }
    }

    // Compact: remove hit projectiles in-place
    let mut write = 0usize;
    for read in 0..state.proj_count as usize {
        if !hit_flags[read] {
            if write != read {
                state.projectiles[write] = state.projectiles[read];
            }
            write += 1;
        }
    }
    state.proj_count = write as u8;

    kills
}

// -- Step --------------------------------------------------------------------

/// Helper: clear all stomp fields on a player.
#[inline(always)]
fn clear_stomp_fields(p: &mut Player) {
    p.stomped_by = -1;
    p.stomping_on = -1;
    p.stomp_shake_progress = 0;
    p.stomp_last_shake_dir = 0;
    p.stomp_auto_run_dir = 0;
    p.stomp_auto_run_timer = 0;
}

/// Move projectiles without damage or hit checks (cosmetic only, for match_over / death linger).
fn advance_projectiles_cosmetic(state: &mut State, map: &Map) {
    let mut write = 0usize;
    for read in 0..state.proj_count as usize {
        state.projectiles[read].x += state.projectiles[read].vx;
        state.projectiles[read].y += state.projectiles[read].vy;
        state.projectiles[read].lifetime -= 1;

        let expired = state.projectiles[read].lifetime <= 0;
        let oob = is_out_of_bounds(&state.projectiles[read], map);
        let solid = hits_solid(&state.projectiles[read], map);

        if !(expired || oob || solid) {
            if write != read {
                state.projectiles[write] = state.projectiles[read];
            }
            write += 1;
        }
    }
    state.proj_count = write as u8;
}

/// Advance game state by one tick, mutating in place (zero copies of State).
pub fn step_mut(state: &mut State, inputs: &[FpInput; 2], map: &Map) {
    if state.match_over {
        // Winner can still move after match ends (taunt/flex/dance)
        state.tick += 1;
        let prev_buttons = state.prev_buttons;
        for i in 0..2 {
            if state.players[i].state_flags & flag::ALIVE != 0 {
                apply_input_mut(&mut state.players[i], inputs[i].buttons, prev_buttons[i], inputs[i].aim_x);
                apply_gravity_mut(&mut state.players[i]);
                move_and_collide_mut(&mut state.players[i], inputs[i].buttons, map);
            }
        }
        state.prev_buttons = [inputs[0].buttons, inputs[1].buttons];
        return;
    }

    // Death linger countdown — winner can still move, but no combat
    if state.death_linger_timer > 0 {
        state.tick += 1;
        state.death_linger_timer -= 1;
        if state.death_linger_timer <= 0 {
            state.match_over = true;
            state.death_linger_timer = 0;
            // Clear all projectiles, pickups, and player weapons on match end
            state.proj_count = 0;
            state.pickup_count = 0;
            for p in &mut state.players {
                p.weapon = WEAPON_NONE;
                p.ammo = 0;
            }
        }
        // Let the winner keep moving during linger (input + gravity + collision)
        let prev_buttons = state.prev_buttons;
        for i in 0..2 {
            if state.players[i].state_flags & flag::ALIVE != 0 {
                apply_input_mut(&mut state.players[i], inputs[i].buttons, prev_buttons[i], inputs[i].aim_x);
                apply_gravity_mut(&mut state.players[i]);
                move_and_collide_mut(&mut state.players[i], inputs[i].buttons, map);
            }
        }
        state.prev_buttons = [inputs[0].buttons, inputs[1].buttons];
        return;
    }

    state.tick += 1;
    let current_tick = state.tick;
    let prev_buttons = state.prev_buttons;

    // 2. Tick cooldowns + invincibility + stomp cooldown
    for p in &mut state.players {
        if p.state_flags & flag::ALIVE == 0 { continue; }
        p.shoot_cooldown = (p.shoot_cooldown - 1).max(0);
        if p.state_flags & flag::INVINCIBLE != 0 {
            p.respawn_timer -= 1;
            if p.respawn_timer <= 0 {
                p.state_flags &= !flag::INVINCIBLE;
                p.respawn_timer = 0;
            }
        }
        if p.stomp_cooldown > 0 && p.stomped_by < 0 {
            p.stomp_cooldown -= 1;
        }
    }

    // 3. Apply input + gravity + move/collide (all in-place, no copies)
    for i in 0..2 {
        apply_input_mut(&mut state.players[i], inputs[i].buttons, prev_buttons[i], inputs[i].aim_x);
        apply_gravity_mut(&mut state.players[i]);
        move_and_collide_mut(&mut state.players[i], inputs[i].buttons, map);
    }

    // 5. Stomp detection — after movement
    for a_idx in 0..2 {
        let b_idx = 1 - a_idx;
        // Skip if already stomping or being stomped, or target in cooldown
        if state.players[a_idx].stomping_on >= 0 { continue; }
        if state.players[a_idx].stomped_by >= 0 { continue; }
        if state.players[b_idx].stomped_by >= 0 { continue; }
        if state.players[b_idx].stomp_cooldown > 0 { continue; }
        if state.players[a_idx].state_flags & flag::ALIVE == 0 { continue; }
        if state.players[b_idx].state_flags & flag::ALIVE == 0 { continue; }

        // A falling onto B's head
        if state.players[a_idx].vy > 0 {
            let a_feet = state.players[a_idx].y + PLAYER_HEIGHT;
            let b_head = state.players[b_idx].y;
            if a_feet >= b_head && a_feet <= b_head + fp(8)
                && state.players[a_idx].x + PLAYER_WIDTH > state.players[b_idx].x
                && state.players[a_idx].x < state.players[b_idx].x + PLAYER_WIDTH
            {
                // Initiate stomp
                let b_id = state.players[b_idx].id;
                let a_id = state.players[a_idx].id;
                state.players[a_idx].stomping_on = b_id;
                state.players[a_idx].grounded = true;
                state.players[a_idx].vy = 0;
                state.players[a_idx].y = state.players[b_idx].y - PLAYER_HEIGHT;

                state.players[b_idx].stomped_by = a_id;
                state.players[b_idx].stomp_shake_progress = 0;
                state.players[b_idx].stomp_last_shake_dir = 0;

                // Random auto-run direction and timer
                let (dir_val, new_rng) = prng_int_range(state.rng_state, 0, 1);
                state.rng_state = new_rng;
                state.players[b_idx].stomp_auto_run_dir = if dir_val == 0 { -1 } else { 1 };
                let (timer_val, new_rng2) = prng_int_range(state.rng_state, STOMP_AUTO_RUN_MIN, STOMP_AUTO_RUN_MAX);
                state.rng_state = new_rng2;
                state.players[b_idx].stomp_auto_run_timer = timer_val;
            }
        }
    }

    // 5b. Process active stomps
    for victim_idx in 0..2 {
        if state.players[victim_idx].stomped_by < 0 { continue; }
        let rider_id = state.players[victim_idx].stomped_by;
        let rider_idx = if state.players[0].id == rider_id { 0 } else { 1 };

        // Check rider validity
        if state.players[rider_idx].state_flags & flag::ALIVE == 0
            || state.players[rider_idx].stomping_on != state.players[victim_idx].id
        {
            clear_stomp_fields(&mut state.players[victim_idx]);
            continue;
        }

        // Damage tick
        if current_tick % STOMP_DAMAGE_INTERVAL == 0 {
            state.players[victim_idx].health -= STOMP_DAMAGE_PER_HIT;
            if state.players[victim_idx].health <= 0 {
                // Kill victim, launch rider
                state.players[victim_idx].health = 0;
                state.players[victim_idx].state_flags = 0;
                state.players[rider_idx].stomping_on = -1;
                state.players[rider_idx].vy = JUMP_VELOCITY / 2;
                state.players[rider_idx].grounded = false;
                clear_stomp_fields(&mut state.players[victim_idx]);
                // Track kill in score
                let killer = state.players[rider_idx].id;
                if killer >= 0 && (killer as usize) < state.score.len() {
                    state.score[killer as usize] += 1;
                }
                state.players[victim_idx].lives -= 1;
                continue;
            }
        }

        // Auto-run: move victim
        state.players[victim_idx].stomp_auto_run_timer -= 1;
        if state.players[victim_idx].stomp_auto_run_timer <= 0 {
            state.players[victim_idx].stomp_auto_run_dir *= -1;
            let (timer_val, new_rng) = prng_int_range(state.rng_state, STOMP_AUTO_RUN_MIN, STOMP_AUTO_RUN_MAX);
            state.rng_state = new_rng;
            state.players[victim_idx].stomp_auto_run_timer = timer_val;
        }
        let run_vx = PLAYER_SPEED * state.players[victim_idx].stomp_auto_run_dir;
        state.players[victim_idx].vx = run_vx;

        // Shake-off detection (alternating L/R)
        let v_buttons = inputs[victim_idx].buttons;
        let v_prev = prev_buttons[victim_idx];
        let left_edge = (v_buttons & button::LEFT != 0) && (v_prev & button::LEFT == 0);
        let right_edge = (v_buttons & button::RIGHT != 0) && (v_prev & button::RIGHT == 0);
        if left_edge && state.players[victim_idx].stomp_last_shake_dir != -1 {
            state.players[victim_idx].stomp_shake_progress += STOMP_SHAKE_PER_PRESS;
            state.players[victim_idx].stomp_last_shake_dir = -1;
        }
        if right_edge && state.players[victim_idx].stomp_last_shake_dir != 1 {
            state.players[victim_idx].stomp_shake_progress += STOMP_SHAKE_PER_PRESS;
            state.players[victim_idx].stomp_last_shake_dir = 1;
        }
        state.players[victim_idx].stomp_shake_progress =
            (state.players[victim_idx].stomp_shake_progress - STOMP_SHAKE_DECAY).max(0);

        // Break free
        if state.players[victim_idx].stomp_shake_progress >= STOMP_SHAKE_THRESHOLD {
            state.players[rider_idx].stomping_on = -1;
            state.players[rider_idx].vy = JUMP_VELOCITY;
            state.players[rider_idx].grounded = false;
            state.players[victim_idx].stomp_cooldown = STOMP_COOLDOWN_TICKS;
            clear_stomp_fields(&mut state.players[victim_idx]);
            continue;
        }

        // Lock rider to victim position
        state.players[rider_idx].x = state.players[victim_idx].x;
        state.players[rider_idx].y = state.players[victim_idx].y - PLAYER_HEIGHT;
        state.players[rider_idx].vx = 0;
        state.players[rider_idx].vy = 0;
        state.players[rider_idx].grounded = true;
    }

    // 6. Weapon pickup collision
    resolve_weapon_pickups(state);

    // 7. Shooting — weapon-based
    for i in 0..2 {
        if state.players[i].state_flags & flag::ALIVE != 0
            && inputs[i].buttons & button::SHOOT != 0
            && state.players[i].shoot_cooldown <= 0
            && state.players[i].weapon != WEAPON_NONE
            && state.players[i].ammo > 0
        {
            let weapon = state.players[i].weapon;
            let stats = fp_weapon_stats(weapon);
            state.players[i].shoot_cooldown = stats.cooldown;
            // Wall sliding: force aim away from wall (gun always points outward)
            let shoot_aim_x = if state.players[i].wall_sliding {
                -state.players[i].wall_dir as i8
            } else {
                inputs[i].aim_x
            };
            spawn_weapon_projectiles(state, i, shoot_aim_x, inputs[i].aim_y);
            state.players[i].ammo -= 1;
            if state.players[i].ammo <= 0 {
                state.players[i].weapon = WEAPON_NONE;
            }
        }
    }

    // 8. Move projectiles in-place + compact dead ones
    //    Also check platform/wall collisions (rockets explode with splash)
    let mut solid_kills = KillList::new();
    {
        let mut write = 0usize;
        for read in 0..state.proj_count as usize {
            state.projectiles[read].x += state.projectiles[read].vx;
            state.projectiles[read].y += state.projectiles[read].vy;
            state.projectiles[read].lifetime -= 1;

            let expired = state.projectiles[read].lifetime <= 0;
            let oob = is_out_of_bounds(&state.projectiles[read], map);
            let solid = hits_solid(&state.projectiles[read], map);

            if expired || oob || solid {
                // Rocket splash damage on any destruction
                if state.projectiles[read].weapon == WEAPON_ROCKET {
                    let ex = state.projectiles[read].x;
                    let ey = state.projectiles[read].y;
                    let oid = state.projectiles[read].owner_id;
                    apply_fp_splash_damage(ex, ey, oid, None, &mut state.players, &mut solid_kills);
                }
            } else {
                if write != read {
                    state.projectiles[write] = state.projectiles[read];
                }
                write += 1;
            }
        }
        state.proj_count = write as u8;
    }

    // 9. Projectile hits
    let hit_kills = resolve_hits_mut(state);

    // 10. Deaths + lives (break stomp links on death)
    for p_idx in 0..2 {
        if hit_kills.contains_victim(state.players[p_idx].id)
            || solid_kills.contains_victim(state.players[p_idx].id) {
            state.players[p_idx].lives -= 1;
            state.players[p_idx].respawn_timer = 0;
            state.players[p_idx].vx = 0;
            state.players[p_idx].vy = 0;
            // Break stomp links
            let my_id = state.players[p_idx].id;
            let other = 1 - p_idx;
            if state.players[other].stomping_on == my_id {
                state.players[other].stomping_on = -1;
                state.players[other].grounded = false;
            }
            if state.players[other].stomped_by == my_id {
                clear_stomp_fields(&mut state.players[other]);
            }
            clear_stomp_fields(&mut state.players[p_idx]);
        }
    }

    // Check elimination — start linger instead of immediate match_over
    let mut alive_count = 0i32;
    let mut alive_id = -1i32;
    for i in 0..2 {
        if state.players[i].lives > 0 { alive_count += 1; alive_id = state.players[i].id; }
    }
    if alive_count == 1 {
        state.death_linger_timer = DEATH_LINGER_TICKS;
        state.winner = alive_id;
    } else if alive_count == 0 {
        state.death_linger_timer = DEATH_LINGER_TICKS;
        state.winner = 0;
    }

    // 11. (Respawn removed — 1 life per round, death = round over)

    // 12. Sudden death — damage zone (not physical wall)
    //     Zone closes over SUDDEN_DEATH_DURATION ticks starting at cfg_sudden_death.
    //     Players inside the zone take scaling tick damage (up to ZONE_MAX_DPS at full close).
    //     Bullets pass through the zone — it's cosmetic/damage only.
    let sd_start = state.cfg_sudden_death;
    let sd_dur = SUDDEN_DEATH_DURATION; // 300 ticks = 5 seconds
    if !state.match_over && state.death_linger_timer == 0 && current_tick >= sd_start {
        let elapsed = current_tick - sd_start;
        let progress = if elapsed >= sd_dur { ONE } else { (elapsed * ONE) / sd_dur };
        let half_w = map.width / 2;
        state.arena_left = mul(progress, half_w);
        state.arena_right = map.width - mul(progress, half_w);

        // Zone damage: applied every 5 ticks in bursts. Same total DPS as before,
        // but less spammy. At full close: 5 damage every 5 ticks (= 1 per tick avg).
        // Before full: damage per burst scales with progress.
        let dmg_progress = elapsed.min(sd_dur);
        const ZONE_DMG_INTERVAL: i32 = 5;
        if dmg_progress > 0 && elapsed % ZONE_DMG_INTERVAL == 0 {
            // Burst damage = (ZONE_DMG_INTERVAL * sd_dur * 60 / ZONE_MAX_DPS) ... simplified:
            // At full progress: 5 damage per burst. Before full: scales linearly.
            let burst_dmg = ((dmg_progress * ZONE_DMG_INTERVAL) / (sd_dur * 3)).max(1);

            for i in 0..2 {
                let p = &mut state.players[i];
                if p.state_flags & flag::ALIVE == 0 { continue; }
                let px_center = p.x + PLAYER_WIDTH / 2;
                if px_center < state.arena_left || px_center > state.arena_right {
                    p.health -= burst_dmg;
                    if p.health <= 0 {
                        p.health = 0;
                        p.lives -= 1;
                        p.state_flags = 0;
                        p.vx = 0;
                        p.vy = 0;
                    }
                }
            }
        }

        // Check for elimination after zone damage
        let mut alive_count = 0i32;
        let mut alive_id = -1i32;
        for i in 0..2 {
            if state.players[i].state_flags & flag::ALIVE != 0 {
                alive_count += 1;
                alive_id = state.players[i].id;
            }
        }
        if alive_count == 1 && state.death_linger_timer == 0 {
            state.death_linger_timer = DEATH_LINGER_TICKS;
            state.winner = alive_id;
        } else if alive_count == 0 && state.death_linger_timer == 0 {
            state.death_linger_timer = DEATH_LINGER_TICKS;
            // Score-based tiebreaker: higher score wins, player 0 wins ties
            if state.score[0] >= state.score[1] {
                state.winner = 0;
            } else {
                state.winner = 1;
            }
        }
    }

    // 13. Time-up (uses per-state config)
    if !state.match_over && state.death_linger_timer == 0 && current_tick >= state.cfg_match_duration {
        state.match_over = true;
        if state.players[0].lives > state.players[1].lives {
            state.winner = state.players[0].id;
        } else if state.players[1].lives > state.players[0].lives {
            state.winner = state.players[1].id;
        } else if state.players[0].health > state.players[1].health {
            state.winner = state.players[0].id;
        } else if state.players[1].health > state.players[0].health {
            state.winner = state.players[1].id;
        } else {
            state.winner = 0;
        }
    }

    // 14. Score (projectile kills only; stomp kills scored in stomp processing)
    for &(killer, _) in hit_kills.iter() {
        if killer >= 0 && (killer as usize) < state.score.len() {
            state.score[killer as usize] += 1;
        }
    }
    for &(killer, _) in solid_kills.iter() {
        if killer >= 0 && (killer as usize) < state.score.len() {
            state.score[killer as usize] += 1;
        }
    }

    // 15. Tick pickup timers
    tick_pickup_timers(state);

    // 16. Update prev_buttons for next tick's edge detection
    state.prev_buttons = [inputs[0].buttons, inputs[1].buttons];
}

/// Convenience wrapper that returns a new State (for tests / non-zkVM use).
pub fn step(prev: &State, inputs: &[FpInput; 2], map: &Map) -> State {
    let mut s = prev.clone();
    step_mut(&mut s, inputs, map);
    s
}

// -- Hashing -----------------------------------------------------------------

pub fn hash_transcript(transcript: &[[FpInput; 2]]) -> [u8; 32] {
    let mut buf = vec![0u8; transcript.len() * 6];
    for (i, tick) in transcript.iter().enumerate() {
        let off = i * 6;
        buf[off] = tick[0].buttons;
        buf[off + 1] = tick[0].aim_x as u8;
        buf[off + 2] = tick[0].aim_y as u8;
        buf[off + 3] = tick[1].buttons;
        buf[off + 4] = tick[1].aim_x as u8;
        buf[off + 5] = tick[1].aim_y as u8;
    }
    let mut h = Sha256::new();
    h.update(&buf);
    h.finalize().into()
}

pub fn hash_seed(seed: u32) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(seed.to_le_bytes());
    h.finalize().into()
}

// -- Streaming sim + hash (single pass, zero heap allocation) ----------------

/// Result of running the game simulation with streaming hash.
pub struct StreamingResult {
    pub state: State,
    pub transcript_hash: [u8; 32],
    pub seed_commit: [u8; 32],
}

/// Run the full simulation in a single pass over raw input bytes.
/// Parses each tick's inputs, feeds them to a streaming SHA-256 hasher,
/// and steps the sim — all without allocating any Vec.
///
/// `data` layout: [seed: 4 LE] [tick_count: 4 LE] [tick × 6 bytes]
pub fn run_streaming(data: &[u8]) -> StreamingResult {
    let seed = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    let tick_count = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;

    let map = arena_map();
    let mut state = create_initial_state(seed, &map);
    let mut hasher = Sha256::new();

    let mut offset = 8;
    for _ in 0..tick_count {
        // Parse inputs directly from raw bytes (no intermediate Vec)
        let tick_bytes = &data[offset..offset + 6];
        let inputs = [
            FpInput {
                buttons: tick_bytes[0],
                aim_x: tick_bytes[1] as i8,
                aim_y: tick_bytes[2] as i8,
            },
            FpInput {
                buttons: tick_bytes[3],
                aim_x: tick_bytes[4] as i8,
                aim_y: tick_bytes[5] as i8,
            },
        ];

        // Feed raw tick bytes to hasher (same serialization as hash_transcript)
        hasher.update(tick_bytes);

        // Step the simulation
        step_mut(&mut state, &inputs, &map);
        if state.match_over {
            // Hash remaining ticks for transcript integrity
            offset += 6;
            for remaining_offset in (offset..8 + tick_count * 6).step_by(6) {
                hasher.update(&data[remaining_offset..remaining_offset + 6]);
            }
            break;
        }

        offset += 6;
    }

    let transcript_hash: [u8; 32] = hasher.finalize().into();
    let seed_commit = hash_seed(seed);

    StreamingResult {
        state,
        transcript_hash,
        seed_commit,
    }
}

// -- State serialization (for chunked proving) --------------------------------

/// Deterministic binary encoding of State (for hashing + chunk transfer).
pub fn encode_state(s: &State) -> Vec<u8> {
    let mut b = Vec::with_capacity(512);
    b.extend_from_slice(&s.tick.to_le_bytes());
    for p in &s.players {
        b.extend_from_slice(&p.id.to_le_bytes());
        b.extend_from_slice(&p.x.to_le_bytes());
        b.extend_from_slice(&p.y.to_le_bytes());
        b.extend_from_slice(&p.vx.to_le_bytes());
        b.extend_from_slice(&p.vy.to_le_bytes());
        b.extend_from_slice(&p.facing.to_le_bytes());
        b.extend_from_slice(&p.health.to_le_bytes());
        b.extend_from_slice(&p.lives.to_le_bytes());
        b.extend_from_slice(&p.shoot_cooldown.to_le_bytes());
        b.push(p.grounded as u8);
        b.extend_from_slice(&p.state_flags.to_le_bytes());
        b.extend_from_slice(&p.respawn_timer.to_le_bytes());
        b.push(p.weapon as u8);
        b.extend_from_slice(&p.ammo.to_le_bytes());
        b.extend_from_slice(&p.jumps_left.to_le_bytes());
        b.push(p.wall_sliding as u8);
        b.extend_from_slice(&p.wall_dir.to_le_bytes());
        b.extend_from_slice(&p.stomped_by.to_le_bytes());
        b.extend_from_slice(&p.stomping_on.to_le_bytes());
        b.extend_from_slice(&p.stomp_shake_progress.to_le_bytes());
        b.extend_from_slice(&p.stomp_last_shake_dir.to_le_bytes());
        b.extend_from_slice(&p.stomp_auto_run_dir.to_le_bytes());
        b.extend_from_slice(&p.stomp_auto_run_timer.to_le_bytes());
        b.extend_from_slice(&p.stomp_cooldown.to_le_bytes());
    }
    b.push(s.proj_count);
    for i in 0..s.proj_count as usize {
        let pj = &s.projectiles[i];
        b.extend_from_slice(&pj.id.to_le_bytes());
        b.extend_from_slice(&pj.owner_id.to_le_bytes());
        b.extend_from_slice(&pj.x.to_le_bytes());
        b.extend_from_slice(&pj.y.to_le_bytes());
        b.extend_from_slice(&pj.vx.to_le_bytes());
        b.extend_from_slice(&pj.vy.to_le_bytes());
        b.extend_from_slice(&pj.lifetime.to_le_bytes());
        b.push(pj.weapon as u8);
    }
    b.push(s.pickup_count);
    for i in 0..s.pickup_count as usize {
        let wp = &s.weapon_pickups[i];
        b.extend_from_slice(&wp.id.to_le_bytes());
        b.extend_from_slice(&wp.x.to_le_bytes());
        b.extend_from_slice(&wp.y.to_le_bytes());
        b.push(wp.weapon as u8);
        b.extend_from_slice(&wp.respawn_timer.to_le_bytes());
    }
    b.extend_from_slice(&s.rng_state.to_le_bytes());
    b.extend_from_slice(&s.score[0].to_le_bytes());
    b.extend_from_slice(&s.score[1].to_le_bytes());
    b.extend_from_slice(&s.next_proj_id.to_le_bytes());
    b.extend_from_slice(&s.arena_left.to_le_bytes());
    b.extend_from_slice(&s.arena_right.to_le_bytes());
    b.push(s.match_over as u8);
    b.extend_from_slice(&s.winner.to_le_bytes());
    b.extend_from_slice(&s.death_linger_timer.to_le_bytes());
    b.push(s.prev_buttons[0]);
    b.push(s.prev_buttons[1]);
    b.extend_from_slice(&s.cfg_initial_lives.to_le_bytes());
    b.extend_from_slice(&s.cfg_match_duration.to_le_bytes());
    b.extend_from_slice(&s.cfg_sudden_death.to_le_bytes());
    b
}

/// Decode State from bytes produced by encode_state.
pub fn decode_state(b: &[u8]) -> State {
    let mut off = 0usize;
    let r32 = |b: &[u8], o: &mut usize| -> i32 {
        let v = i32::from_le_bytes([b[*o], b[*o+1], b[*o+2], b[*o+3]]);
        *o += 4; v
    };
    let ru32 = |b: &[u8], o: &mut usize| -> u32 {
        let v = u32::from_le_bytes([b[*o], b[*o+1], b[*o+2], b[*o+3]]);
        *o += 4; v
    };

    let tick = r32(b, &mut off);
    let mut players = [Player {
        id: 0, x: 0, y: 0, vx: 0, vy: 0, facing: 0, health: 0,
        lives: 0, shoot_cooldown: 0, grounded: false, state_flags: 0, respawn_timer: 0,
        weapon: WEAPON_NONE, ammo: 0,
        jumps_left: MAX_JUMPS, wall_sliding: false, wall_dir: 0,
        stomped_by: -1, stomping_on: -1, stomp_shake_progress: 0,
        stomp_last_shake_dir: 0, stomp_auto_run_dir: 0, stomp_auto_run_timer: 0,
        stomp_cooldown: 0,
    }; 2];
    for p in &mut players {
        p.id = r32(b, &mut off);
        p.x = r32(b, &mut off);
        p.y = r32(b, &mut off);
        p.vx = r32(b, &mut off);
        p.vy = r32(b, &mut off);
        p.facing = r32(b, &mut off);
        p.health = r32(b, &mut off);
        p.lives = r32(b, &mut off);
        p.shoot_cooldown = r32(b, &mut off);
        p.grounded = b[off] != 0; off += 1;
        p.state_flags = ru32(b, &mut off);
        p.respawn_timer = r32(b, &mut off);
        p.weapon = b[off] as i8; off += 1;
        p.ammo = r32(b, &mut off);
        p.jumps_left = r32(b, &mut off);
        p.wall_sliding = b[off] != 0; off += 1;
        p.wall_dir = r32(b, &mut off);
        p.stomped_by = r32(b, &mut off);
        p.stomping_on = r32(b, &mut off);
        p.stomp_shake_progress = r32(b, &mut off);
        p.stomp_last_shake_dir = r32(b, &mut off);
        p.stomp_auto_run_dir = r32(b, &mut off);
        p.stomp_auto_run_timer = r32(b, &mut off);
        p.stomp_cooldown = r32(b, &mut off);
    }
    let proj_count = b[off]; off += 1;
    let mut projectiles = [EMPTY_PROJECTILE; MAX_PROJECTILES];
    for i in 0..proj_count as usize {
        projectiles[i] = Projectile {
            id: r32(b, &mut off),
            owner_id: r32(b, &mut off),
            x: r32(b, &mut off),
            y: r32(b, &mut off),
            vx: r32(b, &mut off),
            vy: r32(b, &mut off),
            lifetime: r32(b, &mut off),
            weapon: { let w = b[off] as i8; off += 1; w },
        };
    }
    let pickup_count = b[off]; off += 1;
    let mut weapon_pickups = [EMPTY_PICKUP; MAX_WEAPON_PICKUPS];
    for i in 0..pickup_count as usize {
        weapon_pickups[i] = WeaponPickup {
            id: r32(b, &mut off),
            x: r32(b, &mut off),
            y: r32(b, &mut off),
            weapon: { let w = b[off] as i8; off += 1; w },
            respawn_timer: r32(b, &mut off),
        };
    }
    let rng_state = ru32(b, &mut off);
    let s0 = ru32(b, &mut off);
    let s1 = ru32(b, &mut off);
    let next_proj_id = r32(b, &mut off);
    let arena_left = r32(b, &mut off);
    let arena_right = r32(b, &mut off);
    let match_over = b[off] != 0; off += 1;
    let winner = r32(b, &mut off);
    let death_linger_timer = r32(b, &mut off);
    let prev_b0 = b[off]; off += 1;
    let prev_b1 = b[off]; off += 1;
    // Config fields (appended in newer format; default to constants if missing)
    let cfg_initial_lives = if off + 4 <= b.len() { r32(b, &mut off) } else { INITIAL_LIVES };
    let cfg_match_duration = if off + 4 <= b.len() { r32(b, &mut off) } else { MATCH_DURATION_TICKS };
    let cfg_sudden_death = if off + 4 <= b.len() { r32(b, &mut off) } else { SUDDEN_DEATH_START_TICK };
    let _ = off; // suppress unused warning

    State {
        tick, players, projectiles, proj_count, weapon_pickups, pickup_count,
        rng_state, score: [s0, s1], next_proj_id, arena_left, arena_right,
        match_over, winner, death_linger_timer, prev_buttons: [prev_b0, prev_b1],
        cfg_initial_lives, cfg_match_duration, cfg_sudden_death,
    }
}

/// Hash the full game state (for chunk boundary commitments).
/// Hash state by feeding fields directly to SHA-256 (no intermediate Vec).
/// MUST produce the same hash as encode_state → SHA-256 for compatibility.
pub fn hash_state(s: &State) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(s.tick.to_le_bytes());
    for p in &s.players {
        h.update(p.id.to_le_bytes());
        h.update(p.x.to_le_bytes());
        h.update(p.y.to_le_bytes());
        h.update(p.vx.to_le_bytes());
        h.update(p.vy.to_le_bytes());
        h.update(p.facing.to_le_bytes());
        h.update(p.health.to_le_bytes());
        h.update(p.lives.to_le_bytes());
        h.update(p.shoot_cooldown.to_le_bytes());
        h.update([p.grounded as u8]);
        h.update(p.state_flags.to_le_bytes());
        h.update(p.respawn_timer.to_le_bytes());
        h.update([p.weapon as u8]);
        h.update(p.ammo.to_le_bytes());
        h.update(p.jumps_left.to_le_bytes());
        h.update([p.wall_sliding as u8]);
        h.update(p.wall_dir.to_le_bytes());
        h.update(p.stomped_by.to_le_bytes());
        h.update(p.stomping_on.to_le_bytes());
        h.update(p.stomp_shake_progress.to_le_bytes());
        h.update(p.stomp_last_shake_dir.to_le_bytes());
        h.update(p.stomp_auto_run_dir.to_le_bytes());
        h.update(p.stomp_auto_run_timer.to_le_bytes());
        h.update(p.stomp_cooldown.to_le_bytes());
    }
    h.update([s.proj_count]);
    for i in 0..s.proj_count as usize {
        let pj = &s.projectiles[i];
        h.update(pj.id.to_le_bytes());
        h.update(pj.owner_id.to_le_bytes());
        h.update(pj.x.to_le_bytes());
        h.update(pj.y.to_le_bytes());
        h.update(pj.vx.to_le_bytes());
        h.update(pj.vy.to_le_bytes());
        h.update(pj.lifetime.to_le_bytes());
        h.update([pj.weapon as u8]);
    }
    h.update([s.pickup_count]);
    for i in 0..s.pickup_count as usize {
        let wp = &s.weapon_pickups[i];
        h.update(wp.id.to_le_bytes());
        h.update(wp.x.to_le_bytes());
        h.update(wp.y.to_le_bytes());
        h.update([wp.weapon as u8]);
        h.update(wp.respawn_timer.to_le_bytes());
    }
    h.update(s.rng_state.to_le_bytes());
    h.update(s.score[0].to_le_bytes());
    h.update(s.score[1].to_le_bytes());
    h.update(s.next_proj_id.to_le_bytes());
    h.update(s.arena_left.to_le_bytes());
    h.update(s.arena_right.to_le_bytes());
    h.update([s.match_over as u8]);
    h.update(s.winner.to_le_bytes());
    h.update(s.death_linger_timer.to_le_bytes());
    h.update([s.prev_buttons[0]]);
    h.update([s.prev_buttons[1]]);
    h.update(s.cfg_initial_lives.to_le_bytes());
    h.update(s.cfg_match_duration.to_le_bytes());
    h.update(s.cfg_sudden_death.to_le_bytes());
    h.finalize().into()
}

/// Chunk proof journal — what each chunk guest commits.
/// Fixed-size: 120 bytes = 30 u32 words.
#[derive(Clone, Debug)]
pub struct ChunkProof {
    pub state_hash_in: [u8; 32],
    pub state_hash_out: [u8; 32],
    pub input_hash: [u8; 32],
    pub tick_start: u32,
    pub tick_end: u32,
    pub scores: [u32; 2],
    pub match_over: bool,
    pub winner: i32,
}

pub const CHUNK_PROOF_WORDS: usize = 30;

impl ChunkProof {
    /// Encode as 30 u32 words for commit_slice.
    pub fn to_words(&self) -> [u32; CHUNK_PROOF_WORDS] {
        let mut w = [0u32; CHUNK_PROOF_WORDS];
        for i in 0..8 {
            let off = i * 4;
            w[i] = u32::from_le_bytes([
                self.state_hash_in[off], self.state_hash_in[off+1],
                self.state_hash_in[off+2], self.state_hash_in[off+3],
            ]);
        }
        for i in 0..8 {
            let off = i * 4;
            w[8+i] = u32::from_le_bytes([
                self.state_hash_out[off], self.state_hash_out[off+1],
                self.state_hash_out[off+2], self.state_hash_out[off+3],
            ]);
        }
        for i in 0..8 {
            let off = i * 4;
            w[16+i] = u32::from_le_bytes([
                self.input_hash[off], self.input_hash[off+1],
                self.input_hash[off+2], self.input_hash[off+3],
            ]);
        }
        w[24] = self.tick_start;
        w[25] = self.tick_end;
        w[26] = self.scores[0];
        w[27] = self.scores[1];
        w[28] = self.match_over as u32;
        w[29] = self.winner as u32;
        w
    }

    /// Decode from journal bytes (120 bytes = 30 u32 words as LE).
    pub fn from_journal_bytes(b: &[u8]) -> Self {
        let hash_at = |off: usize| -> [u8; 32] {
            let mut h = [0u8; 32];
            h.copy_from_slice(&b[off..off+32]);
            h
        };
        let u32_at = |off: usize| -> u32 {
            u32::from_le_bytes([b[off], b[off+1], b[off+2], b[off+3]])
        };
        ChunkProof {
            state_hash_in: hash_at(0),
            state_hash_out: hash_at(32),
            input_hash: hash_at(64),
            tick_start: u32_at(96),
            tick_end: u32_at(100),
            scores: [u32_at(104), u32_at(108)],
            match_over: u32_at(112) != 0,
            winner: u32_at(116) as i32,
        }
    }
}

// -- Tests -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fp_arithmetic() {
        assert_eq!(fp(10), 2560);
        assert_eq!(mul(fp(3), fp(4)), fp(12));
        assert_eq!(div(fp(10), fp(2)), fp(5));
        assert_eq!(mul(GRAVITY, ONE), GRAVITY);
    }

    #[test]
    fn idle_match_ends() {
        let map = arena_map();
        let mut state = create_initial_state(42, &map);
        let inputs = [NULL_INPUT; 2];
        for _ in 0..MATCH_DURATION_TICKS {
            if state.match_over { break; }
            state = step(&state, &inputs, &map);
        }
        assert!(state.match_over);
        assert!(state.tick <= MATCH_DURATION_TICKS);
    }

    #[test]
    fn player_moves_right() {
        let map = arena_map();
        let mut state = create_initial_state(42, &map);
        let x0 = state.players[0].x;
        let inputs = [
            FpInput { buttons: button::RIGHT, aim_x: 1, aim_y: 0 },
            NULL_INPUT,
        ];
        for _ in 0..10 {
            state = step(&state, &inputs, &map);
        }
        assert!(state.players[0].x > x0);
    }

    #[test]
    fn unarmed_cannot_shoot() {
        let map = arena_map();
        let mut state = create_initial_state(42, &map);
        // Clear pickups so player stays unarmed
        state.pickup_count = 0;
        let inputs = [
            FpInput { buttons: button::SHOOT, aim_x: 1, aim_y: 0 },
            NULL_INPUT,
        ];
        state = step(&state, &inputs, &map);
        assert_eq!(state.proj_count, 0);
    }

    #[test]
    fn armed_creates_projectile() {
        let map = arena_map();
        let mut state = create_initial_state(42, &map);
        state.players[0].weapon = WEAPON_PISTOL;
        state.players[0].ammo = 15;
        state.pickup_count = 0;
        let inputs = [
            FpInput { buttons: button::SHOOT, aim_x: 1, aim_y: 0 },
            NULL_INPUT,
        ];
        state = step(&state, &inputs, &map);
        assert_eq!(state.proj_count, 1);
        assert_eq!(state.projectiles[0].owner_id, 0);
        assert_eq!(state.projectiles[0].weapon, WEAPON_PISTOL);
        assert!(state.projectiles[0].vx > 0);
    }

    #[test]
    fn shotgun_creates_five_pellets() {
        let map = arena_map();
        let mut state = create_initial_state(42, &map);
        state.players[0].weapon = WEAPON_SHOTGUN;
        state.players[0].ammo = 6;
        state.pickup_count = 0;
        let inputs = [
            FpInput { buttons: button::SHOOT, aim_x: 1, aim_y: 0 },
            NULL_INPUT,
        ];
        state = step(&state, &inputs, &map);
        assert_eq!(state.proj_count, 5);
        for i in 0..5 {
            assert_eq!(state.projectiles[i].weapon, WEAPON_SHOTGUN);
        }
    }

    #[test]
    fn weapon_pickup_works() {
        let map = arena_map();
        let mut state = create_initial_state(42, &map);
        // Place player 0 on top of weapon pickup 0
        state.players[0].x = state.weapon_pickups[0].x - PLAYER_WIDTH / 2;
        state.players[0].y = state.weapon_pickups[0].y - PLAYER_HEIGHT / 2;
        assert_eq!(state.players[0].weapon, WEAPON_NONE);
        state = step(&state, &[NULL_INPUT; 2], &map);
        assert_ne!(state.players[0].weapon, WEAPON_NONE);
        assert!(state.players[0].ammo > 0);
    }

    #[test]
    fn ammo_depletes_drops_weapon() {
        let map = arena_map();
        let mut state = create_initial_state(42, &map);
        state.players[0].weapon = WEAPON_PISTOL;
        state.players[0].ammo = 1;
        state.pickup_count = 0;
        let inputs = [
            FpInput { buttons: button::SHOOT, aim_x: 1, aim_y: 0 },
            NULL_INPUT,
        ];
        state = step(&state, &inputs, &map);
        assert_eq!(state.players[0].weapon, WEAPON_NONE);
        assert_eq!(state.players[0].ammo, 0);
    }

    #[test]
    fn deterministic_replay() {
        let map = arena_map();
        let run = || {
            let mut s = create_initial_state(42, &map);
            for tick in 0..200i32 {
                let p0 = FpInput {
                    buttons: if tick % 30 < 15 { button::RIGHT | button::SHOOT } else { button::LEFT },
                    aim_x: 1,
                    aim_y: 0,
                };
                let p1 = FpInput {
                    buttons: if tick % 20 < 10 { button::LEFT | button::SHOOT } else { button::RIGHT | button::JUMP },
                    aim_x: -1,
                    aim_y: 0,
                };
                s = step(&s, &[p0, p1], &map);
                if s.match_over { break; }
            }
            s
        };
        let r1 = run();
        let r2 = run();
        assert_eq!(r1.tick, r2.tick);
        assert_eq!(r1.winner, r2.winner);
        assert_eq!(r1.score, r2.score);
        assert_eq!(r1.players[0].x, r2.players[0].x);
        assert_eq!(r1.players[1].x, r2.players[1].x);
        assert_eq!(r1.players[0].weapon, r2.players[0].weapon);
        assert_eq!(r1.players[0].ammo, r2.players[0].ammo);
    }

    #[test]
    fn encode_decode_roundtrip() {
        let map = arena_map();
        let mut state = create_initial_state(42, &map);
        state.players[0].weapon = WEAPON_SNIPER;
        state.players[0].ammo = 3;
        let encoded = encode_state(&state);
        let decoded = decode_state(&encoded);
        assert_eq!(state.tick, decoded.tick);
        assert_eq!(state.players[0].x, decoded.players[0].x);
        assert_eq!(state.players[0].weapon, decoded.players[0].weapon);
        assert_eq!(state.players[0].ammo, decoded.players[0].ammo);
        assert_eq!(state.pickup_count, decoded.pickup_count);
        assert_eq!(state.weapon_pickups[0].weapon, decoded.weapon_pickups[0].weapon);
        assert_eq!(state.rng_state, decoded.rng_state);
        assert_eq!(state.winner, decoded.winner);
    }

    #[test]
    fn streaming_matches_original() {
        // Build a transcript with some combat inputs
        let seed = 42u32;
        let tick_count = 300u32;
        let mut transcript = Vec::with_capacity(tick_count as usize);
        let mut raw = Vec::with_capacity(8 + tick_count as usize * 6);
        raw.extend_from_slice(&seed.to_le_bytes());
        raw.extend_from_slice(&tick_count.to_le_bytes());

        for t in 0..tick_count {
            let p0 = FpInput {
                buttons: if t % 3 == 0 { button::RIGHT | button::SHOOT } else { button::RIGHT },
                aim_x: 1,
                aim_y: 0,
            };
            let p1 = FpInput {
                buttons: if t % 5 == 0 { button::LEFT | button::SHOOT } else { button::LEFT },
                aim_x: -1,
                aim_y: 0,
            };
            raw.push(p0.buttons);
            raw.push(p0.aim_x as u8);
            raw.push(p0.aim_y as u8);
            raw.push(p1.buttons);
            raw.push(p1.aim_x as u8);
            raw.push(p1.aim_y as u8);
            transcript.push([p0, p1]);
        }

        // Original three-step approach
        let (orig_seed, orig_transcript) = decode_raw_input(&raw);
        let map = arena_map();
        let mut orig_state = create_initial_state(orig_seed, &map);
        for tick_inputs in &orig_transcript {
            step_mut(&mut orig_state, tick_inputs, &map);
            if orig_state.match_over { break; }
        }
        let orig_hash = hash_transcript(&orig_transcript);
        let orig_seed_commit = hash_seed(orig_seed);

        // Streaming single-pass approach
        let streaming = run_streaming(&raw);

        // Must produce identical results
        assert_eq!(streaming.state.tick, orig_state.tick);
        assert_eq!(streaming.state.winner, orig_state.winner);
        assert_eq!(streaming.state.match_over, orig_state.match_over);
        assert_eq!(streaming.state.score, orig_state.score);
        assert_eq!(streaming.state.players[0].x, orig_state.players[0].x);
        assert_eq!(streaming.state.players[1].x, orig_state.players[1].x);
        assert_eq!(streaming.state.players[0].lives, orig_state.players[0].lives);
        assert_eq!(streaming.state.players[1].lives, orig_state.players[1].lives);
        assert_eq!(streaming.transcript_hash, orig_hash);
        assert_eq!(streaming.seed_commit, orig_seed_commit);
    }

    #[test]
    fn streaming_early_exit_hashes_all_ticks() {
        // Create inputs where match ends early (one player dies quickly)
        // The streaming function must hash ALL tick bytes, not just ticks played
        let seed = 42u32;
        let tick_count = 1800u32;
        let mut raw = Vec::with_capacity(8 + tick_count as usize * 6);
        raw.extend_from_slice(&seed.to_le_bytes());
        raw.extend_from_slice(&tick_count.to_le_bytes());

        // All idle inputs
        for _ in 0..tick_count {
            raw.extend_from_slice(&[0u8; 6]);
        }

        let streaming = run_streaming(&raw);

        // Original approach for comparison
        let (_, orig_transcript) = decode_raw_input(&raw);
        let orig_hash = hash_transcript(&orig_transcript);
        assert_eq!(streaming.transcript_hash, orig_hash);
    }

    #[test]
    fn streaming_hash_state_matches_encode() {
        // Run a short sim and verify streaming hash_state == encode_state → SHA-256
        let map = arena_map();
        let mut state = create_initial_state(42, &map);
        let inputs = [
            FpInput { buttons: button::RIGHT | button::SHOOT, aim_x: 1, aim_y: 0 },
            FpInput { buttons: button::LEFT, aim_x: -1, aim_y: 0 },
        ];
        // Run several ticks to get non-trivial state
        for _ in 0..100 {
            step_mut(&mut state, &inputs, &map);
        }

        // Old approach: encode_state → Vec → SHA-256
        let encoded = encode_state(&state);
        let mut h = Sha256::new();
        h.update(&encoded);
        let old_hash: [u8; 32] = h.finalize().into();

        // New approach: streaming hash_state
        let new_hash = hash_state(&state);

        assert_eq!(old_hash, new_hash);
    }
}
