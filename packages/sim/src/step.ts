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
} from "./constants";
import { applyPlayerInput, applyGravity, moveAndCollide, resolveStomps } from "./physics";
import {
  spawnProjectile,
  moveProjectile,
  isOutOfBounds,
  resolveProjectileHits,
} from "./projectiles";
import { prngIntRange } from "./prng";

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
 *  6. Process shooting (spawn projectiles)
 *  7. Move projectiles, remove expired/OOB
 *  8. Projectile-player collision
 *  9. Deaths + lives
 * 10. Respawn (only if lives > 0)
 * 11. Sudden death (arena walls close)
 * 12. Time-up check
 * 13. Update score
 * 14. Advance tick
 */
export function step(
  prev: GameState,
  inputs: InputMap,
  prevInputs: InputMap,
  config: MatchConfig,
): GameState {
  // 0. Early return if match is already over
  if (prev.matchOver) return prev;

  const map = config.map;
  let rngState = prev.rngState;
  let nextProjectileId = prev.nextProjectileId;
  let arenaLeft = prev.arenaLeft;
  let arenaRight = prev.arenaRight;
  let matchOver = false;
  let winner = prev.winner;

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

  // 3. Apply player input
  players = players.map((p) => applyPlayerInput(p, resolvedInputs.get(p.id)!));

  // 4. Apply gravity
  players = players.map(applyGravity);

  // 5. Move + collide (with dynamic arena bounds)
  const preMovePlayers = players;
  players = players.map((p) => moveAndCollide(p, map, arenaLeft, arenaRight));

  // 5b. Head stomp detection
  const stompResult = resolveStomps(players, preMovePlayers);
  players = [...stompResult.players];
  const stompKilledIds = new Set(stompResult.kills.map((k) => k.victimId));

  // 6. Process shooting
  let newProjectiles: Projectile[] = [];
  players = players.map((p) => {
    const input = resolvedInputs.get(p.id)!;
    if (
      p.stateFlags & PlayerStateFlag.Alive &&
      input.buttons & Button.Shoot &&
      p.shootCooldown <= 0
    ) {
      const projectile = spawnProjectile(p, input.aimX, input.aimY, nextProjectileId);
      nextProjectileId++;
      newProjectiles.push(projectile);
      return { ...p, shootCooldown: SHOOT_COOLDOWN };
    }
    return p;
  });

  // 7. Move projectiles, remove expired and out-of-bounds
  let projectiles: Projectile[] = [
    ...prev.projectiles.map(moveProjectile),
    ...newProjectiles,
  ];
  projectiles = projectiles.filter(
    (proj) => proj.lifetime > 0 && !isOutOfBounds(proj, map),
  );

  // 8. Projectile-player collision
  const hitResult = resolveProjectileHits(projectiles, players);
  projectiles = [...hitResult.remainingProjectiles];
  players = [...hitResult.updatedPlayers];

  // 9. Deaths + lives — decrement lives for players killed by projectiles or stomps
  const killedIds = new Set([
    ...hitResult.kills.map((k) => k.victimId),
    ...stompResult.kills.map((k) => k.victimId),
  ]);
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

  // Check elimination: if only one player has lives remaining → match over
  const playersWithLives = players.filter((p) => p.lives > 0);
  if (playersWithLives.length === 1) {
    matchOver = true;
    winner = playersWithLives[0]!.id;
  } else if (playersWithLives.length === 0) {
    // Both ran out of lives simultaneously
    matchOver = true;
    winner = -1;
  }

  // 10. Respawn (only if lives > 0 and not matchOver)
  if (!matchOver) {
    players = players.map((p) => {
      if (!(p.stateFlags & PlayerStateFlag.Alive) && p.lives > 0) {
        const newTimer = p.respawnTimer + 1;
        if (newTimer >= RESPAWN_TICKS) {
          let spawnIdx: number;
          [spawnIdx, rngState] = prngIntRange(
            rngState,
            0,
            map.spawnPoints.length - 1,
          );
          const spawn = map.spawnPoints[spawnIdx]!;
          // Clamp spawn to arena bounds (important during sudden death)
          const spawnX = Math.max(arenaLeft, Math.min(spawn.x, arenaRight - PLAYER_WIDTH));
          return {
            ...p,
            x: spawnX,
            y: spawn.y,
            vx: 0,
            vy: 0,
            health: MAX_HEALTH,
            stateFlags: PlayerStateFlag.Alive | PlayerStateFlag.Invincible,
            respawnTimer: INVINCIBLE_TICKS,
            shootCooldown: 0,
            grounded: false,
          };
        }
        return { ...p, respawnTimer: newTimer };
      }
      return p;
    });
  }

  // 11. Sudden death — arena walls close inward
  const currentTick = prev.tick + 1; // tick we're computing
  if (!matchOver && currentTick >= config.suddenDeathStartTick) {
    const duration = config.matchDurationTicks - config.suddenDeathStartTick;
    const elapsed = currentTick - config.suddenDeathStartTick;
    const progress = Math.min(elapsed / duration, 1);
    const halfWidth = map.width / 2;
    arenaLeft = progress * halfWidth;
    arenaRight = map.width - progress * halfWidth;

    // Kill players caught outside arena bounds (costs 1 life, normal respawn)
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
      matchOver = true;
      winner = aliveAfterSD[0]!.id;
    } else if (aliveAfterSD.length === 0) {
      // Both hit 0 lives — last player to die loses
      matchOver = true;
      const other = players.find((p) => p.id !== lastWallKillId);
      winner = other ? other.id : -1;
    }

    // Arena fully closed — force end, higher lives wins
    if (!matchOver && progress >= 1) {
      matchOver = true;
      const p0 = players[0]!;
      const p1 = players[1]!;
      if (p0.lives > p1.lives) winner = p0.id;
      else if (p1.lives > p0.lives) winner = p1.id;
      else winner = -1;
    }
  }

  // 12. Time-up check
  if (!matchOver && currentTick >= config.matchDurationTicks) {
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
      winner = -1; // draw
    }
  }

  // 13. Update score (kills still tracked for display)
  const score = new Map(prev.score);
  for (const kill of hitResult.kills) {
    score.set(kill.killerId, (score.get(kill.killerId) ?? 0) + 1);
  }
  for (const kill of stompResult.kills) {
    score.set(kill.stomperId, (score.get(kill.stomperId) ?? 0) + 1);
  }

  // 14. Advance tick
  return {
    tick: currentTick,
    players,
    projectiles,
    rngState,
    score,
    nextProjectileId,
    arenaLeft,
    arenaRight,
    matchOver,
    winner,
  };
}
