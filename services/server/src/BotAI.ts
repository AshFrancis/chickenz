import type { ServerWebSocket } from "bun";
import type { PlayerInput, GameMap, Platform } from "@chickenz/sim";
import { Button, PLAYER_WIDTH, PLAYER_HEIGHT } from "@chickenz/sim";
import type { SocketData } from "./GameRoom";

// ── Bot Names ──────────────────────────────────────────────

const BOT_NAMES = [
  "Clucky",
  "Pecker",
  "Nugget",
  "Drumstk",
  "Eggbert",
  "Beaker",
  "Feather",
  "Rooster",
  "Henny",
  "Clucker",
  "Yolko",
  "Bantam",
];

export function randomBotName(): string {
  return BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]!;
}

// ── Fake Socket ────────────────────────────────────────────

type GameSocket = ServerWebSocket<SocketData>;

export function createBotSocket(botName: string): GameSocket {
  const data: SocketData = {
    roomId: null,
    playerId: -1,
    username: botName,
    walletAddress: "",
    character: Math.floor(Math.random() * 4),
    awayCharacter: -1,
    tournamentId: null,
    msgCount: 0,
    msgResetTime: Date.now(),
  };
  return {
    data,
    send() {},
    ping() {},
  } as unknown as GameSocket;
}

// ── Difficulty ─────────────────────────────────────────────

export type BotDifficulty = "easy" | "medium" | "hard";

interface DifficultyParams {
  dodgeChance: number; // probability of reacting to any projectile
  dodgeReactionTicks: number; // min ticks before projectile hits to react
  shootChance: number; // probability of shooting per decision tick
  decisionInterval: number; // ticks between shoot decisions
  stompChance: number; // probability of trying to jump above opponent vs staying grounded
  pickupDetour: number; // max distance to detour for weapon pickup
}

const DIFFICULTY: Record<BotDifficulty, DifficultyParams> = {
  easy: {
    dodgeChance: 0.12,
    dodgeReactionTicks: 20,
    shootChance: 0.35,
    decisionInterval: 13,
    stompChance: 0.05,
    pickupDetour: 400,
  },
  medium: {
    dodgeChance: 0.6,
    dodgeReactionTicks: 12,
    shootChance: 0.6,
    decisionInterval: 8,
    stompChance: 0.25,
    pickupDetour: 350,
  },
  hard: {
    dodgeChance: 0.9,
    dodgeReactionTicks: 20,
    shootChance: 0.8,
    decisionInterval: 6,
    stompChance: 0.5,
    pickupDetour: 500,
  },
};

// ── Bot State ──────────────────────────────────────────────

/** Platform navigation: approach edge → jump → move inward → land */
interface PlatformNav {
  platY: number; // platform top Y
  approachX: number; // X to reach before jumping
  inwardDir: number; // +1 right, -1 left (direction to move after jump)
  phase: "approach" | "jump" | "land";
  ticks: number; // safety counter to abandon stale navs
}

export interface BotState {
  jumpCooldown: number;
  shooting: boolean;
  decisionTick: number;
  lastX: number;
  lastY: number;
  stuckTicks: number;
  nav: PlatformNav | null;
  difficulty: BotDifficulty;
  dodgeSeed: number; // per-projectile dodge roll (deterministic per tick range)
}

export function createBotState(difficulty: BotDifficulty = "easy"): BotState {
  return {
    jumpCooldown: 0,
    shooting: false,
    decisionTick: 0,
    lastX: -1,
    lastY: -1,
    stuckTicks: 0,
    nav: null,
    difficulty,
    dodgeSeed: Math.random(),
  };
}

// ── Bot Think ──────────────────────────────────────────────
//
// WASM exports: weapon/stompedBy/stompingOn use -1 for null.
// Aim values are i8 integers: -1 = left, 0 = neutral, 1 = right.

