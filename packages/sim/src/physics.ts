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
  MAX_JUMPS,
  WALL_SLIDE_SPEED,
  WALL_JUMP_VX,
  WALL_JUMP_VY,
} from "./constants";

/**
 * Accelerate/decelerate vx toward target, initiate jump (including double jump
 * and wall jump) on button edge, update facing.
 *
 * Jump is edge-triggered: fires only when Jump is pressed this tick but was
 * NOT pressed in prevInput. This prevents held-jump from continuously firing.
 */
export function applyPlayerInput(
  p: PlayerState,
  input: PlayerInput,
  prevInput: PlayerInput,
): PlayerState {
  if (!(p.stateFlags & PlayerStateFlag.Alive)) return p;

  // Target velocity from input
  let targetVx = 0;
  if (input.buttons & Button.Left) targetVx -= PLAYER_SPEED;
  if (input.buttons & Button.Right) targetVx += PLAYER_SPEED;

  // Accelerate toward target, decelerate when no input
  let vx = p.vx;
  if (targetVx !== 0) {
    if (vx < targetVx) vx = Math.min(vx + ACCELERATION, targetVx);
    else if (vx > targetVx) vx = Math.max(vx - ACCELERATION, targetVx);
  } else {
    if (vx > 0) vx = Math.max(vx - DECELERATION, 0);
    else if (vx < 0) vx = Math.min(vx + DECELERATION, 0);
  }

  let vy = p.vy;
  let jumpsLeft = p.jumpsLeft;

  // Edge-detect jump button (pressed now, not pressed last tick)
  const jumpEdge = !!(input.buttons & Button.Jump) && !(prevInput.buttons & Button.Jump);

  if (jumpEdge) {
    if (p.wallSliding && jumpsLeft > 0) {
      // Wall jump — push away from wall
      vx = WALL_JUMP_VX * (-p.wallDir);
      vy = WALL_JUMP_VY;
      jumpsLeft--;
    } else if (jumpsLeft > 0) {
      // Normal jump / double jump
      vy = JUMP_VELOCITY;
      jumpsLeft--;
    }
  }

  // Facing from aim direction
  let facing = p.facing;
  if (input.aimX > 0) facing = Facing.Right;
  else if (input.aimX < 0) facing = Facing.Left;

  return { ...p, vx, vy, facing, jumpsLeft };
}

/** Apply gravity to vy. Wall-sliding players fall at reduced speed. */
export function applyGravity(p: PlayerState): PlayerState {
  if (!(p.stateFlags & PlayerStateFlag.Alive)) return p;
  const maxFall = p.wallSliding ? WALL_SLIDE_SPEED : MAX_FALL_SPEED;
  const vy = Math.min(p.vy + GRAVITY, maxFall);
  return { ...p, vy };
}

/**
 * Integrate position and resolve collisions with platforms.
 * Platforms are one-way: only collide when falling onto the top surface.
 * Also clamp to map boundaries, detect wall contact, and manage jumpsLeft.
 */
export function moveAndCollide(
  p: PlayerState,
  map: GameMap,
  arenaLeft: number,
  arenaRight: number,
  buttons: number,
): PlayerState {
  if (!(p.stateFlags & PlayerStateFlag.Alive)) return p;

  let x = p.x + p.vx;
  let y = p.y + p.vy;
  let vy = p.vy;
  let grounded = false;

  // Platform collision (one-way: top surface only)
  for (const plat of map.platforms) {
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

  // Map boundary clamping
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

  // Wall slide detection — airborne, falling, pressing into arena boundary
  let wallSliding = false;
  let wallDir = 0;
  if (!grounded && vy > 0) {
    const pressingLeft = !!(buttons & Button.Left);
    const pressingRight = !!(buttons & Button.Right);
    if (x <= arenaLeft && pressingLeft) {
      wallSliding = true;
      wallDir = -1;
    }
    if (x + PLAYER_WIDTH >= arenaRight && pressingRight) {
      wallSliding = true;
      wallDir = 1;
    }
  }

  // Reset jumps on ground; wall contact grants 1 jump for wall-jump
  let jumpsLeft = p.jumpsLeft;
  if (grounded) {
    jumpsLeft = MAX_JUMPS;
  } else if (wallSliding && jumpsLeft === 0) {
    jumpsLeft = 1;
  }

  return { ...p, x, y, vy, grounded, wallSliding, wallDir, jumpsLeft };
}
