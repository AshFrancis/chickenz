import type { PlayerState, Projectile, WeaponPickup, GameMap } from "./types";
import { WeaponType, PlayerStateFlag } from "./types";
import {
  WEAPON_STATS,
  WEAPON_PICKUP_RESPAWN_TICKS,
  WEAPON_ROTATION,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
} from "./constants";
import { prngNext } from "./prng";

/** Create initial weapon pickups from map spawn points. Uses rng to assign weapon types. */
export function createInitialPickups(
  map: GameMap,
  rngState: number,
): { pickups: WeaponPickup[]; rngState: number } {
  const pickups: WeaponPickup[] = [];
  let rng = rngState;

  for (let i = 0; i < map.weaponSpawnPoints.length; i++) {
    const sp = map.weaponSpawnPoints[i]!;
    // Cycle through weapon types deterministically
    const weapon = WEAPON_ROTATION[i % WEAPON_ROTATION.length]!;
    pickups.push({
      id: i,
      x: sp.x,
      y: sp.y,
      weapon,
      respawnTimer: 0,
    });
  }

  return { pickups, rngState: rng };
}

/** Tick pickup respawn timers and rotate weapon type when respawning. */
export function tickPickupTimers(
  pickups: readonly WeaponPickup[],
): WeaponPickup[] {
  return pickups.map((p) => {
    if (p.respawnTimer <= 0) return p;
    const newTimer = p.respawnTimer - 1;
    if (newTimer <= 0) {
      // Respawn with next weapon in rotation
      const nextWeapon = WEAPON_ROTATION[(p.weapon + 1) % WEAPON_ROTATION.length]!;
      return { ...p, respawnTimer: 0, weapon: nextWeapon };
    }
    return { ...p, respawnTimer: newTimer };
  });
}

const PICKUP_RADIUS = 16; // collision radius for pickup detection

/** Check if a player overlaps a pickup. */
function playerOverlapsPickup(p: PlayerState, pickup: WeaponPickup): boolean {
  // AABB overlap: player rect vs pickup point with radius
  const px = pickup.x;
  const py = pickup.y;
  return (
    px + PICKUP_RADIUS > p.x &&
    px - PICKUP_RADIUS < p.x + PLAYER_WIDTH &&
    py + PICKUP_RADIUS > p.y &&
    py - PICKUP_RADIUS < p.y + PLAYER_HEIGHT
  );
}

/** Resolve weapon pickups — players touching active pickups equip them. */
export function resolveWeaponPickups(
  players: readonly PlayerState[],
  pickups: readonly WeaponPickup[],
): { players: PlayerState[]; pickups: WeaponPickup[] } {
  const updatedPlayers = [...players];
  const updatedPickups = [...pickups];

  for (let pi = 0; pi < updatedPickups.length; pi++) {
    const pickup = updatedPickups[pi]!;
    if (pickup.respawnTimer > 0) continue; // inactive

    for (let i = 0; i < updatedPlayers.length; i++) {
      const p = updatedPlayers[i]!;
      if (!(p.stateFlags & PlayerStateFlag.Alive)) continue;

      if (playerOverlapsPickup(p, pickup)) {
        // Equip weapon
        const stats = WEAPON_STATS[pickup.weapon];
        updatedPlayers[i] = {
          ...p,
          weapon: pickup.weapon,
          ammo: stats.ammo,
          shootCooldown: 0,
        };
        // Put pickup on respawn timer
        updatedPickups[pi] = {
          ...pickup,
          respawnTimer: WEAPON_PICKUP_RESPAWN_TICKS,
        };
        break; // only one player picks up per tick
      }
    }
  }

  return { players: updatedPlayers, pickups: updatedPickups };
}

/**
 * Create projectiles for a weapon shot.
 * Returns new projectiles and updated rngState (for shotgun spread).
 */