interface ExportedPlayer {
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
  wallSliding: boolean;
  weapon: number; // -1 = no weapon
  ammo: number;
  shootCooldown: number;
  lives: number;
  stateFlags: number;
  stompedBy: number; // -1 = not stomped
  respawnTimer: number;
  jumpsLeft: number;
}

interface ExportedProjectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ownerId: number;
}

interface ExportedPickup {
  x: number;
  y: number;
  respawnTimer: number;
}

interface ExportedState {
  tick: number;
  players: ExportedPlayer[];
  projectiles: ExportedProjectile[];
  weaponPickups: ExportedPickup[];
  arenaLeft: number;
  arenaRight: number;
}

const ALIVE_FLAG = 1;

/** Find the platform under a point (feetY = bottom of entity, within 8px of platform top). */
function findPlatformAt(map: GameMap, x: number, feetY: number): Platform | null {
  for (const p of map.platforms) {
    if (x >= p.x && x <= p.x + p.width && feetY >= p.y - 8 && feetY <= p.y + 8) {
      return p;
    }
  }
  return null;
}

/** Check if a player (top-left x,y) is horizontally under a platform within jump range.
 *  Screen coords: y increases downward. "Under" means platform is above the bot. */
function isUnderPlatform(map: GameMap, x: number, y: number): Platform | null {
  for (const p of map.platforms) {
    // Platform bottom must be above bot's head (p.y + p.height <= y)
    // Bot must horizontally overlap with the platform
    // Only consider platforms within ~120px (reachable by jump)
    if (p.y + p.height <= y && y - p.y < 120 && x + PLAYER_WIDTH > p.x && x < p.x + p.width) {
      return p;
    }
  }
  return null;
}

/** When opponent is below, walk past edge of current platform to drop down.
 *  Prefers the edge closer to the opponent so we drop toward them.
 *  Returns the button to press, or 0 if not on a platform / already at ground. */
function dropDownDir(bot: ExportedPlayer, opp: ExportedPlayer, map: GameMap): number {
  // Check with both left and right foot — bot is "on" platform if either foot is supported
  const leftFoot = findPlatformAt(map, bot.x + 4, bot.y + PLAYER_HEIGHT);
  const rightFoot = findPlatformAt(map, bot.x + PLAYER_WIDTH - 4, bot.y + PLAYER_HEIGHT);
  const botPlat = leftFoot || rightFoot;
  if (!botPlat) return 0;
  // Don't drop off the ground
  if (botPlat.y >= map.height - 40) return 0;
  // Walk toward the opponent — they're below us so drop off the side nearest them
  const oppCx = opp.x + PLAYER_WIDTH / 2;
  if (oppCx < botPlat.x) return Button.Left;
  if (oppCx > botPlat.x + botPlat.width) return Button.Right;
  // Opponent is horizontally within the platform — pick nearest edge
  const distToLeft = bot.x - botPlat.x;
  const distToRight = botPlat.x + botPlat.width - (bot.x + PLAYER_WIDTH);
  return distToLeft < distToRight ? Button.Left : Button.Right;
}

/** Find the nearest reachable platform above the bot.
 *  Uses double-jump range (~200px). Prefers platforms toward targetX if provided. */
