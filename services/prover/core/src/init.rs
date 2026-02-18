use crate::constants::*;
use crate::types::*;
use crate::weapons::create_initial_pickups;

/// 960x540 arena with ground + 5 floating platforms, 4 spawn points, and 4 weapon spawn points.
/// Mirrors the TypeScript ARENA map exactly.
pub fn arena() -> GameMap {
    GameMap {
        width: 960.0,
        height: 540.0,
        platforms: vec![
            // Ground
            Platform {
                x: 0.0,
                y: 508.0,
                width: 960.0,
                height: 32.0,
            },
            // Lower platforms
            Platform {
                x: 120.0,
                y: 410.0,
                width: 170.0,
                height: 16.0,
            },
            Platform {
                x: 670.0,
                y: 410.0,
                width: 170.0,
                height: 16.0,
            },
            // Mid platform
            Platform {
                x: 350.0,
                y: 310.0,
                width: 260.0,
                height: 16.0,
            },
            // Upper platforms
            Platform {
                x: 60.0,
                y: 210.0,
                width: 140.0,
                height: 16.0,
            },
            Platform {
                x: 760.0,
                y: 210.0,
                width: 140.0,
                height: 16.0,
            },
        ],
        spawn_points: vec![
            Vec2 {
                x: 120.0,
                y: 476.0,
            },
            Vec2 {
                x: 840.0,
                y: 476.0,
            },
            Vec2 {
                x: 420.0,
                y: 278.0,
            },
            Vec2 {
                x: 480.0,
                y: 178.0,
            },
        ],
        weapon_spawn_points: vec![
            Vec2 {
                x: 193.0,
                y: 378.0,
            }, // on left lower platform
            Vec2 {
                x: 743.0,
                y: 378.0,
            }, // on right lower platform
            Vec2 {
                x: 468.0,
                y: 278.0,
            }, // on mid platform
            Vec2 {
                x: 468.0,
                y: 476.0,
            }, // on ground center
        ],
    }
}

/// Create the initial game state from a match config.
pub fn create_initial_state(config: &MatchConfig) -> GameState {
    let mut players = Vec::new();
    for i in 0..config.player_count {
        let spawn_idx = i as usize % config.map.spawn_points.len();
        let spawn = &config.map.spawn_points[spawn_idx];
        players.push(PlayerState {
            id: i as i32,
            x: spawn.x,
            y: spawn.y,
            vx: 0.0,
            vy: 0.0,
            facing: facing::RIGHT,
            health: MAX_HEALTH,
            lives: config.initial_lives,
            shoot_cooldown: 0,
            grounded: false,
            state_flags: player_state_flag::ALIVE,
            respawn_timer: 0,
            weapon: None,
            ammo: 0,
        });
    }

    let weapon_pickups = create_initial_pickups(&config.map);

    GameState {
        tick: 0,
        players,
        projectiles: Vec::new(),
        weapon_pickups,
        rng_state: config.seed,
        score: [0u32; 2],
        next_projectile_id: 0,
        arena_left: 0.0,
        arena_right: config.map.width,
        match_over: false,
        winner: -1,
        death_linger_timer: 0,
    }
}

/// Default match config using the ARENA map.
pub fn default_config(seed: u32) -> MatchConfig {
    MatchConfig {
        seed,
        map: arena(),
        player_count: 2,
        tick_rate: TICK_RATE,
        initial_lives: INITIAL_LIVES,
        match_duration_ticks: MATCH_DURATION_TICKS,
        sudden_death_start_tick: SUDDEN_DEATH_START_TICK,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_state_correct() {
        let config = default_config(42);
        let state = create_initial_state(&config);
        assert_eq!(state.tick, 0);
        assert_eq!(state.players.len(), 2);
        assert_eq!(state.projectiles.len(), 0);
        assert_eq!(state.rng_state, 42);
        assert!(!state.match_over);
        assert_eq!(state.winner, -1);

        // Player 0 at spawn 0 — unarmed
        assert_eq!(state.players[0].x, 120.0);
        assert_eq!(state.players[0].y, 476.0);
        assert_eq!(state.players[0].health, MAX_HEALTH);
        assert_eq!(state.players[0].lives, INITIAL_LIVES);
        assert_eq!(state.players[0].state_flags, player_state_flag::ALIVE);
        assert_eq!(state.players[0].weapon, None);
        assert_eq!(state.players[0].ammo, 0);

        // Player 1 at spawn 1 — unarmed
        assert_eq!(state.players[1].x, 840.0);
        assert_eq!(state.players[1].y, 476.0);
        assert_eq!(state.players[1].weapon, None);
        assert_eq!(state.players[1].ammo, 0);

        // Weapon pickups created
        assert_eq!(state.weapon_pickups.len(), 4);
        assert_eq!(state.weapon_pickups[0].weapon, WeaponType::Pistol);
        assert_eq!(state.weapon_pickups[1].weapon, WeaponType::Shotgun);
        assert_eq!(state.weapon_pickups[2].weapon, WeaponType::Sniper);
        assert_eq!(state.weapon_pickups[3].weapon, WeaponType::Rocket);
    }

    #[test]
    fn arena_map_structure() {
        let map = arena();
        assert_eq!(map.width, 960.0);
        assert_eq!(map.height, 540.0);
        assert_eq!(map.platforms.len(), 6);
        assert_eq!(map.spawn_points.len(), 4);
        assert_eq!(map.weapon_spawn_points.len(), 4);
    }
}
