use crate::constants::*;
use crate::types::*;
use crate::weapons::{apply_splash_damage, get_projectile_damage, is_rocket};

/// Spawn a projectile from a player's position toward their aim direction (legacy fallback).
pub fn spawn_projectile(player: &PlayerState, aim_x: f64, aim_y: f64, id: i32) -> Projectile {
    let len = (aim_x * aim_x + aim_y * aim_y).sqrt();
    let (nx, ny) = if len < 0.001 {
        (player.facing as f64, 0.0)
    } else {
        (aim_x / len, aim_y / len)
    };

    Projectile {
        id,
        owner_id: player.id,
        x: player.x + PLAYER_WIDTH / 2.0,
        y: player.y + PLAYER_HEIGHT / 2.0,
        vx: nx * PROJECTILE_SPEED,
        vy: ny * PROJECTILE_SPEED,
        lifetime: PROJECTILE_LIFETIME,
        weapon: WeaponType::Pistol,
    }
}

/// Move a projectile and decrement its lifetime.
pub fn move_projectile(proj: &Projectile) -> Projectile {
    Projectile {
        x: proj.x + proj.vx,
        y: proj.y + proj.vy,
        lifetime: proj.lifetime - 1,
        ..*proj
    }
}

/// Check if a projectile is out of bounds (respects arena walls during sudden death).
/// 50px margin lets bullets visually leave the screen before despawning.
pub fn is_out_of_bounds(proj: &Projectile, map: &GameMap, arena_left: f64, arena_right: f64) -> bool {
    let m = 50.0;
    proj.x < arena_left - m || proj.x > arena_right + m || proj.y < -m || proj.y > map.height + m
}

/// AABB point-in-rect: projectile center vs player hitbox.
fn aabb_overlap(px: f64, py: f64, rx: f64, ry: f64, rw: f64, rh: f64) -> bool {
    px >= rx && px <= rx + rw && py >= ry && py <= ry + rh
}

pub struct ProjectileKill {
    pub killer_id: PlayerId,
    pub victim_id: PlayerId,
}

pub struct HitResult {
    pub remaining_projectiles: Vec<Projectile>,
    pub updated_players: Vec<PlayerState>,
    pub kills: Vec<ProjectileKill>,
}

