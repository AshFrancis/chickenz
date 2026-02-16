use crate::constants::*;
use crate::physics::*;
use crate::prng::prng_int_range;
use crate::projectiles::*;
use crate::types::*;

/// Core deterministic transition function.
///
/// Sub-step order (mirrors TypeScript exactly):
///  0. Early return if matchOver
///  1. Resolve inputs (missing-input rule)
///  2. Tick cooldowns + invincibility
///  3. Apply player input (movement/jump/facing)
///  4. Apply gravity
///  5. Move + collide with platforms (dynamic arena bounds)
///  5b. Head stomp detection
///  6. Process shooting (spawn projectiles)
///  7. Move projectiles, remove expired/OOB
///  8. Projectile-player collision
///  9. Deaths + lives
///  10. Respawn (only if lives > 0)
///  11. Sudden death (arena walls close)
///  12. Time-up check
///  13. Update score
///  14. Advance tick
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

    let map = &config.map;
    let mut rng_state = prev.rng_state;
    let mut next_projectile_id = prev.next_projectile_id;
    let mut arena_left = prev.arena_left;
    let mut arena_right = prev.arena_right;
    let mut match_over = false;
    let mut winner = prev.winner;

    // 1. Resolve inputs — missing-input rule: reuse T-1 if absent
    // In this Rust port, inputs are always provided (no Option), so we use them directly.
    // The host is responsible for applying the missing-input rule before calling step,
    // or we treat the transcript as already resolved. For parity with TS, if buttons==0
    // and aim==0, that IS a valid input (do nothing). The missing-input rule is handled
    // at the transcript level — each tick's transcript entry is the resolved input.
    let resolved_inputs: [PlayerInput; 2] = [
        inputs[0],
        inputs[1],
    ];

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
    players = players.iter().map(|p| apply_gravity(p)).collect();

    // 5. Move + collide (with dynamic arena bounds)
    let pre_move_players = players.clone();
    players = players
        .iter()
        .map(|p| move_and_collide(p, map, arena_left, arena_right))
        .collect();

    // 5b. Head stomp detection
    let stomp_result = resolve_stomps(&players, &pre_move_players);
    players = stomp_result.players;
    let stomp_killed_ids: Vec<PlayerId> = stomp_result.kills.iter().map(|k| k.victim_id).collect();

    // 6. Process shooting
    let mut new_projectiles: Vec<Projectile> = Vec::new();
    players = players
        .iter()
        .map(|p| {
            let input = &resolved_inputs[p.id as usize];
            if p.state_flags & player_state_flag::ALIVE != 0
                && input.buttons & button::SHOOT != 0
                && p.shoot_cooldown <= 0
            {
                // Can't capture mutable next_projectile_id in closure cleanly,
                // so we handle this outside. Mark for shooting by returning cooldown.
                PlayerState {
                    shoot_cooldown: SHOOT_COOLDOWN,
                    ..*p
                }
            } else {
                *p
            }
        })
        .collect();

    // Actually spawn projectiles (need mutable access to next_projectile_id)
    for p in &players {
        let input = &resolved_inputs[p.id as usize];
        if p.state_flags & player_state_flag::ALIVE != 0
            && input.buttons & button::SHOOT != 0
            && p.shoot_cooldown == SHOOT_COOLDOWN
        {
            // This player just had their cooldown set — they're shooting this tick
            let projectile = spawn_projectile(p, input.aim_x, input.aim_y, next_projectile_id);
            next_projectile_id += 1;
            new_projectiles.push(projectile);
        }
    }

    // 7. Move projectiles, remove expired and out-of-bounds
    let mut projectiles: Vec<Projectile> = prev
        .projectiles
        .iter()
        .map(|p| move_projectile(p))
        .chain(new_projectiles)
        .filter(|proj| proj.lifetime > 0 && !is_out_of_bounds(proj, map))
        .collect();

    // 8. Projectile-player collision
    let hit_result = resolve_projectile_hits(&projectiles, &players);
    projectiles = hit_result.remaining_projectiles;
    players = hit_result.updated_players;

    // 9. Deaths + lives — decrement lives for players killed by projectiles or stomps
    let mut killed_ids: Vec<PlayerId> = hit_result.kills.iter().map(|k| k.victim_id).collect();
    for id in &stomp_killed_ids {
        if !killed_ids.contains(id) {
            killed_ids.push(*id);
        }
    }

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

    // Check elimination: if only one player has lives remaining → match over
    let players_with_lives: Vec<&PlayerState> =
        players.iter().filter(|p| p.lives > 0).collect();
    if players_with_lives.len() == 1 {
        match_over = true;
        winner = players_with_lives[0].id;
    } else if players_with_lives.is_empty() {
        match_over = true;
        winner = -1;
    }

    // 10. Respawn (only if lives > 0 and not matchOver)
    if !match_over {
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

    // 11. Sudden death — arena walls close inward
    let current_tick = prev.tick + 1;
    if !match_over && current_tick >= config.sudden_death_start_tick {
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
            match_over = true;
            winner = alive_after_sd[0].id;
        } else if alive_after_sd.is_empty() {
            // Both hit 0 lives — last player to die loses
            match_over = true;
            if let Some(other) = players.iter().find(|p| p.id != last_wall_kill_id) {
                winner = other.id;
            } else {
                winner = -1;
            }
        }

        // Arena fully closed — force end, higher lives wins
        if !match_over && progress >= 1.0 {
            match_over = true;
            let p0 = &players[0];
            let p1 = &players[1];
            if p0.lives > p1.lives {
                winner = p0.id;
            } else if p1.lives > p0.lives {
                winner = p1.id;
            } else {
                winner = -1;
            }
        }
    }

    // 12. Time-up check
    if !match_over && current_tick >= config.match_duration_ticks {
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
            winner = -1; // draw
        }
    }

    // 13. Update score (kills tracked for display)
    let mut score = prev.score;
    for kill in &hit_result.kills {
        if kill.killer_id >= 0 && (kill.killer_id as usize) < score.len() {
            score[kill.killer_id as usize] += 1;
        }
    }
    for kill in &stomp_result.kills {
        if kill.stomper_id >= 0 && (kill.stomper_id as usize) < score.len() {
            score[kill.stomper_id as usize] += 1;
        }
    }

    // 14. Advance tick
    GameState {
        tick: current_tick,
        players,
        projectiles,
        rng_state,
        score,
        next_projectile_id,
        arena_left,
        arena_right,
        match_over,
        winner,
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
        // Match ends at or before the duration limit.
        // With idle players, sudden death walls close and eliminate them before 3600.
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
        }
    }

    #[test]
    fn player_can_shoot() {
        let config = default_config(42);
        let state = create_initial_state(&config);
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
    }

    #[test]
    fn cross_validate_200tick_replay_with_ts() {
        // Expected values from TypeScript sim: bun run services/prover/cross-validate.ts
        // Same transcript generation logic as replay_determinism test.
        let config = default_config(42);
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

        let mut state = create_initial_state(&config);
        let mut prev_inputs = [NULL_INPUT; 2];
        for tick_inputs in &transcript {
            state = step(&state, tick_inputs, &prev_inputs, &config);
            prev_inputs = *tick_inputs;
            if state.match_over {
                break;
            }
        }

        // Cross-validate with TS output
        assert_eq!(state.tick, 200);
        assert!(!state.match_over);
        assert_eq!(state.winner, -1);
        assert_eq!(state.score, [0, 0]);
        assert_eq!(state.players[0].x, 160.0);
        assert_eq!(state.players[0].y, 536.0);
        assert_eq!(state.players[0].lives, 3);
        assert_eq!(state.players[0].health, 75);
        assert_eq!(state.players[1].x, 672.0);
        assert_eq!(state.players[1].y, 385.0);
        assert_eq!(state.players[1].lives, 3);
        assert_eq!(state.players[1].health, 100);
        assert_eq!(state.projectiles.len(), 7);
        assert_eq!(state.rng_state, 42);
    }

    #[test]
    fn elimination_ends_match() {
        let config = default_config(42);
        let mut state = create_initial_state(&config);
        // Set player 1 to 1 life, 1 hit from death
        state.players[1].lives = 1;
        state.players[1].health = PROJECTILE_DAMAGE;

        // Place a projectile about to hit player 1
        state.projectiles.push(Projectile {
            id: 0,
            owner_id: 0,
            x: state.players[1].x + PLAYER_WIDTH / 2.0 - PROJECTILE_SPEED,
            y: state.players[1].y + PLAYER_HEIGHT / 2.0,
            vx: PROJECTILE_SPEED,
            vy: 0.0,
            lifetime: 50,
        });
        state.next_projectile_id = 1;

        let result = step(&state, &[NULL_INPUT; 2], &[NULL_INPUT; 2], &config);
        assert!(result.match_over);
        assert_eq!(result.winner, 0);
    }
}
