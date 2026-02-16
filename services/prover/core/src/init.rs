use crate::constants::*;
use crate::types::*;

/// 800x600 arena with ground + 5 floating platforms and 4 spawn points.
/// Mirrors the TypeScript ARENA map exactly.
pub fn arena() -> GameMap {
    GameMap {
        width: 800.0,
        height: 600.0,
        platforms: vec![
            // Ground
            Platform { x: 0.0, y: 568.0, width: 800.0, height: 32.0 },
            // Lower platforms
            Platform { x: 100.0, y: 450.0, width: 150.0, height: 16.0 },
            Platform { x: 550.0, y: 450.0, width: 150.0, height: 16.0 },
            // Mid platforms
            Platform { x: 300.0, y: 350.0, width: 200.0, height: 16.0 },
            // Upper platforms
            Platform { x: 50.0, y: 250.0, width: 120.0, height: 16.0 },
            Platform { x: 630.0, y: 250.0, width: 120.0, height: 16.0 },
        ],
        spawn_points: vec![
            Vec2 { x: 100.0, y: 536.0 },
            Vec2 { x: 700.0, y: 536.0 },
            Vec2 { x: 350.0, y: 318.0 },
            Vec2 { x: 400.0, y: 218.0 },
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
        });
    }

    let score = [0u32; 2];

    GameState {
        tick: 0,
        players,
        projectiles: Vec::new(),
        rng_state: config.seed,
        score,
        next_projectile_id: 0,
        arena_left: 0.0,
        arena_right: config.map.width,
        match_over: false,
        winner: -1,
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

        // Player 0 at spawn 0
        assert_eq!(state.players[0].x, 100.0);
        assert_eq!(state.players[0].y, 536.0);
        assert_eq!(state.players[0].health, MAX_HEALTH);
        assert_eq!(state.players[0].lives, INITIAL_LIVES);
        assert_eq!(state.players[0].state_flags, player_state_flag::ALIVE);

        // Player 1 at spawn 1
        assert_eq!(state.players[1].x, 700.0);
        assert_eq!(state.players[1].y, 536.0);
    }

    #[test]
    fn arena_map_structure() {
        let map = arena();
        assert_eq!(map.width, 800.0);
        assert_eq!(map.height, 600.0);
        assert_eq!(map.platforms.len(), 6);
        assert_eq!(map.spawn_points.len(), 4);
    }
}
