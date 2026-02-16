import type { PlayerState, Projectile, GameMap } from "./types";
import { PlayerStateFlag } from "./types";
import {
  PROJECTILE_SPEED,
  PROJECTILE_LIFETIME,
  PROJECTILE_DAMAGE,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
} from "./constants";

/** Spawn a projectile from a player's position toward their aim direction. */
export function spawnProjectile(
  player: PlayerState,
  aimX: number,
  aimY: number,
  id: number,
): Projectile {
  // Normalize aim vector
  const len = Math.sqrt(aimX * aimX + aimY * aimY);
  let nx: number, ny: number;
  if (len < 0.001) {
    // Default to facing direction
    nx = player.facing;
    ny = 0;
  } else {
    nx = aimX / len;
    ny = aimY / len;
  }

  return {
    id,
    ownerId: player.id,
    x: player.x + PLAYER_WIDTH / 2,
    y: player.y + PLAYER_HEIGHT / 2,
    vx: nx * PROJECTILE_SPEED,
    vy: ny * PROJECTILE_SPEED,
    lifetime: PROJECTILE_LIFETIME,
  };
}

/** Move a projectile and decrement its lifetime. */
export function moveProjectile(proj: Projectile): Projectile {
  return {
    ...proj,
    x: proj.x + proj.vx,
    y: proj.y + proj.vy,
    lifetime: proj.lifetime - 1,
  };
}

/** Check if a projectile is out of bounds. */
export function isOutOfBounds(proj: Projectile, map: GameMap): boolean {
  return proj.x < 0 || proj.x > map.width || proj.y < 0 || proj.y > map.height;
}

/** AABB point-in-rect: projectile center vs player hitbox. */
export function aabbOverlap(
  px: number,
  py: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): boolean {
  return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
}

export interface HitResult {
  readonly remainingProjectiles: readonly Projectile[];
  readonly updatedPlayers: readonly PlayerState[];
  readonly kills: readonly { killerId: number; victimId: number }[];
}

/**
 * Resolve projectile–player collisions.
 * - Skip projectile's owner
 * - Skip dead players
 * - Skip invincible players
 * - Apply damage, track kills
 */
export function resolveProjectileHits(
  projectiles: readonly Projectile[],
  players: readonly PlayerState[],
): HitResult {
  const hitProjectileIds = new Set<number>();
  let updatedPlayers = [...players];
  const kills: { killerId: number; victimId: number }[] = [];

  for (const proj of projectiles) {
    if (hitProjectileIds.has(proj.id)) continue;

    for (let i = 0; i < updatedPlayers.length; i++) {
      const p = updatedPlayers[i]!;

      // Skip owner, dead, invincible
      if (p.id === proj.ownerId) continue;
      if (!(p.stateFlags & PlayerStateFlag.Alive)) continue;
      if (p.stateFlags & PlayerStateFlag.Invincible) continue;

      if (
        aabbOverlap(proj.x, proj.y, p.x, p.y, PLAYER_WIDTH, PLAYER_HEIGHT)
      ) {
        hitProjectileIds.add(proj.id);
        const newHealth = p.health - PROJECTILE_DAMAGE;
        if (newHealth <= 0) {
          // Player dies
          updatedPlayers[i] = {
            ...p,
            health: 0,
            stateFlags: 0, // clear Alive
          };
          kills.push({ killerId: proj.ownerId, victimId: p.id });
        } else {
          updatedPlayers[i] = { ...p, health: newHealth };
        }
        break; // projectile consumed
      }
    }
  }

  const remainingProjectiles = projectiles.filter(
    (proj) => !hitProjectileIds.has(proj.id),
  );

  return { remainingProjectiles, updatedPlayers, kills };
}
