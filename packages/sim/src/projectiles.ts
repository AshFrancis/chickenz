import type { PlayerState, Projectile, GameMap } from "./types";
import { WeaponType, PlayerStateFlag } from "./types";
import {
  PROJECTILE_SPEED,
  PROJECTILE_LIFETIME,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
} from "./constants";
import { getProjectileDamage, isRocket, applySplashDamage } from "./weapons";

/** Spawn a projectile from a player's position toward their aim direction (legacy, unarmed fallback). */
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
    weapon: WeaponType.Pistol,
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

/** Check if a projectile is out of bounds (respects arena walls during sudden death).
 *  50px margin lets bullets visually leave the screen before despawning. */
export function isOutOfBounds(
  proj: Projectile,
  map: GameMap,
  arenaLeft: number = 0,
  arenaRight: number = map.width,
): boolean {
  const m = 50;
  return proj.x < arenaLeft - m || proj.x > arenaRight + m || proj.y < -m || proj.y > map.height + m;
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
 * - Apply per-weapon damage, track kills
 * - Rockets apply splash damage on hit
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
        const damage = getProjectileDamage(proj);
        const newHealth = p.health - damage;
        if (newHealth <= 0) {
          updatedPlayers[i] = {
            ...p,
            health: 0,
            stateFlags: 0,
          };
          kills.push({ killerId: proj.ownerId, victimId: p.id });
        } else {
          updatedPlayers[i] = { ...p, health: newHealth };
        }

        // Rocket splash damage on impact
        if (isRocket(proj)) {
          const splash = applySplashDamage(
            proj.x,
            proj.y,
            proj.ownerId,
            updatedPlayers,
          );
          updatedPlayers = splash.players;
          kills.push(...splash.kills);
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
