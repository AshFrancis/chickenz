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
  STOMP_VELOCITY_THRESHOLD,
  STOMP_BOUNCE,
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

export interface StompResult {
  readonly players: readonly PlayerState[];
  readonly kills: readonly { stomperId: PlayerId; victimId: PlayerId }[];
}

/**
 * Detect head stomps: a player falling onto another player's head.
 * Stomper must be falling (vy >= STOMP_VELOCITY_THRESHOLD), feet land on victim's head.
 * Victim dies, stomper bounces up.
 */
export function resolveStomps(
  players: readonly PlayerState[],
  prevPlayers: readonly PlayerState[],
): StompResult {
  const updated = [...players];
  const kills: { stomperId: PlayerId; victimId: PlayerId }[] = [];

  for (let i = 0; i < updated.length; i++) {
    const stomper = updated[i]!;
    if (!(stomper.stateFlags & PlayerStateFlag.Alive)) continue;

    const prevStomper = prevPlayers[i]!;
    // Must be falling
    if (prevStomper.vy < STOMP_VELOCITY_THRESHOLD) continue;

    const stomperFeet = stomper.y + PLAYER_HEIGHT;
    const prevStomperFeet = prevStomper.y + PLAYER_HEIGHT;

    for (let j = 0; j < updated.length; j++) {
      if (i === j) continue;
      const victim = updated[j]!;
      if (!(victim.stateFlags & PlayerStateFlag.Alive)) continue;
      if (victim.stateFlags & PlayerStateFlag.Invincible) continue;

      const victimTop = victim.y;

      // Stomper's feet crossed victim's head this tick and overlaps horizontally
      if (
        prevStomperFeet <= victimTop &&
        stomperFeet >= victimTop &&
        stomper.x + PLAYER_WIDTH > victim.x &&
        stomper.x < victim.x + PLAYER_WIDTH
      ) {
        // Kill victim
        updated[j] = {
          ...victim,
          health: 0,
          stateFlags: 0,
        };
        // Bounce stomper
        updated[i] = {
          ...updated[i]!,
          vy: STOMP_BOUNCE,
          y: victimTop - PLAYER_HEIGHT,
          grounded: false,
        };
        kills.push({ stomperId: stomper.id, victimId: victim.id });
        break; // one stomp per stomper per tick
      }
    }
  }

  return { players: updated, kills };
}
