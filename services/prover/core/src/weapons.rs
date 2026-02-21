#![allow(clippy::needless_range_loop)] // Index loops required for mutable cross-referencing

use crate::constants::*;
use crate::prng::prng_next;
use crate::types::*;

/// Create initial weapon pickups from map spawn points.
pub fn create_initial_pickups(map: &GameMap) -> Vec<WeaponPickup> {
    map.weapon_spawn_points
        .iter()
        .enumerate()
        .map(|(i, sp)| WeaponPickup {
            id: i as i32,
            x: sp.x,
            y: sp.y,
            weapon: WEAPON_ROTATION[i % WEAPON_ROTATION.len()],
            respawn_timer: 0,
        })
        .collect()
}

/// Tick pickup respawn timers and pick a random weapon type when respawning.
pub fn tick_pickup_timers(pickups: &mut [WeaponPickup], rng_state: &mut u32) {
    for p in pickups.iter_mut() {
        if p.respawn_timer <= 0 {
            continue;
        }
        p.respawn_timer -= 1;
        if p.respawn_timer <= 0 {
            let (idx, new_rng) = prng_next(*rng_state);
            *rng_state = new_rng;
            let weapon_idx = (idx * WEAPON_ROTATION.len() as f64) as usize % WEAPON_ROTATION.len();
            p.weapon = WEAPON_ROTATION[weapon_idx];
        }
    }
}

/// Check if a player overlaps a pickup (AABB with radius).
fn player_overlaps_pickup(p: &PlayerState, pickup: &WeaponPickup) -> bool {
    pickup.x + PICKUP_RADIUS > p.x
        && pickup.x - PICKUP_RADIUS < p.x + PLAYER_WIDTH
        && pickup.y + PICKUP_RADIUS > p.y
        && pickup.y - PICKUP_RADIUS < p.y + PLAYER_HEIGHT
}

/// Resolve weapon pickups — players touching active pickups equip them.
pub fn resolve_weapon_pickups(
    players: &mut [PlayerState],
    pickups: &mut [WeaponPickup],
) {
    for pi in 0..pickups.len() {
        if pickups[pi].respawn_timer > 0 {
            continue;
        }

        for i in 0..players.len() {
            if players[i].state_flags & player_state_flag::ALIVE == 0 {
                continue;
            }

            if player_overlaps_pickup(&players[i], &pickups[pi]) {
                let stats = weapon_stats(pickups[pi].weapon);
                players[i].weapon = Some(pickups[pi].weapon);
                players[i].ammo = stats.ammo;
                players[i].shoot_cooldown = 0;
                pickups[pi].respawn_timer = WEAPON_PICKUP_RESPAWN_TICKS;
                break; // only one player picks up per tick
            }
        }
    }
}

/// Create projectiles for a weapon shot.
/// Returns (projectiles, next_id, rng_state).
pub fn create_weapon_projectiles(
    player: &PlayerState,
    aim_x: f64,
    aim_y: f64,
    next_projectile_id: i32,
    rng_state: u32,
) -> (Vec<Projectile>, i32, u32) {
    let weapon = match player.weapon {
        Some(w) => w,
        None => return (vec![], next_projectile_id, rng_state),
    };

    let stats = weapon_stats(weapon);

    // Normalize aim vector
    let len = (aim_x * aim_x + aim_y * aim_y).sqrt();
    let (nx, ny) = if len < 0.001 {
        (player.facing as f64, 0.0)
    } else {
        (aim_x / len, aim_y / len)
    };

    // Spawn offset: edge of player hitbox in aim direction
    let spawn_x = player.x + PLAYER_WIDTH / 2.0 + nx * (PLAYER_WIDTH / 2.0);
    let spawn_y = player.y + PLAYER_HEIGHT / 2.0 + ny * (PLAYER_HEIGHT / 2.0);

    let mut projectiles = Vec::new();
    let mut id = next_projectile_id;
    let mut rng = rng_state;

    for i in 0..stats.pellets {
        let (dx, dy) = if stats.spread_deg > 0.0 && stats.pellets > 1 {
            let spread_rad = stats.spread_deg * std::f64::consts::PI / 180.0;
            let base_angle = ny.atan2(nx);
            let step_angle = (2.0 * spread_rad) / (stats.pellets as f64 - 1.0);
            let pellet_angle = base_angle - spread_rad + step_angle * i as f64;
            // PRNG jitter — matches TS: (prngNext - 0.5) * spreadRad * 0.2
            let (jitter_val, new_rng) = prng_next(rng);
            rng = new_rng;
            let jitter = (jitter_val - 0.5) * spread_rad * 0.2;
            let final_angle = pellet_angle + jitter;
            (final_angle.cos(), final_angle.sin())
        } else {
            (nx, ny)
        };

        projectiles.push(Projectile {
            id,
            owner_id: player.id,
            x: spawn_x,
            y: spawn_y,
            vx: dx * stats.speed,
            vy: dy * stats.speed,
            lifetime: stats.lifetime,
            weapon,
        });
        id += 1;
    }

    (projectiles, id, rng)
}

/// Get damage for a projectile based on its weapon type.
pub fn get_projectile_damage(proj: &Projectile) -> i32 {
    weapon_stats(proj.weapon).damage
}

/// Check if a projectile is a rocket (for splash damage).
pub fn is_rocket(proj: &Projectile) -> bool {
    proj.weapon == WeaponType::Rocket
}

