use crate::constants::*;
use crate::physics::*;
use crate::prng::prng_int_range;
use crate::projectiles::*;
use crate::types::*;
use crate::weapons::{create_weapon_projectiles, resolve_weapon_pickups, tick_pickup_timers};

/// Core deterministic transition function.
///
/// Sub-step order (mirrors TypeScript exactly):
///  0. Early return if matchOver
///  1. Resolve inputs (missing-input rule)
///  2. Tick cooldowns + invincibility
///  3. Apply player input (movement/jump/facing)
///  4. Apply gravity
///  5. Move + collide with platforms (dynamic arena bounds)
///  6. Weapon pickup collision
///  7. Process shooting (spawn weapon projectiles)
///  8. Move projectiles, remove expired/OOB
///  9. Projectile-player collision
///  10. Deaths + lives
///  11. Respawn (only if lives > 0)
///  12. Sudden death (arena walls close)
///  13. Time-up check
///  14. Update score
///  15. Tick pickup respawn timers
///  16. Advance tick
pub fn step(
    prev: &GameState,
    inputs: &[PlayerInput; 2],
    _prev_inputs: &[PlayerInput; 2],
    config: &MatchConfig,
) -> GameState {
    // 0. Early return if match is already over
    if prev.match_over {
        return prev.clone();
    }

    // 0b. Death linger countdown — skip gameplay, just tick the timer
    if prev.death_linger_timer > 0 {
        let remaining = prev.death_linger_timer - 1;
        let mut s = prev.clone();
        s.tick += 1;
        if remaining <= 0 {
            s.match_over = true;
            s.death_linger_timer = 0;
        } else {
            s.death_linger_timer = remaining;
        }
        return s;
    }

    let map = &config.map;
    let mut rng_state = prev.rng_state;
    let mut next_projectile_id = prev.next_projectile_id;
    let mut arena_left = prev.arena_left;
    let mut arena_right = prev.arena_right;
    let mut match_over = false;
    let mut winner = prev.winner;
    let mut death_linger_timer: i32 = 0;

    // 1. Resolve inputs — inputs are always provided directly
    let resolved_inputs: [PlayerInput; 2] = [inputs[0], inputs[1]];

    // 2. Tick cooldowns
    let mut players: Vec<PlayerState> = prev
        .players
        .iter()
        .map(|p| {
            if p.state_flags & player_state_flag::ALIVE == 0 {
                return *p;
            }
            PlayerState {
                shoot_cooldown: (p.shoot_cooldown - 1).max(0),
                ..*p
            }
        })
        .collect();

    // Tick invincibility
    players = players
        .iter()
        .map(|p| {
            if p.state_flags & player_state_flag::ALIVE != 0
                && p.state_flags & player_state_flag::INVINCIBLE != 0
            {
                let new_timer = p.respawn_timer - 1;
                if new_timer <= 0 {
                    return PlayerState {
                        state_flags: p.state_flags & !player_state_flag::INVINCIBLE,
                        respawn_timer: 0,
                        ..*p
                    };
                }
                return PlayerState {
                    respawn_timer: new_timer,
                    ..*p
                };
            }
            *p
        })
        .collect();

    // 3. Apply player input
    players = players
        .iter()
        .map(|p| apply_player_input(p, &resolved_inputs[p.id as usize]))
        .collect();

    // 4. Apply gravity
    players = players.iter().map(apply_gravity).collect();

    // 5. Move + collide (with dynamic arena bounds)
    players = players
        .iter()
        .map(|p| move_and_collide(p, map, arena_left, arena_right))
        .collect();

    // 6. Weapon pickup collision
    let mut weapon_pickups = prev.weapon_pickups.clone();
    resolve_weapon_pickups(&mut players, &mut weapon_pickups);

    // 7. Process shooting — weapon-based
    let mut new_projectiles: Vec<Projectile> = Vec::new();
    for i in 0..players.len() {
        let input = &resolved_inputs[players[i].id as usize];
        if players[i].state_flags & player_state_flag::ALIVE != 0
            && input.buttons & button::SHOOT != 0
            && players[i].shoot_cooldown <= 0
            && players[i].weapon.is_some()
            && players[i].ammo > 0
        {
            let weapon = players[i].weapon.unwrap();
            let stats = weapon_stats(weapon);
            // Copy player to avoid borrow conflict with mutation below
            let player_copy = players[i];
            let (projs, new_id, new_rng) = create_weapon_projectiles(
                &player_copy,
                input.aim_x,
                input.aim_y,
                next_projectile_id,
                rng_state,
            );
            next_projectile_id = new_id;
            rng_state = new_rng;
            new_projectiles.extend(projs);

            let new_ammo = players[i].ammo - 1;
            players[i].shoot_cooldown = stats.cooldown;
            players[i].ammo = new_ammo;
            if new_ammo <= 0 {
                players[i].weapon = None;
            }
        }
    }

    // 8. Move projectiles, remove expired and out-of-bounds
    let mut projectiles: Vec<Projectile> = prev
        .projectiles
        .iter()
        .map(move_projectile)
        .chain(new_projectiles)
        .filter(|proj| proj.lifetime > 0 && !is_out_of_bounds(proj, map, arena_left, arena_right))
        .collect();

    // 9. Projectile-player collision
    let hit_result = resolve_projectile_hits(&projectiles, &players);
    projectiles = hit_result.remaining_projectiles;
    players = hit_result.updated_players;

    // 10. Deaths + lives — decrement lives for players killed by projectiles
    let killed_ids: Vec<PlayerId> =
        hit_result.kills.iter().map(|k| k.victim_id).collect();

    players = players
        .iter()
        .map(|p| {
            if killed_ids.contains(&p.id) {
                PlayerState {
                    lives: p.lives - 1,
                    respawn_timer: 0,
                    vx: 0.0,
                    vy: 0.0,
                    ..*p
                }
            } else {
                *p
            }
        })
        .collect();

    // Check elimination: if only one player has lives remaining → start linger
    let players_with_lives: Vec<&PlayerState> =
        players.iter().filter(|p| p.lives > 0).collect();
    if players_with_lives.len() == 1 {
        death_linger_timer = DEATH_LINGER_TICKS;
        winner = players_with_lives[0].id;
    } else if players_with_lives.is_empty() {
        death_linger_timer = DEATH_LINGER_TICKS;
        winner = 0; // P1 wins tiebreaker
    }

    // 11. Respawn (only if lives > 0 and not lingering/matchOver)
    if !match_over && death_linger_timer == 0 {
        players = players
            .iter()
            .map(|p| {
                if p.state_flags & player_state_flag::ALIVE == 0 && p.lives > 0 {
                    let new_timer = p.respawn_timer + 1;
                    if new_timer >= RESPAWN_TICKS {
                        let (spawn_idx, new_rng) = prng_int_range(
                            rng_state,
                            0,
                            map.spawn_points.len() as i32 - 1,
                        );
                        rng_state = new_rng;
                        let spawn = &map.spawn_points[spawn_idx as usize];
                        // Clamp spawn to arena bounds (important during sudden death)
                        let spawn_x =
                            arena_left.max(spawn.x.min(arena_right - PLAYER_WIDTH));
                        return PlayerState {
                            x: spawn_x,
                            y: spawn.y,
                            vx: 0.0,
                            vy: 0.0,
                            health: MAX_HEALTH,
                            state_flags: player_state_flag::ALIVE
                                | player_state_flag::INVINCIBLE,
                            respawn_timer: INVINCIBLE_TICKS,
                            shoot_cooldown: 0,
                            grounded: false,
                            weapon: None,
                            ammo: 0,
                            ..*p
                        };
                    }
                    return PlayerState {
                        respawn_timer: new_timer,
                        ..*p
                    };
                }
                *p
            })
            .collect();
    }

    // 12. Sudden death — arena walls close inward
    let current_tick = prev.tick + 1;
    if !match_over && death_linger_timer == 0 && current_tick >= config.sudden_death_start_tick {
        let duration =
            (config.match_duration_ticks - config.sudden_death_start_tick) as f64;
        let elapsed = (current_tick - config.sudden_death_start_tick) as f64;
        let progress = (elapsed / duration).min(1.0);
        let half_width = map.width / 2.0;
        arena_left = progress * half_width;
        arena_right = map.width - progress * half_width;

        // Kill players caught outside arena bounds (costs 1 life, normal respawn)
        let mut last_wall_kill_id: i32 = -1;
        players = players
            .iter()
            .map(|p| {
                if p.state_flags & player_state_flag::ALIVE == 0 {
                    return *p;
                }
                if p.x < arena_left || p.x + PLAYER_WIDTH > arena_right {
                    last_wall_kill_id = p.id;
                    return PlayerState {
                        lives: p.lives - 1,
                        health: 0,
                        state_flags: 0,
                        respawn_timer: 0,
                        vx: 0.0,
                        vy: 0.0,
                        ..*p
                    };
                }
                *p
            })
            .collect();

        // Check elimination after wall kills
        let alive_after_sd: Vec<&PlayerState> =
            players.iter().filter(|p| p.lives > 0).collect();
        if alive_after_sd.len() == 1 {
            death_linger_timer = DEATH_LINGER_TICKS;
            winner = alive_after_sd[0].id;
        } else if alive_after_sd.is_empty() {
            // Both hit 0 lives — last player to die loses
            death_linger_timer = DEATH_LINGER_TICKS;
            if let Some(other) = players.iter().find(|p| p.id != last_wall_kill_id) {
                winner = other.id;
            } else {
                winner = 0; // P1 wins tiebreaker
            }
        }

        // Arena fully closed — force end, higher lives wins
        if !match_over && death_linger_timer == 0 && progress >= 1.0 {
            match_over = true;
            let p0 = &players[0];
            let p1 = &players[1];
            if p0.lives > p1.lives {
                winner = p0.id;
            } else if p1.lives > p0.lives {
                winner = p1.id;
            } else {
                winner = 0; // P1 wins tiebreaker
            }
        }
    }

    // 13. Time-up check
    if !match_over && death_linger_timer == 0 && current_tick >= config.match_duration_ticks {
        match_over = true;
        let p0 = &players[0];
        let p1 = &players[1];
        if p0.lives > p1.lives {
            winner = p0.id;
        } else if p1.lives > p0.lives {
            winner = p1.id;
        } else if p0.health > p1.health {
            winner = p0.id;
        } else if p1.health > p0.health {
            winner = p1.id;
        } else {
            winner = 0; // P1 wins tiebreaker (no draws)
        }
    }

    // 14. Update score (kills tracked for display)
    let mut score = prev.score;
    for kill in &hit_result.kills {
        if kill.killer_id >= 0 && (kill.killer_id as usize) < score.len() {
            score[kill.killer_id as usize] += 1;
        }
    }

    // 15. Tick pickup respawn timers
    tick_pickup_timers(&mut weapon_pickups);

    // 16. Advance tick
    GameState {
        tick: current_tick,
        players,
        projectiles,
        weapon_pickups,
        rng_state,
        score,
        next_projectile_id,
        arena_left,
        arena_right,
        match_over,
        winner,
        death_linger_timer,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{create_initial_state, default_config};

    #[test]
    fn step_advances_tick() {
        let config = default_config(42);
        let state = create_initial_state(&config);
        let inputs = [NULL_INPUT; 2];
        let result = step(&state, &inputs, &inputs, &config);
        assert_eq!(result.tick, 1);
    }

    #[test]
    fn step_noop_when_match_over() {
        let config = default_config(42);
        let mut state = create_initial_state(&config);
        state.match_over = true;
        state.winner = 0;
        let inputs = [NULL_INPUT; 2];
        let result = step(&state, &inputs, &inputs, &config);
        assert_eq!(result.tick, 0); // unchanged
        assert!(result.match_over);
    }

    #[test]
    fn idle_match_ends_by_deadline() {
        let config = default_config(42);
        let mut state = create_initial_state(&config);
        let inputs = [NULL_INPUT; 2];

        // Run to completion
        for _ in 0..config.match_duration_ticks {
            if state.match_over {
                break;
            }
            let prev_inputs = inputs;
            state = step(&state, &inputs, &prev_inputs, &config);
        }

        assert!(state.match_over);
        assert!(state.tick <= config.match_duration_ticks);
    }

    #[test]
    fn replay_determinism() {
        let config = default_config(42);

        // Create a transcript with some action
        let mut transcript: Vec<[PlayerInput; 2]> = Vec::new();
        for tick in 0..200u32 {
            let p0 = PlayerInput {
                buttons: if tick % 30 < 15 {
                    button::RIGHT | button::SHOOT
                } else {
                    button::LEFT
                },
                aim_x: 1.0,
                aim_y: 0.0,
            };
            let p1 = PlayerInput {
                buttons: if tick % 20 < 10 {
                    button::LEFT | button::SHOOT
                } else {
                    button::RIGHT | button::JUMP
                },
                aim_x: -1.0,
                aim_y: 0.0,
            };
            transcript.push([p0, p1]);
        }

        // Run twice
        let run = |transcript: &Vec<[PlayerInput; 2]>| -> GameState {
            let mut state = create_initial_state(&config);
            let mut prev_inputs = [NULL_INPUT; 2];
            for tick_inputs in transcript {
                state = step(&state, tick_inputs, &prev_inputs, &config);
                prev_inputs = *tick_inputs;
                if state.match_over {
                    break;
                }
            }
            state
        };

        let result1 = run(&transcript);
        let result2 = run(&transcript);

        assert_eq!(result1.tick, result2.tick);
        assert_eq!(result1.winner, result2.winner);
        assert_eq!(result1.match_over, result2.match_over);
        assert_eq!(result1.score, result2.score);
        assert_eq!(result1.players.len(), result2.players.len());
        for (p1, p2) in result1.players.iter().zip(result2.players.iter()) {
            assert_eq!(p1.x, p2.x);
            assert_eq!(p1.y, p2.y);
            assert_eq!(p1.lives, p2.lives);
            assert_eq!(p1.health, p2.health);
            assert_eq!(p1.weapon, p2.weapon);
            assert_eq!(p1.ammo, p2.ammo);
        }
    }

    #[test]
    fn unarmed_player_cannot_shoot() {
        let config = default_config(42);
        let mut state = create_initial_state(&config);
        state.weapon_pickups.clear(); // no pickups
        let inputs = [
            PlayerInput {
                buttons: button::SHOOT,
                aim_x: 1.0,
                aim_y: 0.0,
            },
            NULL_INPUT,
        ];
        let result = step(&state, &inputs, &[NULL_INPUT; 2], &config);
        assert_eq!(result.projectiles.len(), 0);
    }

    #[test]
    fn armed_player_can_shoot() {
        let config = default_config(42);
        let mut state = create_initial_state(&config);
        // Arm player 0 with a pistol
        state.players[0].weapon = Some(WeaponType::Pistol);
        state.players[0].ammo = 15;
        state.weapon_pickups.clear();
        let inputs = [
            PlayerInput {
                buttons: button::SHOOT,
                aim_x: 1.0,
                aim_y: 0.0,
            },
            NULL_INPUT,
        ];
        let result = step(&state, &inputs, &[NULL_INPUT; 2], &config);
        assert_eq!(result.projectiles.len(), 1);
        assert_eq!(result.projectiles[0].owner_id, 0);
        assert_eq!(result.projectiles[0].weapon, WeaponType::Pistol);
    }

    #[test]
    fn ammo_depletes_and_drops_weapon() {
        let config = default_config(42);
        let mut state = create_initial_state(&config);
        state.players[0].weapon = Some(WeaponType::Pistol);
        state.players[0].ammo = 1; // last shot
        state.weapon_pickups.clear();
        let inputs = [
            PlayerInput {
                buttons: button::SHOOT,
                aim_x: 1.0,
                aim_y: 0.0,
            },
            NULL_INPUT,
        ];
        let result = step(&state, &inputs, &[NULL_INPUT; 2], &config);
        assert_eq!(result.projectiles.len(), 1);
        assert_eq!(result.players[0].weapon, None);
        assert_eq!(result.players[0].ammo, 0);
    }

    #[test]
    fn elimination_ends_match() {
        let config = default_config(42);
        let mut state = create_initial_state(&config);
        // Set player 1 to 1 life, exactly at pistol damage threshold
        state.players[1].lives = 1;
        state.players[1].health = 20; // Pistol does 20 damage
        state.weapon_pickups.clear();

        // Place a pistol projectile about to hit player 1
        state.projectiles.push(Projectile {
            id: 0,
            owner_id: 0,
            x: state.players[1].x + PLAYER_WIDTH / 2.0 - PROJECTILE_SPEED,
            y: state.players[1].y + PLAYER_HEIGHT / 2.0,
            vx: PROJECTILE_SPEED,
            vy: 0.0,
            lifetime: 50,
            weapon: WeaponType::Pistol,
        });
        state.next_projectile_id = 1;

        let result = step(&state, &[NULL_INPUT; 2], &[NULL_INPUT; 2], &config);
        // Linger starts but matchOver not yet true
        assert!(!result.match_over);
        assert!(result.death_linger_timer > 0);
        assert_eq!(result.winner, 0);

        // Advance through linger
        let mut s = result;
        while !s.match_over {
            s = step(&s, &[NULL_INPUT; 2], &[NULL_INPUT; 2], &config);
        }
        assert!(s.match_over);
        assert_eq!(s.winner, 0);
    }

    #[test]
    fn respawn_clears_weapon() {
        let config = default_config(42);
        let mut state = create_initial_state(&config);
        // Kill player 0 but leave them with lives
        state.players[0].lives = 2;
        state.players[0].health = 0;
        state.players[0].state_flags = 0;
        state.players[0].weapon = Some(WeaponType::Sniper);
        state.players[0].ammo = 3;
        state.players[0].respawn_timer = RESPAWN_TICKS - 1;
        state.weapon_pickups.clear();

        let result = step(&state, &[NULL_INPUT; 2], &[NULL_INPUT; 2], &config);
        // Player should respawn with no weapon
        assert!(result.players[0].state_flags & player_state_flag::ALIVE != 0);
        assert_eq!(result.players[0].weapon, None);
        assert_eq!(result.players[0].ammo, 0);
    }
}
