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
  STOMP_DAMAGE_INTERVAL,
  STOMP_DAMAGE_PER_HIT,
  STOMP_SHAKE_PER_PRESS,
  STOMP_SHAKE_THRESHOLD,
  STOMP_SHAKE_DECAY,
  STOMP_AUTO_RUN_MIN,
  STOMP_AUTO_RUN_MAX,
  STOMP_COOLDOWN_TICKS,
  JUMP_VELOCITY,
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
  applySplashDamage,
  isRocket,
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
  // 0. Match over or death linger — winner can still move, projectiles travel, skip combat
  if (prev.matchOver || prev.deathLingerTimer > 0) {
    let deathLingerTimer = prev.deathLingerTimer > 0 ? prev.deathLingerTimer - 1 : 0;
    const matchOver = prev.matchOver || deathLingerTimer <= 0;

    // Winner movement
    let lingerPlayers = [...prev.players];
    const winnerId = prev.winner;
    if (winnerId >= 0) {
      lingerPlayers = lingerPlayers.map((p) => {
        if (p.id !== winnerId) return p;
        if (!(p.stateFlags & PlayerStateFlag.Alive)) return p;
        const input = inputs.get(p.id) ?? prevInputs.get(p.id) ?? NULL_INPUT;
        const prevInput = prevInputs.get(p.id) ?? NULL_INPUT;
        let updated = applyPlayerInput(p, input, prevInput);
        updated = applyGravity(updated);
        updated = moveAndCollide(updated, config.map, prev.arenaLeft, prev.arenaRight, input.buttons);
        return updated;
      });
    }

    // Projectiles keep moving, removed on collision/expiry/OOB
    const projectiles = prev.projectiles
      .map(moveProjectile)
      .filter((proj) => {
        if (proj.lifetime <= 0) return false;
        if (isOutOfBounds(proj, config.map, prev.arenaLeft, prev.arenaRight)) return false;
        // Platform collision
        for (const plat of config.map.platforms) {
          if (proj.x >= plat.x && proj.x <= plat.x + plat.width &&
              proj.y >= plat.y - 4 && proj.y <= plat.y + plat.height) return false;
        }
        if (proj.x <= prev.arenaLeft || proj.x >= prev.arenaRight) return false;
        if (proj.y <= 0 || proj.y >= config.map.height) return false;
        return true;
      });

    return { ...prev, players: lingerPlayers, projectiles, tick: prev.tick + 1, matchOver, deathLingerTimer };
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
  //    Override inputs for stomped players:
  //    - Rider (stompingOn !== null): no movement input (rides victim)
  //    - Victim (stompedBy !== null): auto-run direction, no jump
  players = players.map((p) => {
    let input = resolvedInputs.get(p.id)!;
    const prevInput = prevInputs.get(p.id) ?? NULL_INPUT;
    if (p.stompingOn !== null) {
      // Rider: suppress movement, keep aim + shoot
      input = { buttons: input.buttons & Button.Shoot, aimX: input.aimX, aimY: input.aimY };
    } else if (p.stompedBy !== null) {
      // Victim: auto-run, suppress all other input
      const autoBtn = p.stompAutoRunDir < 0 ? Button.Left : Button.Right;
      input = { buttons: autoBtn, aimX: 0, aimY: 0 };
    }
    return applyPlayerInput(p, input, prevInput);
  });

  // 4. Apply gravity (skip riders — they ride the victim)
  players = players.map((p) => p.stompingOn !== null ? p : applyGravity(p));

  // 5. Move + collide (skip riders — they're positioned by stomp logic)
  players = players.map((p) => {
    if (p.stompingOn !== null) return p;
    const input = resolvedInputs.get(p.id)!;
    return moveAndCollide(p, map, arenaLeft, arenaRight, input.buttons);
  });

  // 5b. Stomp mechanic — detect, attach, damage, shake off
  const stompKills: { killerId: number; victimId: number }[] = [];
  {

    for (let a = 0; a < players.length; a++) {
      const pa = players[a]!;
      if (!(pa.stateFlags & PlayerStateFlag.Alive)) continue;
      if (pa.stompingOn !== null) continue; // already stomping

      // Detection: player A falling onto player B's head
      if (pa.vy <= 0) continue; // must be falling down
      for (let b = 0; b < players.length; b++) {
        if (a === b) continue;
        const pb = players[b]!;
        if (!(pb.stateFlags & PlayerStateFlag.Alive)) continue;
        if (pb.stompedBy !== null) continue; // already being stomped
        if (pb.stompCooldown > 0) continue; // recently shaken off, immune

        // A's feet land on B's head zone
        const aFeetY = pa.y + PLAYER_HEIGHT;
        const bHeadTop = pb.y;
        const bHeadBottom = pb.y + 8;
        const xOverlap = pa.x + PLAYER_WIDTH > pb.x && pa.x < pb.x + PLAYER_WIDTH;

        if (aFeetY >= bHeadTop && aFeetY <= bHeadBottom && xOverlap) {
          // Attach! A stomps on B
          // Pick initial auto-run direction randomly
          let autoDir: number;
          [autoDir, rngState] = prngIntRange(rngState, 0, 1);
          autoDir = autoDir === 0 ? -1 : 1;
          let autoTimer: number;
          [autoTimer, rngState] = prngIntRange(rngState, STOMP_AUTO_RUN_MIN, STOMP_AUTO_RUN_MAX);

          players[a] = {
            ...pa,
            stompingOn: pb.id,
            grounded: true,
            vy: 0,
            y: pb.y - PLAYER_HEIGHT,
          };
          players[b] = {
            ...pb,
            stompedBy: pa.id,
            stompShakeProgress: 0,
            stompLastShakeDir: 0,
            stompAutoRunDir: autoDir,
            stompAutoRunTimer: autoTimer,
          };
          break; // one stomp per frame per player
        }
      }
    }

    // Process active stomps: damage, rider positioning, shake off, auto-run
    for (let b = 0; b < players.length; b++) {
      let victim = players[b]!;
      if (victim.stompedBy === null) continue;
      const riderId = victim.stompedBy;
      const riderIdx = players.findIndex(p => p.id === riderId);
      if (riderIdx < 0) { // rider gone, detach
        players[b] = { ...victim, stompedBy: null, stompShakeProgress: 0, stompLastShakeDir: 0 };
        continue;
      }
      let rider = players[riderIdx]!;
      if (!(rider.stateFlags & PlayerStateFlag.Alive)) {
        // Rider died, detach
        players[b] = { ...victim, stompedBy: null, stompShakeProgress: 0, stompLastShakeDir: 0 };
        players[riderIdx] = { ...rider, stompingOn: null };
        continue;
      }

      // Deal damage to victim every STOMP_DAMAGE_INTERVAL ticks
      let newHealth = victim.health;
      if (currentTick % STOMP_DAMAGE_INTERVAL === 0) {
        newHealth = victim.health - STOMP_DAMAGE_PER_HIT;
        if (newHealth < 0) newHealth = 0;
      }

      // Victim killed by stomp damage
      if (newHealth <= 0) {
        stompKills.push({ killerId: riderId, victimId: victim.id });
        players[riderIdx] = {
          ...rider,
          stompingOn: null,
          vy: JUMP_VELOCITY * 0.5, // small hop off dead victim
          grounded: false,
        };
        players[b] = {
          ...victim,
          health: 0,
          stateFlags: 0,
          stompedBy: null,
          stompShakeProgress: 0,
          stompLastShakeDir: 0,
        };
        continue;
      }

      // Auto-run: victim runs around erratically
      let autoDir = victim.stompAutoRunDir;
      let autoTimer = victim.stompAutoRunTimer - 1;
      if (autoTimer <= 0) {
        // Flip direction
        autoDir = -autoDir;
        [autoTimer, rngState] = prngIntRange(rngState, STOMP_AUTO_RUN_MIN, STOMP_AUTO_RUN_MAX);
      }

      // Shake off check: victim must alternate L and R presses
      const victimInput = resolvedInputs.get(victim.id) ?? NULL_INPUT;
      const victimPrevInput = prevInputs.get(victim.id) ?? NULL_INPUT;
      let shake = victim.stompShakeProgress;
      let lastDir = victim.stompLastShakeDir;

      // Edge-detect L press
      const lNow = !!(victimInput.buttons & Button.Left);
      const lPrev = !!(victimPrevInput.buttons & Button.Left);
      if (lNow && !lPrev && lastDir !== -1) {
        shake += STOMP_SHAKE_PER_PRESS;
        lastDir = -1;
      }
      // Edge-detect R press
      const rNow = !!(victimInput.buttons & Button.Right);
      const rPrev = !!(victimPrevInput.buttons & Button.Right);
      if (rNow && !rPrev && lastDir !== 1) {
        shake += STOMP_SHAKE_PER_PRESS;
        lastDir = 1;
      }

      // Decay
      shake = Math.max(0, shake - STOMP_SHAKE_DECAY);

      if (shake >= STOMP_SHAKE_THRESHOLD) {
        // Break free! Launch rider upward
        players[riderIdx] = {
          ...rider,
          stompingOn: null,
          vy: JUMP_VELOCITY,
          grounded: false,
        };
        players[b] = {
          ...victim,
          health: newHealth,
          stompedBy: null,
          stompShakeProgress: 0,
          stompLastShakeDir: 0,
          stompAutoRunDir: autoDir,
          stompAutoRunTimer: autoTimer,
          stompCooldown: STOMP_COOLDOWN_TICKS,
        };
      } else {
        // Rider rides victim — position on top, no independent movement
        players[riderIdx] = {
          ...rider,
          x: victim.x,
          y: victim.y - PLAYER_HEIGHT,
          vx: 0,
          vy: 0,
          grounded: true,
        };
        players[b] = {
          ...victim,
          health: newHealth,
          stompShakeProgress: shake,
          stompLastShakeDir: lastDir,
          stompAutoRunDir: autoDir,
          stompAutoRunTimer: autoTimer,
        };
      }
    }
  }

  // 5c. Tick down stomp cooldown
  for (let i = 0; i < players.length; i++) {
    const p = players[i]!;
    if (p.stompCooldown > 0 && p.stompedBy === null) {
      players[i] = { ...p, stompCooldown: p.stompCooldown - 1 };
    }
  }

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

  // 8b. Projectile-platform/wall collision
  // All projectiles are destroyed on platform or arena wall hit.
  // Rockets additionally apply splash damage.
  const destroyedIds = new Set<number>();
  const allKills: { killerId: number; victimId: number }[] = [...stompKills];

  for (const proj of projectiles) {
    const expired = proj.lifetime <= 0;
    const oob = isOutOfBounds(proj, map, arenaLeft, arenaRight);
    let hitSolid = false;

    // Check platform collision (4px buffer above surface so bullets hit visible grass edge)
    for (const plat of map.platforms) {
      if (proj.x >= plat.x && proj.x <= plat.x + plat.width &&
          proj.y >= plat.y - 4 && proj.y <= plat.y + plat.height) {
        hitSolid = true;
        break;
      }
    }
    // Check arena walls
    if (proj.x <= arenaLeft || proj.x >= arenaRight) hitSolid = true;
    // Check ceiling and floor
    if (proj.y <= 0 || proj.y >= map.height) hitSolid = true;

    if (expired || oob || hitSolid) {
      destroyedIds.add(proj.id);
      // Rockets explode with splash damage
      if (isRocket(proj)) {
        const splash = applySplashDamage(proj.x, proj.y, proj.ownerId, players);
        players = splash.players;
        allKills.push(...splash.kills);
      }
    }
  }

  projectiles = projectiles.filter(
    (proj) => !destroyedIds.has(proj.id),
  );

  // 9. Projectile-player collision
  const hitResult = resolveProjectileHits(projectiles, players);
  projectiles = [...hitResult.remainingProjectiles];
  players = [...hitResult.updatedPlayers];
  allKills.push(...hitResult.kills);

  // 10. Deaths + lives — decrement lives for players killed by projectiles/splash
  const killedIds = new Set(allKills.map((k) => k.victimId));
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
            stompedBy: null,
            stompingOn: null,
            stompShakeProgress: 0,
            stompLastShakeDir: 0,
            stompAutoRunDir: 1,
            stompAutoRunTimer: 0,
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
  for (const kill of allKills) {
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
