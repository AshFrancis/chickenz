import type {
  GameState,
  PlayerState,
  Projectile,
  PlayerInput,
  InputMap,
  MatchConfig,
  PlayerId,
} from "./types";
import { NULL_INPUT, Button, PlayerStateFlag } from "./types";
import {
  SHOOT_COOLDOWN,
  RESPAWN_TICKS,
  INVINCIBLE_TICKS,
  MAX_HEALTH,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  WEAPON_STATS,
  DEATH_LINGER_TICKS,
} from "./constants";
import { applyPlayerInput, applyGravity, moveAndCollide } from "./physics";
import {
  moveProjectile,
  isOutOfBounds,
  resolveProjectileHits,
} from "./projectiles";
import { prngIntRange } from "./prng";
import {
  tickPickupTimers,
  resolveWeaponPickups,
  createWeaponProjectiles,
} from "./weapons";

/**
 * Core deterministic transition function.
 *
 * Sub-step order:
 *  0. Early return if matchOver
 *  1. Resolve inputs (missing-input rule)
 *  2. Tick cooldowns + invincibility
 *  3. Apply player input (movement/jump/facing)
 *  4. Apply gravity
 *  5. Move + collide with platforms (dynamic arena bounds)
 *  6. Weapon pickup collision
 *  7. Process shooting (spawn projectiles)
 *  8. Move projectiles, remove expired/OOB
 *  9. Projectile-player collision
 * 10. Deaths + lives
 * 11. Respawn (only if lives > 0)
 * 12. Sudden death (arena walls close)
 * 13. Time-up check
 * 14. Update score
 * 15. Tick pickup respawn timers
 * 16. Advance tick
 */