function findNearestPlatformAbove(map: GameMap, botX: number, botY: number, targetX?: number): Platform | null {
  const MAX_REACH = 200; // conservative double-jump height
  let best: Platform | null = null;
  let bestScore = Infinity;
  for (const p of map.platforms) {
    const gap = botY - p.y; // positive = platform is above (screen coords)
    if (gap < 20 || gap > MAX_REACH) continue; // too close or too far
    const cx = p.x + p.width / 2;
    let score = Math.abs(botX - cx) + gap * 1.5;
    // Bonus for platforms toward the target (halve score if in the right direction)
    if (targetX !== undefined) {
      const targetDir = targetX - botX; // positive = target is right
      const platDir = cx - botX; // positive = platform is right
      if (targetDir * platDir > 0) score *= 0.5; // same direction → prefer
    }
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/** Plan a route to reach the top of a platform from below.
 *  The bot must move fully outside the platform's horizontal extent before jumping.
 *  Respects arena boundaries (includes sudden death walls). */
function planPlatformNav(
  bot: ExportedPlayer,
  plat: Platform,
  map?: GameMap,
  arenaLeft = 0,
  arenaRight = 960,
): PlatformNav {
  // Margin: full player width + 8px buffer so the entire body is clear
  const leftEdge = plat.x - PLAYER_WIDTH - 8;
  const rightEdge = plat.x + plat.width + 8;
  // Check if approach points are within arena bounds
  const leftOk = leftEdge >= arenaLeft;
  const rightOk = rightEdge + PLAYER_WIDTH <= arenaRight;

  let useLeft: boolean;
  if (leftOk && rightOk) {
    useLeft = Math.abs(bot.x - leftEdge) <= Math.abs(bot.x - rightEdge);
  } else if (leftOk) {
    useLeft = true;
  } else if (rightOk) {
    useLeft = false;
  } else {
    // Both out of bounds — pick whichever is less out of bounds
    useLeft = Math.abs(bot.x - leftEdge) <= Math.abs(bot.x - rightEdge);
  }

  if (useLeft) {
    return { platY: plat.y, approachX: Math.max(arenaLeft, leftEdge), inwardDir: 1, phase: "approach", ticks: 0 };
  } else {
    return {
      platY: plat.y,
      approachX: Math.min(arenaRight - PLAYER_WIDTH, rightEdge),
      inwardDir: -1,
      phase: "approach",
      ticks: 0,
    };
  }
}

export function botThink(botId: number, state: ExportedState, map: GameMap, botState: BotState): PlayerInput {
  const bot = state.players[botId]!;
  const opp = state.players[1 - botId]!;
  const diff = DIFFICULTY[botState.difficulty];

  if (botState.jumpCooldown > 0) botState.jumpCooldown--;

  // Dead/respawning → idle, clear nav
  if (!(bot.stateFlags & ALIVE_FLAG) || bot.respawnTimer > 0) {
    botState.lastX = -1;
    botState.lastY = -1;
    botState.stuckTicks = 0;
    botState.nav = null;
    return { buttons: 0, aimX: 0, aimY: 0 };
  }

  // Stuck detection
  if (botState.lastX >= 0 && Math.abs(bot.x - botState.lastX) < 1 && Math.abs(bot.y - botState.lastY) < 1) {
    botState.stuckTicks++;
  } else {
    botState.stuckTicks = 0;
  }
  botState.lastX = bot.x;
  botState.lastY = bot.y;

  let buttons = 0;
  const oppAlive = !!(opp.stateFlags & ALIVE_FLAG) && opp.respawnTimer <= 0;
  const dx = opp.x - bot.x;
  const dy = opp.y - bot.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const hasWeapon = bot.weapon >= 0 && bot.ammo > 0;

  // Aim toward opponent
  const aimX: number = dx > 8 ? 1 : dx < -8 ? -1 : bot.vx >= 0 ? 1 : -1;

  // 1. Stomped → mash L/R to escape
  if (bot.stompedBy >= 0) {
    botState.nav = null;
    const dir = Math.floor(state.tick / 9) % 2 === 0 ? Button.Left : Button.Right;
    return { buttons: dir, aimX: dir === Button.Left ? -1 : 1, aimY: 0 };
  }

  // 2. Dodge projectiles (difficulty-gated)
  let dodging = false;
  for (const proj of state.projectiles) {
    if (proj.ownerId === botId) continue;
    const px = bot.x - proj.x;
    const py = bot.y - proj.y;
    const projSpeed = Math.sqrt(proj.vx * proj.vx + proj.vy * proj.vy) || 1;
    const nvx = proj.vx / projSpeed;
    const nvy = proj.vy / projSpeed;
    const dot = px * nvx + py * nvy;
    if (dot < 0) continue;
    const ticksToArrive = dot / projSpeed;
    // Harder bots react to bullets further away
    if (ticksToArrive > diff.dodgeReactionTicks) continue;
    const closestX = proj.x + nvx * dot;
    const closestY = proj.y + nvy * dot;
    const perpDist = Math.sqrt((bot.x - closestX) ** 2 + (bot.y - closestY) ** 2);
    if (perpDist < 70) {
      // Difficulty check: easy bots only dodge sometimes
      if (Math.random() > diff.dodgeChance) continue;
      dodging = true;
      botState.nav = null;
      const cross = nvx * py - nvy * px;
      buttons |= cross > 0 ? Button.Right : Button.Left;
      if (bot.grounded && ticksToArrive < 8 && botState.jumpCooldown <= 0) {
        buttons |= Button.Jump;
        botState.jumpCooldown = 20;
      }
      break;
    }
  }

  if (!dodging) {
    // ── Platform navigation state machine ──
    const nav = botState.nav;
    if (nav) {
      nav.ticks++;
      // Safety: abandon after 120 ticks (~2s)
      if (nav.ticks > 120) {
        botState.nav = null;
      } else if (nav.phase === "approach") {
        const adx = nav.approachX - bot.x;
        // Must be within 4px AND fully clear of the platform before jumping
        const underPlat = isUnderPlatform(map, bot.x, bot.y);
        if (underPlat && Math.abs(adx) <= 8) {
          // Reached approach point but stuck under a DIFFERENT platform — climb it instead
          botState.nav = planPlatformNav(bot, underPlat, map, state.arenaLeft, state.arenaRight);
        } else if (Math.abs(adx) > 4 || underPlat) {
          if (adx < 0) buttons |= Button.Left;
          else buttons |= Button.Right;
        } else if (bot.grounded && botState.jumpCooldown <= 0) {
          nav.phase = "jump";
          buttons |= Button.Jump;
          botState.jumpCooldown = 5;
        }
      } else if (nav.phase === "jump") {
        // Stay beside the platform — DON'T move inward until FEET are above it
        // (platforms are solid walls, not one-way)
        const feetY = bot.y + PLAYER_HEIGHT;
        if (feetY < nav.platY - 4) {
          // Feet are above platform top with margin — now move inward to land
          nav.phase = "land";
        } else {
          // Double jump: fire when near peak of first jump (vy approaching 0)
          // This maximizes total height for reaching high platforms
          if (!bot.grounded && bot.jumpsLeft > 0 && bot.vy > -2 && botState.jumpCooldown <= 0) {
            buttons |= Button.Jump;
            botState.jumpCooldown = 5;
          }
          // Landed back on ground without reaching height — retry approach
          if (bot.grounded && nav.ticks > 10) {
            nav.phase = "approach";
          }
        }
      } else if (nav.phase === "land") {
        // Move inward onto the platform
        if (nav.inwardDir > 0) buttons |= Button.Right;
        else buttons |= Button.Left;
        if (bot.grounded && bot.y <= nav.platY) {
          botState.nav = null; // Successfully landed
        }
        // Fell too far below — retry
        if (bot.y > nav.platY + 40) {
          nav.phase = "approach";
        }
      }
    }

    // ── Normal behavior (when not navigating) ──
    if (!botState.nav) {
      // 3. WEAPON PICKUP (highest priority when unarmed)
      if (!hasWeapon) {
        let bestDist = Infinity;
        let bestPickupX = 0;
        let bestPickupY = 0;
        for (const pickup of state.weaponPickups) {
          if (pickup.respawnTimer > 0) continue;
          const d = Math.abs(pickup.x - bot.x) + Math.abs(pickup.y - bot.y);
          if (d < bestDist) {
            bestDist = d;
            bestPickupX = pickup.x;
            bestPickupY = pickup.y;
          }
        }

        if (bestDist < diff.pickupDetour) {
          const pickupDy = bestPickupY - bot.y;
          const pdx = bestPickupX - bot.x;
          if (pickupDy < -120) {
            // Weapon is far above — use stepping stone nav toward the weapon
            const step = findNearestPlatformAbove(map, bot.x + PLAYER_WIDTH / 2, bot.y, bestPickupX);
            if (step) {
              botState.nav = planPlatformNav(bot, step, map, state.arenaLeft, state.arenaRight);
            }
          } else {
            // Weapon is roughly reachable — walk toward it (jump handles elevation)
            if (Math.abs(pdx) > 8) {
              buttons &= ~(Button.Left | Button.Right);
              if (pdx < 0) buttons |= Button.Left;
              else buttons |= Button.Right;
            }
          }
          // Skip chase when actively seeking a weapon
        } else {
          // No reachable pickup — chase opponent instead
          if (oppAlive) {
            if (dy < -20) {
              const above = isUnderPlatform(map, bot.x, bot.y);
              if (above) {
                botState.nav = planPlatformNav(bot, above, map, state.arenaLeft, state.arenaRight);
              } else if (bot.grounded) {
                // Not directly under a platform — find a stepping stone to climb toward opponent
                const step = findNearestPlatformAbove(map, bot.x, bot.y, opp.x);
                if (step) {
                  botState.nav = planPlatformNav(bot, step, map, state.arenaLeft, state.arenaRight);
                } else {
                  if (dx < -20) buttons |= Button.Left;
                  else if (dx > 20) buttons |= Button.Right;
                }
              } else {
                if (dx < -20) buttons |= Button.Left;
                else if (dx > 20) buttons |= Button.Right;
              }
            } else if (dy > 30 && bot.grounded) {
              // Opponent below — walk off platform edge to drop down
              const dd = dropDownDir(bot, opp, map);
              if (dd) buttons |= dd;
              else {
                if (dx < -20) buttons |= Button.Left;
                else if (dx > 20) buttons |= Button.Right;
              }
            } else {
              if (dx < -20) buttons |= Button.Left;
              else if (dx > 20) buttons |= Button.Right;
            }
          }
        }
      } else {
        // 4. CHASE OPPONENT (when armed — keep shooting distance ~100px)
        const ENGAGE_DIST = 100; // don't get closer than this
        if (oppAlive) {
          if (dy < -20) {
            // Opponent above — navigate up
            const above = isUnderPlatform(map, bot.x, bot.y);
            if (above) {
              botState.nav = planPlatformNav(bot, above, map, state.arenaLeft, state.arenaRight);
            } else if (bot.grounded) {
              const step = findNearestPlatformAbove(map, bot.x, bot.y, opp.x);
              if (step) {
                botState.nav = planPlatformNav(bot, step, map, state.arenaLeft, state.arenaRight);
              } else {
                if (dx < -ENGAGE_DIST) buttons |= Button.Left;
                else if (dx > ENGAGE_DIST) buttons |= Button.Right;
              }
            } else {
              if (dx < -ENGAGE_DIST) buttons |= Button.Left;
              else if (dx > ENGAGE_DIST) buttons |= Button.Right;
            }
          } else if (dy > 30 && bot.grounded) {
            // Opponent below — walk off platform edge to drop down
            const dd = dropDownDir(bot, opp, map);
            if (dd) buttons |= dd;
            else {
              if (dx < -ENGAGE_DIST) buttons |= Button.Left;
              else if (dx > ENGAGE_DIST) buttons |= Button.Right;
            }
          } else {
            if (dx < -ENGAGE_DIST) buttons |= Button.Left;
            else if (dx > ENGAGE_DIST) buttons |= Button.Right;
          }
        }
      }

      // 5a. Edge jump: when walking toward something and about to fall off platform, jump
      // BUT NOT when opponent is below — we want to drop down, not jump
      const wantsToDropDown = oppAlive && dy > 30;
      if (bot.grounded && botState.jumpCooldown <= 0 && !wantsToDropDown) {
        const movingLeft = !!(buttons & Button.Left);
        const movingRight = !!(buttons & Button.Right);
        if (movingLeft || movingRight) {
          const botPlat = findPlatformAt(map, bot.x + PLAYER_WIDTH / 2, bot.y + PLAYER_HEIGHT);
          if (botPlat && botPlat.y < map.height - 40) {
            // not the ground
            const distToEdge = movingLeft ? bot.x - botPlat.x : botPlat.x + botPlat.width - (bot.x + PLAYER_WIDTH);
            if (distToEdge < 12 && distToEdge >= 0) {
              buttons |= Button.Jump;
              botState.jumpCooldown = 8;
            }
          }
        }
      }

      // 5. Jump logic (difficulty-gated stomping)
      // Don't jump when intentionally dropping down to opponent
      if (botState.jumpCooldown <= 0 && !wantsToDropDown) {
        if (oppAlive && dy < -40) {
          // Opponent is above — only try to reach them sometimes (reduces stomping)
          const tryToClimb = Math.random() < diff.stompChance;
          if (tryToClimb && bot.grounded) {
            // Find nearest reachable platform above to climb toward opponent
            const step = findNearestPlatformAbove(map, bot.x + PLAYER_WIDTH / 2, bot.y);
            if (step && bot.y > step.y + 20) {
              botState.nav = planPlatformNav(bot, step, map, state.arenaLeft, state.arenaRight);
            } else {
              // Only raw-jump if NOT under a platform (avoid headbutting)
              const above = isUnderPlatform(map, bot.x, bot.y);
              if (above) {
                botState.nav = planPlatformNav(bot, above, map, state.arenaLeft, state.arenaRight);
              } else {
                buttons |= Button.Jump;
                botState.jumpCooldown = 25;
              }
            }
          } else if (bot.jumpsLeft > 0 && bot.vy > 0 && tryToClimb) {
            buttons |= Button.Jump;
            botState.jumpCooldown = 25;
          }
        }
        // Wall-jump (always do this — it's just escape movement)
        if (bot.wallSliding) {
          buttons |= Button.Jump;
          botState.jumpCooldown = 10;
        }
      }

      // Unstuck handler
      if (botState.stuckTicks > 25) {
        const above = isUnderPlatform(map, bot.x, bot.y);
        if (above) {
          // Stuck under a platform — navigate around it instead of jumping
          botState.nav = planPlatformNav(bot, above, map, state.arenaLeft, state.arenaRight);
        } else {
          buttons &= ~(Button.Left | Button.Right);
          if (state.tick % 50 < 25) {
            buttons |= dx < 0 ? Button.Left : Button.Right;
          } else {
            buttons |= dx < 0 ? Button.Right : Button.Left;
          }
          if (botState.jumpCooldown <= 0) {
            buttons |= Button.Jump;
            botState.jumpCooldown = 10;
          }
        }
        botState.stuckTicks = 0;
      }
    }

    // 6. Shoot (difficulty-gated accuracy and reaction)
    if (oppAlive && hasWeapon && bot.shootCooldown <= 0) {
      let maxRange = 300;
      if (bot.weapon === 1)
        maxRange = 180; // shotgun
      else if (bot.weapon === 2)
        maxRange = 600; // sniper (3 = rocket via weapon rotation)
      else if (bot.weapon === 4) maxRange = 280; // smg

      if (dist < maxRange) {
        if (state.tick >= botState.decisionTick) {
          botState.shooting = Math.random() < diff.shootChance;
          botState.decisionTick = state.tick + diff.decisionInterval;
        }
        if (botState.shooting) buttons |= Button.Shoot;
      } else {
        botState.shooting = false;
      }
    } else {
      botState.shooting = false;
    }
  }

  // Sync aim with movement direction (real players can't move left while aiming right)
  const movingLeft = (buttons & Button.Left) !== 0;
  const movingRight = (buttons & Button.Right) !== 0;
  const finalAimX = movingRight ? 1 : movingLeft ? -1 : aimX;

  return { buttons, aimX: finalAimX, aimY: 0 };
}
