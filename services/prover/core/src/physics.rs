use crate::constants::*;
use crate::types::*;

/// Accelerate/decelerate vx toward target, initiate jump if grounded, update facing.
pub fn apply_player_input(p: &PlayerState, input: &PlayerInput) -> PlayerState {
    if p.state_flags & player_state_flag::ALIVE == 0 {
        return *p;
    }

    // Target velocity from input
    let mut target_vx: f64 = 0.0;
    if input.buttons & button::LEFT != 0 {
        target_vx -= PLAYER_SPEED;
    }
    if input.buttons & button::RIGHT != 0 {
        target_vx += PLAYER_SPEED;
    }

    // Accelerate toward target, decelerate when no input
    let mut vx = p.vx;
    if target_vx != 0.0 {
        if vx < target_vx {
            vx = (vx + ACCELERATION).min(target_vx);
        } else if vx > target_vx {
            vx = (vx - ACCELERATION).max(target_vx);
        }
    } else {
        if vx > 0.0 {
            vx = (vx - DECELERATION).max(0.0);
        } else if vx < 0.0 {
            vx = (vx + DECELERATION).min(0.0);
        }
    }

    let mut vy = p.vy;
    if input.buttons & button::JUMP != 0 && p.grounded {
        vy = JUMP_VELOCITY;
    }

    // Facing from aim direction
    let mut f = p.facing;
    if input.aim_x > 0.0 {
        f = facing::RIGHT;
    } else if input.aim_x < 0.0 {
        f = facing::LEFT;
    }

    PlayerState {
        vx,
        vy,
        facing: f,
        ..*p
    }
}

/// Apply gravity to vy, clamped to MAX_FALL_SPEED.
pub fn apply_gravity(p: &PlayerState) -> PlayerState {
    if p.state_flags & player_state_flag::ALIVE == 0 {
        return *p;
    }
    let vy = (p.vy + GRAVITY).min(MAX_FALL_SPEED);
    PlayerState { vy, ..*p }
}

/// Integrate position and resolve collisions with platforms.
/// Platforms are one-way: only collide when falling onto the top surface.
/// Also clamp to map boundaries and dynamic arena bounds.
pub fn move_and_collide(
    p: &PlayerState,
    map: &GameMap,
    arena_left: f64,
    arena_right: f64,
) -> PlayerState {
    if p.state_flags & player_state_flag::ALIVE == 0 {
        return *p;
    }

    let mut x = p.x + p.vx;
    let mut y = p.y + p.vy;
    let mut vy = p.vy;
    let mut grounded = false;

    // Platform collision (one-way: top surface only)
    for plat in &map.platforms {
        let feet_before = p.y + PLAYER_HEIGHT;
        let feet_after = y + PLAYER_HEIGHT;
        let plat_top = plat.y;

        if feet_before <= plat_top
            && feet_after >= plat_top
            && x + PLAYER_WIDTH > plat.x
            && x < plat.x + plat.width
        {
            y = plat_top - PLAYER_HEIGHT;
            vy = 0.0;
            grounded = true;
        }
    }

    // Map boundary clamping (uses dynamic arena bounds for left/right)
    if x < arena_left {
        x = arena_left;
    }
    if x + PLAYER_WIDTH > arena_right {
        x = arena_right - PLAYER_WIDTH;
    }
    if y < 0.0 {
        y = 0.0;
        vy = 0.0;
    }
    if y + PLAYER_HEIGHT > map.height {
        y = map.height - PLAYER_HEIGHT;
        vy = 0.0;
        grounded = true;
    }

    PlayerState {
        x,
        y,
        vy,
        grounded,
        ..*p
    }
}

pub struct StompKill {
    pub stomper_id: PlayerId,
    pub victim_id: PlayerId,
}

pub struct StompResult {
    pub players: Vec<PlayerState>,
    pub kills: Vec<StompKill>,
}