/// Resolve projectile–player collisions.
/// - Skip projectile's owner
/// - Skip dead players
/// - Skip invincible players
/// - Apply per-weapon damage, track kills
/// - Rockets apply splash damage on hit
pub fn resolve_projectile_hits(
    projectiles: &[Projectile],
    players: &[PlayerState],
) -> HitResult {
    let mut hit_projectile_ids = Vec::new();
    let mut updated_players = players.to_vec();
    let mut kills = Vec::new();

    for proj in projectiles {
        if hit_projectile_ids.contains(&proj.id) {
            continue;
        }

        for i in 0..updated_players.len() {
            let p = &updated_players[i];

            // Skip owner, dead, invincible
            if p.id == proj.owner_id {
                continue;
            }
            if p.state_flags & player_state_flag::ALIVE == 0 {
                continue;
            }
            if p.state_flags & player_state_flag::INVINCIBLE != 0 {
                continue;
            }

            if aabb_overlap(proj.x, proj.y, p.x, p.y, PLAYER_WIDTH, PLAYER_HEIGHT) {
                hit_projectile_ids.push(proj.id);
                let damage = get_projectile_damage(proj);
                let victim_id = p.id;
                let new_health = p.health - damage;
                if new_health <= 0 {
                    updated_players[i].health = 0;
                    updated_players[i].state_flags = 0; // clear Alive
                    kills.push(ProjectileKill {
                        killer_id: proj.owner_id,
                        victim_id,
                    });
                } else {
                    updated_players[i].health = new_health;
                }

                // Rocket splash damage on impact
                if is_rocket(proj) {
                    let splash_kills =
                        apply_splash_damage(proj.x, proj.y, proj.owner_id, &mut updated_players);
                    for (killer, victim) in splash_kills {
                        kills.push(ProjectileKill {
                            killer_id: killer,
                            victim_id: victim,
                        });
                    }
                }

                break; // projectile consumed
            }
        }
    }

    let remaining_projectiles = projectiles
        .iter()
        .filter(|proj| !hit_projectile_ids.contains(&proj.id))
        .cloned()
        .collect();

    HitResult {
        remaining_projectiles,
        updated_players,
        kills,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alive_player(id: i32, x: f64, y: f64) -> PlayerState {
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
    fn spawn_projectile_facing_right() {
        let mut p = alive_player(0, 100.0, 200.0);
        p.weapon = Some(WeaponType::Pistol);
        p.ammo = 15;
        let proj = spawn_projectile(&p, 1.0, 0.0, 0);
        assert_eq!(proj.owner_id, 0);
        assert_eq!(proj.x, 100.0 + PLAYER_WIDTH / 2.0);
        assert_eq!(proj.y, 200.0 + PLAYER_HEIGHT / 2.0);
        assert!((proj.vx - PROJECTILE_SPEED).abs() < 0.001);
        assert!(proj.vy.abs() < 0.001);
        assert_eq!(proj.weapon, WeaponType::Pistol);
    }

    #[test]
    fn projectile_hits_enemy() {
        let p0 = alive_player(0, 100.0, 200.0);
        let p1 = alive_player(1, 100.0, 200.0); // same position, different id
        let proj = Projectile {
            id: 0,
            owner_id: 0,
            x: 110.0, // inside p1's hitbox
            y: 210.0,
            vx: PROJECTILE_SPEED,
            vy: 0.0,
            lifetime: 50,
            weapon: WeaponType::Pistol,
        };
        let result = resolve_projectile_hits(&[proj], &[p0, p1]);
        // Pistol does 20 damage
        assert_eq!(result.updated_players[1].health, MAX_HEALTH - 20);
        assert!(result.remaining_projectiles.is_empty());
    }

    #[test]
    fn projectile_skips_owner() {
        let p0 = alive_player(0, 100.0, 200.0);
        let proj = Projectile {
            id: 0,
            owner_id: 0,
            x: 110.0,
            y: 210.0,
            vx: PROJECTILE_SPEED,
            vy: 0.0,
            lifetime: 50,
            weapon: WeaponType::Pistol,
        };
        let result = resolve_projectile_hits(&[proj], &[p0]);
        assert_eq!(result.updated_players[0].health, MAX_HEALTH);
        assert_eq!(result.remaining_projectiles.len(), 1);
    }

    #[test]
    fn weapon_damage_kills() {
        let p0 = alive_player(0, 0.0, 0.0);
        let mut p1 = alive_player(1, 100.0, 200.0);
        p1.health = 20; // Pistol does 20, exactly kills

        let proj = Projectile {
            id: 0,
            owner_id: 0,
            x: 110.0,
            y: 210.0,
            vx: PROJECTILE_SPEED,
            vy: 0.0,
            lifetime: 50,
            weapon: WeaponType::Pistol,
        };
        let result = resolve_projectile_hits(&[proj], &[p0, p1]);
        assert_eq!(result.updated_players[1].health, 0);
        assert_eq!(result.updated_players[1].state_flags, 0);
        assert_eq!(result.kills.len(), 1);
        assert_eq!(result.kills[0].killer_id, 0);
        assert_eq!(result.kills[0].victim_id, 1);
    }

    #[test]
    fn sniper_does_80_damage() {
        let p0 = alive_player(0, 0.0, 0.0);
        let p1 = alive_player(1, 100.0, 200.0);
        let proj = Projectile {
            id: 0,
            owner_id: 0,
            x: 110.0,
            y: 210.0,
            vx: 16.0,
            vy: 0.0,
            lifetime: 120,
            weapon: WeaponType::Sniper,
        };
        let result = resolve_projectile_hits(&[proj], &[p0, p1]);
        assert_eq!(result.updated_players[1].health, MAX_HEALTH - 80);
    }
}