/// Apply splash damage from a rocket explosion at (ex, ey).
/// Returns kills as (killer_id, victim_id) pairs.
pub fn apply_splash_damage(
    ex: f64,
    ey: f64,
    owner_id: PlayerId,
    players: &mut [PlayerState],
) -> Vec<(PlayerId, PlayerId)> {
    let stats = weapon_stats(WeaponType::Rocket);
    let radius = stats.splash_radius;
    let max_dmg = stats.splash_damage;
    let mut kills = Vec::new();

    for i in 0..players.len() {
        if players[i].state_flags & player_state_flag::ALIVE == 0 {
            continue;
        }
        if players[i].state_flags & player_state_flag::INVINCIBLE != 0 {
            continue;
        }
        if players[i].id == owner_id {
            continue;
        }

        let pcx = players[i].x + PLAYER_WIDTH / 2.0;
        let pcy = players[i].y + PLAYER_HEIGHT / 2.0;
        let dist = (pcx - ex).abs() + (pcy - ey).abs();

        if dist < radius {
            let dmg = (max_dmg as f64 * (1.0 - dist / radius)).round() as i32;
            if dmg > 0 {
                let new_health = players[i].health - dmg;
                if new_health <= 0 {
                    let victim_id = players[i].id;
                    players[i].health = 0;
                    players[i].state_flags = 0;
                    kills.push((owner_id, victim_id));
                } else {
                    players[i].health = new_health;
                }
            }
        }
    }

    kills
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::arena;

    fn test_player(id: i32, x: f64, y: f64) -> PlayerState {
        PlayerState {
            id,
            x,
            y,
            vx: 0.0,
            vy: 0.0,
            facing: facing::RIGHT,
            health: MAX_HEALTH,
            lives: INITIAL_LIVES,
            shoot_cooldown: 0,
            grounded: false,
            state_flags: player_state_flag::ALIVE,
            respawn_timer: 0,
            weapon: None,
            ammo: 0,
        }
    }

    #[test]
    fn initial_pickups_from_map() {
        let map = arena();
        let pickups = create_initial_pickups(&map);
        assert_eq!(pickups.len(), 4);
        assert_eq!(pickups[0].weapon, WeaponType::Pistol);
        assert_eq!(pickups[1].weapon, WeaponType::Shotgun);
        assert_eq!(pickups[2].weapon, WeaponType::Sniper);
        assert_eq!(pickups[3].weapon, WeaponType::Rocket);
        for p in &pickups {
            assert_eq!(p.respawn_timer, 0);
        }
    }

    #[test]
    fn pickup_timer_respawns_with_random_weapon() {
        let mut pickups = vec![WeaponPickup {
            id: 0,
            x: 100.0,
            y: 100.0,
            weapon: WeaponType::Pistol,
            respawn_timer: 1,
        }];
        let mut rng = 42u32;
        tick_pickup_timers(&mut pickups, &mut rng);
        assert_eq!(pickups[0].respawn_timer, 0);
        // Weapon should be one of the valid rotation weapons
        assert!(WEAPON_ROTATION.contains(&pickups[0].weapon));
        // RNG state should have advanced
        assert_ne!(rng, 42);
    }

    #[test]
    fn player_picks_up_weapon() {
        let mut players = vec![test_player(0, 100.0, 100.0)];
        let mut pickups = vec![WeaponPickup {
            id: 0,
            x: 112.0, // within PICKUP_RADIUS of player
            y: 116.0,
            weapon: WeaponType::Sniper,
            respawn_timer: 0,
        }];
        resolve_weapon_pickups(&mut players, &mut pickups);
        assert_eq!(players[0].weapon, Some(WeaponType::Sniper));
        assert_eq!(players[0].ammo, 3); // Sniper has 3 ammo
        assert_eq!(pickups[0].respawn_timer, WEAPON_PICKUP_RESPAWN_TICKS);
    }

    #[test]
    fn weapon_projectile_creation() {
        let mut p = test_player(0, 100.0, 200.0);
        p.weapon = Some(WeaponType::Pistol);
        p.ammo = 15;
        let (projs, next_id, _rng) = create_weapon_projectiles(&p, 1.0, 0.0, 0, 42);
        assert_eq!(projs.len(), 1);
        assert_eq!(projs[0].weapon, WeaponType::Pistol);
        assert_eq!(next_id, 1);
        // Spawn at player edge
        let expected_x = 100.0 + PLAYER_WIDTH / 2.0 + PLAYER_WIDTH / 2.0;
        assert!((projs[0].x - expected_x).abs() < 0.001);
    }

    #[test]
    fn shotgun_creates_five_pellets() {
        let mut p = test_player(0, 100.0, 200.0);
        p.weapon = Some(WeaponType::Shotgun);
        p.ammo = 6;
        let (projs, next_id, _) = create_weapon_projectiles(&p, 1.0, 0.0, 0, 42);
        assert_eq!(projs.len(), 5);
        assert_eq!(next_id, 5);
        for proj in &projs {
            assert_eq!(proj.weapon, WeaponType::Shotgun);
        }
    }

    #[test]
    fn unarmed_creates_no_projectiles() {
        let p = test_player(0, 100.0, 200.0); // weapon: None
        let (projs, next_id, _) = create_weapon_projectiles(&p, 1.0, 0.0, 0, 42);
        assert!(projs.is_empty());
        assert_eq!(next_id, 0);
    }

    #[test]
    fn splash_damage_applies() {
        let mut players = vec![
            test_player(0, 100.0, 200.0),
            test_player(1, 110.0, 200.0), // close to explosion
        ];
        // Explosion at player 1's center
        let ex = 110.0 + PLAYER_WIDTH / 2.0;
        let ey = 200.0 + PLAYER_HEIGHT / 2.0;
        let kills = apply_splash_damage(ex, ey, 0, &mut players);
        // Player 1 should take splash damage (very close, nearly full damage)
        assert!(players[1].health < MAX_HEALTH);
        // Player 0 is the owner, should not take splash
        assert_eq!(players[0].health, MAX_HEALTH);
        assert!(kills.is_empty()); // damage but not killed
    }
}