export function createWeaponProjectiles(
  player: PlayerState,
  aimX: number,
  aimY: number,
  nextProjectileId: number,
  rngState: number,
): { projectiles: Projectile[]; nextId: number; rngState: number } {
  const weapon = player.weapon;
  if (weapon === null) return { projectiles: [], nextId: nextProjectileId, rngState };

  const stats = WEAPON_STATS[weapon];

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

  // Spawn offset: edge of player hitbox in aim direction
  const spawnX = player.x + PLAYER_WIDTH / 2 + nx * (PLAYER_WIDTH / 2);
  const spawnY = player.y + PLAYER_HEIGHT / 2 + ny * (PLAYER_HEIGHT / 2);

  const projectiles: Projectile[] = [];
  let id = nextProjectileId;
  let rng = rngState;

  for (let i = 0; i < stats.pellets; i++) {
    let dx = nx;
    let dy = ny;

    // Apply spread for shotgun
    if (stats.spreadDeg > 0 && stats.pellets > 1) {
      // Deterministic spread: evenly space pellets across spread arc, with slight PRNG jitter
      const spreadRad = (stats.spreadDeg * Math.PI) / 180;
      const baseAngle = Math.atan2(ny, nx);
      // Evenly spaced from -spread to +spread
      const step = (2 * spreadRad) / (stats.pellets - 1);
      const pelletAngle = baseAngle - spreadRad + step * i;
      // Add small PRNG jitter
      let jitter: number;
      [jitter, rng] = prngNext(rng);
      const jitterAngle = (jitter - 0.5) * spreadRad * 0.2; // +-10% of spread
      const finalAngle = pelletAngle + jitterAngle;
      dx = Math.cos(finalAngle);
      dy = Math.sin(finalAngle);
    }

    projectiles.push({
      id,
      ownerId: player.id,
      x: spawnX,
      y: spawnY,
      vx: dx * stats.speed,
      vy: dy * stats.speed,
      lifetime: stats.lifetime,
      weapon,
    });
    id++;
  }

  return { projectiles, nextId: id, rngState: rng };
}

/** Get damage for a projectile based on its weapon type. */
export function getProjectileDamage(proj: Projectile): number {
  return WEAPON_STATS[proj.weapon].damage;
}

/** Check if a projectile is a rocket (for splash damage). */
export function isRocket(proj: Projectile): boolean {
  return proj.weapon === WeaponType.Rocket;
}

/** Apply splash damage from a rocket explosion at (ex, ey). */
export function applySplashDamage(
  ex: number,
  ey: number,
  ownerId: number,
  players: readonly PlayerState[],
): { players: PlayerState[]; kills: { killerId: number; victimId: number }[] } {
  const stats = WEAPON_STATS[WeaponType.Rocket];
  const radius = stats.splashRadius;
  const maxDmg = stats.splashDamage;
  const updatedPlayers = [...players];
  const kills: { killerId: number; victimId: number }[] = [];

  for (let i = 0; i < updatedPlayers.length; i++) {
    const p = updatedPlayers[i]!;
    if (!(p.stateFlags & PlayerStateFlag.Alive)) continue;
    if (p.stateFlags & PlayerStateFlag.Invincible) continue;
    if (p.id === ownerId) continue; // don't splash yourself

    // Manhattan distance from explosion center to player center
    const pcx = p.x + PLAYER_WIDTH / 2;
    const pcy = p.y + PLAYER_HEIGHT / 2;
    const dist = Math.abs(pcx - ex) + Math.abs(pcy - ey);

    if (dist < radius) {
      // Linear falloff
      const dmg = Math.round(maxDmg * (1 - dist / radius));
      if (dmg > 0) {
        const newHealth = p.health - dmg;
        if (newHealth <= 0) {
          updatedPlayers[i] = { ...p, health: 0, stateFlags: 0 };
          kills.push({ killerId: ownerId, victimId: p.id });
        } else {
          updatedPlayers[i] = { ...p, health: newHealth };
        }
      }
    }
  }

  return { players: updatedPlayers, kills };
}