export function step(
  prev: GameState,
  inputs: InputMap,
  prevInputs: InputMap,
  config: MatchConfig,
): GameState {
  // 0. Early return if match is already over
  if (prev.matchOver) return prev;

  // 0b. Death linger countdown — skip gameplay, just tick the timer
  if (prev.deathLingerTimer > 0) {
    const remaining = prev.deathLingerTimer - 1;
    if (remaining <= 0) {
      return { ...prev, tick: prev.tick + 1, matchOver: true, deathLingerTimer: 0 };
    }
    return { ...prev, tick: prev.tick + 1, deathLingerTimer: remaining };
  }

  const map = config.map;
  const currentTick = prev.tick + 1;
  let rngState = prev.rngState;
  let nextProjectileId = prev.nextProjectileId;
  let arenaLeft = prev.arenaLeft;
  let arenaRight = prev.arenaRight;
  let matchOver = false;
  let winner = prev.winner;
  let deathLingerTimer = 0;

  // 1. Resolve inputs — missing-input rule: reuse T-1 if absent
  const resolvedInputs = new Map<PlayerId, PlayerInput>();
  for (const p of prev.players) {
    const input = inputs.get(p.id) ?? prevInputs.get(p.id) ?? NULL_INPUT;
    resolvedInputs.set(p.id, input);
  }

  // 2. Tick cooldowns
  let players: PlayerState[] = prev.players.map((p) => {
    if (!(p.stateFlags & PlayerStateFlag.Alive)) return p;
    return {
      ...p,
      shootCooldown: Math.max(0, p.shootCooldown - 1),
    };
  });

  // Tick invincibility
  players = players.map((p) => {
    if (
      p.stateFlags & PlayerStateFlag.Alive &&
      p.stateFlags & PlayerStateFlag.Invincible
    ) {
      const newTimer = p.respawnTimer - 1;
      if (newTimer <= 0) {
        return {
          ...p,
          stateFlags: p.stateFlags & ~PlayerStateFlag.Invincible,
          respawnTimer: 0,
        };
      }
      return { ...p, respawnTimer: newTimer };
    }
    return p;
  });

  // 3. Apply player input (with prevInput for jump edge detection)
  players = players.map((p) => {
    const input = resolvedInputs.get(p.id)!;
    const prevInput = prevInputs.get(p.id) ?? NULL_INPUT;
    return applyPlayerInput(p, input, prevInput);
  });

  // 4. Apply gravity
  players = players.map(applyGravity);

  // 5. Move + collide (with dynamic arena bounds + wall slide detection)
  players = players.map((p) => {
    const input = resolvedInputs.get(p.id)!;
    return moveAndCollide(p, map, arenaLeft, arenaRight, input.buttons);
  });

  // 6. Weapon pickup collision
  let weaponPickups = [...prev.weaponPickups];
  const pickupResult = resolveWeaponPickups(players, weaponPickups);
  players = pickupResult.players;
  weaponPickups = pickupResult.pickups;

  // 7. Process shooting
  let newProjectiles: Projectile[] = [];
  players = players.map((p) => {
    const input = resolvedInputs.get(p.id)!;
    if (
      p.stateFlags & PlayerStateFlag.Alive &&
      input.buttons & Button.Shoot &&
      p.shootCooldown <= 0 &&
      p.weapon !== null &&
      p.ammo > 0
    ) {
      const stats = WEAPON_STATS[p.weapon];
      const result = createWeaponProjectiles(
        p,
        input.aimX,
        input.aimY,
        nextProjectileId,
        rngState,
      );
      nextProjectileId = result.nextId;
      rngState = result.rngState;
      newProjectiles.push(...result.projectiles);

      const newAmmo = p.ammo - 1;
      return {
        ...p,
        shootCooldown: stats.cooldown,
        ammo: newAmmo,
        // Drop weapon when ammo depleted
        weapon: newAmmo <= 0 ? null : p.weapon,
      };
    }
    return p;
  });

  // 8. Move projectiles, remove expired and out-of-bounds
  let projectiles: Projectile[] = [
    ...prev.projectiles.map(moveProjectile),
    ...newProjectiles,
  ];
  projectiles = projectiles.filter(
    (proj) => proj.lifetime > 0 && !isOutOfBounds(proj, map, arenaLeft, arenaRight),
  );

  // 9. Projectile-player collision
  const hitResult = resolveProjectileHits(projectiles, players);
  projectiles = [...hitResult.remainingProjectiles];
  players = [...hitResult.updatedPlayers];

  // 10. Deaths + lives — decrement lives for players killed by projectiles
  const killedIds = new Set(hitResult.kills.map((k) => k.victimId));
  players = players.map((p) => {
    if (killedIds.has(p.id)) {
      const newLives = p.lives - 1;
      return {
        ...p,
        lives: newLives,
        respawnTimer: 0,
        vx: 0,
        vy: 0,
      };
    }
    return p;
  });

  // Check elimination: if only one player has lives remaining → start linger
  const playersWithLives = players.filter((p) => p.lives > 0);
  if (playersWithLives.length === 1) {
    deathLingerTimer = DEATH_LINGER_TICKS;
    winner = playersWithLives[0]!.id;
  } else if (playersWithLives.length === 0) {
    // Both ran out of lives simultaneously — P1 wins tiebreaker
    deathLingerTimer = DEATH_LINGER_TICKS;
    winner = 0;
  }

  // 11. Respawn (only if lives > 0 and not lingering/matchOver)
  if (!matchOver && deathLingerTimer === 0) {
    const inSuddenDeath = currentTick >= config.suddenDeathStartTick;
    players = players.map((p) => {
      if (!(p.stateFlags & PlayerStateFlag.Alive) && p.lives > 0) {
        const newTimer = p.respawnTimer + 1;
        if (newTimer >= RESPAWN_TICKS) {
          let spawnX: number;
          let spawnY: number;

          if (inSuddenDeath) {
            const arenaMid = (arenaLeft + arenaRight) / 2;
            const offset = p.id === 0 ? -30 : 30;
            spawnX = Math.max(arenaLeft, Math.min(arenaMid + offset - PLAYER_WIDTH / 2, arenaRight - PLAYER_WIDTH));
            spawnY = map.platforms[0]!.y - PLAYER_HEIGHT;
          } else {
            let spawnIdx: number;
            [spawnIdx, rngState] = prngIntRange(
              rngState,
              0,
              map.spawnPoints.length - 1,
            );
            const spawn = map.spawnPoints[spawnIdx]!;
            spawnX = Math.max(arenaLeft, Math.min(spawn.x, arenaRight - PLAYER_WIDTH));
            spawnY = spawn.y;
          }

          return {
            ...p,
            x: spawnX,
            y: spawnY,
            vx: 0,
            vy: 0,
            health: MAX_HEALTH,
            stateFlags: PlayerStateFlag.Alive | PlayerStateFlag.Invincible,
            respawnTimer: INVINCIBLE_TICKS,
            shootCooldown: 0,
            grounded: false,
            weapon: null,
            ammo: 0,
            jumpsLeft: 2,
            wallSliding: false,
            wallDir: 0,
          };
        }
        return { ...p, respawnTimer: newTimer };
      }
      return p;
    });
  }

  // 12. Sudden death — arena walls close inward
  if (!matchOver && deathLingerTimer === 0 && currentTick >= config.suddenDeathStartTick) {
    const duration = config.matchDurationTicks - config.suddenDeathStartTick;
    const elapsed = currentTick - config.suddenDeathStartTick;
    const progress = Math.min(elapsed / duration, 1);
    const halfWidth = map.width / 2;
    arenaLeft = progress * halfWidth;
    arenaRight = map.width - progress * halfWidth;

    // Kill players caught outside arena bounds
    let lastWallKillId = -1;
    players = players.map((p) => {
      if (!(p.stateFlags & PlayerStateFlag.Alive)) return p;
      if (p.x < arenaLeft || p.x + PLAYER_WIDTH > arenaRight) {
        lastWallKillId = p.id;
        return {
          ...p,
          lives: p.lives - 1,
          health: 0,
          stateFlags: 0,
          respawnTimer: 0,
          vx: 0,
          vy: 0,
        };
      }
      return p;
    });

    // Check elimination after wall kills
    const aliveAfterSD = players.filter((p) => p.lives > 0);
    if (aliveAfterSD.length === 1) {
      deathLingerTimer = DEATH_LINGER_TICKS;
      winner = aliveAfterSD[0]!.id;
    } else if (aliveAfterSD.length === 0) {
      deathLingerTimer = DEATH_LINGER_TICKS;
      const other = players.find((p) => p.id !== lastWallKillId);
      winner = other ? other.id : 0;
    }

    // Arena fully closed
    if (!matchOver && deathLingerTimer === 0 && progress >= 1) {
      matchOver = true;
      const p0 = players[0]!;
      const p1 = players[1]!;
      if (p0.lives > p1.lives) winner = p0.id;
      else if (p1.lives > p0.lives) winner = p1.id;
      else winner = 0;
    }
  }

  // 13. Time-up check
  if (!matchOver && deathLingerTimer === 0 && currentTick >= config.matchDurationTicks) {
    matchOver = true;
    const p0 = players[0]!;
    const p1 = players[1]!;
    if (p0.lives > p1.lives) {
      winner = p0.id;
    } else if (p1.lives > p0.lives) {
      winner = p1.id;
    } else if (p0.health > p1.health) {
      winner = p0.id;
    } else if (p1.health > p0.health) {
      winner = p1.id;
    } else {
      winner = 0;
    }
  }

  // 14. Update score
  const score = new Map(prev.score);
  for (const kill of hitResult.kills) {
    score.set(kill.killerId, (score.get(kill.killerId) ?? 0) + 1);
  }

  // 15. Tick pickup respawn timers
  weaponPickups = tickPickupTimers(weaponPickups);

  // 16. Advance tick
  return {
    tick: currentTick,
    players,
    projectiles,
    weaponPickups,
    rngState,
    score,
    nextProjectileId,
    arenaLeft,
    arenaRight,
    matchOver,
    winner,
    deathLingerTimer,
  };
}
