import type { PlayerState, PlayerInput, GameMap } from "./types";
import type { PlayerId } from "./types";
import { Button, Facing, PlayerStateFlag } from "./types";
import {
  PLAYER_SPEED,
  ACCELERATION,
  DECELERATION,
  JUMP_VELOCITY,
  GRAVITY,
  MAX_FALL_SPEED,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
} from "./constants";

/** Accelerate/decelerate vx toward target, initiate jump if grounded, update facing. */
export function applyPlayerInput(
  p: PlayerState,
  input: PlayerInput,
): PlayerState {
  if (!(p.stateFlags & PlayerStateFlag.Alive)) return p;

  // Target velocity from input
  let targetVx = 0;
  if (input.buttons & Button.Left) targetVx -= PLAYER_SPEED;
  if (input.buttons & Button.Right) targetVx += PLAYER_SPEED;

  // Accelerate toward target, decelerate when no input
  let vx = p.vx;
  if (targetVx !== 0) {
    // Accelerate toward target
    if (vx < targetVx) vx = Math.min(vx + ACCELERATION, targetVx);
    else if (vx > targetVx) vx = Math.max(vx - ACCELERATION, targetVx);
  } else {
    // Decelerate toward 0
    if (vx > 0) vx = Math.max(vx - DECELERATION, 0);
    else if (vx < 0) vx = Math.min(vx + DECELERATION, 0);
  }

  let vy = p.vy;
  if (input.buttons & Button.Jump && p.grounded) {
    vy = JUMP_VELOCITY;
  }

  // Facing from aim direction (if aim has horizontal component)
  let facing = p.facing;
  if (input.aimX > 0) facing = Facing.Right;
  else if (input.aimX < 0) facing = Facing.Left;

  return { ...p, vx, vy, facing };
}

/** Apply gravity to vy, clamped to MAX_FALL_SPEED. */
export function applyGravity(p: PlayerState): PlayerState {
  if (!(p.stateFlags & PlayerStateFlag.Alive)) return p;
  const vy = Math.min(p.vy + GRAVITY, MAX_FALL_SPEED);
  return { ...p, vy };
}

/**
 * Integrate position and resolve collisions with platforms.
 * Platforms are one-way: only collide when falling onto the top surface.
 * Also clamp to map boundaries.
 */
export function moveAndCollide(
  p: PlayerState,
  map: GameMap,
  arenaLeft: number,
  arenaRight: number,
): PlayerState {
  if (!(p.stateFlags & PlayerStateFlag.Alive)) return p;

  let x = p.x + p.vx;
  let y = p.y + p.vy;
  let vy = p.vy;
  let grounded = false;

  // Platform collision (one-way: top surface only)
  for (const plat of map.platforms) {
    // Player feet were above or at platform top before move, and now at or below
    const feetBefore = p.y + PLAYER_HEIGHT;
    const feetAfter = y + PLAYER_HEIGHT;
    const platTop = plat.y;

    if (
      feetBefore <= platTop &&
      feetAfter >= platTop &&
      x + PLAYER_WIDTH > plat.x &&
      x < plat.x + plat.width
    ) {
      y = platTop - PLAYER_HEIGHT;
      vy = 0;
      grounded = true;
    }
  }

  // Map boundary clamping (uses dynamic arena bounds for left/right)
  if (x < arenaLeft) x = arenaLeft;
  if (x + PLAYER_WIDTH > arenaRight) x = arenaRight - PLAYER_WIDTH;
  if (y < 0) {
    y = 0;
    vy = 0;
  }
  if (y + PLAYER_HEIGHT > map.height) {
    y = map.height - PLAYER_HEIGHT;
    vy = 0;
    grounded = true;
  }

  return { ...p, x, y, vy, grounded };
}