/// Detect head stomps: a player falling onto another player's head.
/// Stomper must be falling (vy >= threshold), feet land on victim's head.
/// Victim dies, stomper bounces up.
pub fn resolve_stomps(players: &[PlayerState], prev_players: &[PlayerState]) -> StompResult {
    let mut updated = players.to_vec();
    let mut kills = Vec::new();

    for i in 0..updated.len() {
        if updated[i].state_flags & player_state_flag::ALIVE == 0 {
            continue;
        }

        let prev_stomper = &prev_players[i];
        if prev_stomper.vy < STOMP_VELOCITY_THRESHOLD {
            continue;
        }

        let stomper_feet = updated[i].y + PLAYER_HEIGHT;
        let prev_stomper_feet = prev_stomper.y + PLAYER_HEIGHT;

        for j in 0..updated.len() {
            if i == j {
                continue;
            }
            let victim = &updated[j];
            if victim.state_flags & player_state_flag::ALIVE == 0 {
                continue;
            }
            if victim.state_flags & player_state_flag::INVINCIBLE != 0 {
                continue;
            }

            let victim_top = victim.y;

            if prev_stomper_feet <= victim_top
                && stomper_feet >= victim_top
                && updated[i].x + PLAYER_WIDTH > victim.x
                && updated[i].x < victim.x + PLAYER_WIDTH
            {
                let stomper_id = updated[i].id;
                let victim_id = updated[j].id;

                // Kill victim
                updated[j].health = 0;
                updated[j].state_flags = 0;

                // Bounce stomper
                updated[i].vy = STOMP_BOUNCE;
                updated[i].y = victim_top - PLAYER_HEIGHT;
                updated[i].grounded = false;

                kills.push(StompKill {
                    stomper_id,
                    victim_id,
                });
                break; // one stomp per stomper per tick
            }
        }
    }

    StompResult {
        players: updated,
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
        }
    }

    #[test]
    fn input_moves_right() {
        let p = alive_player(0, 100.0, 100.0);
        let input = PlayerInput {
            buttons: button::RIGHT,
            aim_x: 1.0,
            aim_y: 0.0,
        };
        let result = apply_player_input(&p, &input);
        assert!(result.vx > 0.0);
        assert_eq!(result.facing, facing::RIGHT);
    }

    #[test]
    fn input_moves_left() {
        let p = alive_player(0, 100.0, 100.0);
        let input = PlayerInput {
            buttons: button::LEFT,
            aim_x: -1.0,
            aim_y: 0.0,
        };
        let result = apply_player_input(&p, &input);
        assert!(result.vx < 0.0);
        assert_eq!(result.facing, facing::LEFT);
    }

    #[test]
    fn gravity_increases_vy() {
        let p = alive_player(0, 100.0, 100.0);
        let result = apply_gravity(&p);
        assert_eq!(result.vy, GRAVITY);
    }

    #[test]
    fn gravity_caps_at_max() {
        let mut p = alive_player(0, 100.0, 100.0);
        p.vy = MAX_FALL_SPEED;
        let result = apply_gravity(&p);
        assert_eq!(result.vy, MAX_FALL_SPEED);
    }

    #[test]
    fn dead_player_not_affected() {
        let mut p = alive_player(0, 100.0, 100.0);
        p.state_flags = 0; // dead
        let input = PlayerInput {
            buttons: button::RIGHT | button::JUMP,
            aim_x: 1.0,
            aim_y: 0.0,
        };
        let result = apply_player_input(&p, &input);
        assert_eq!(result.vx, 0.0);
        assert_eq!(result.vy, 0.0);
    }

    #[test]
    fn jump_only_when_grounded() {
        let mut p = alive_player(0, 100.0, 100.0);
        p.grounded = true;
        let input = PlayerInput {
            buttons: button::JUMP,
            aim_x: 0.0,
            aim_y: 0.0,
        };
        let result = apply_player_input(&p, &input);
        assert_eq!(result.vy, JUMP_VELOCITY);

        // Not grounded — no jump
        let mut p2 = alive_player(0, 100.0, 100.0);
        p2.grounded = false;
        let result2 = apply_player_input(&p2, &input);
        assert_eq!(result2.vy, 0.0);
    }
}
