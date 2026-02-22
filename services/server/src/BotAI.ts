import type { ServerWebSocket } from "bun";
import type { PlayerInput, GameMap, Platform } from "@chickenz/sim";
import { Button, PLAYER_WIDTH } from "@chickenz/sim";
import type { SocketData } from "./GameRoom";

// ── Bot Names ──────────────────────────────────────────────

const BOT_NAMES = [
  "Clucky", "Pecker", "Nugget", "Drumstk", "Eggbert", "Beaker",
  "Feather", "Rooster", "Henny", "Clucker", "Yolko", "Bantam",
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

// ── Bot State ──────────────────────────────────────────────

/** Platform navigation: approach edge → jump → move inward → land */
interface PlatformNav {
  platY: number;        // platform top Y
  approachX: number;    // X to reach before jumping
  inwardDir: number;    // +1 right, -1 left (direction to move after jump)
  phase: "approach" | "jump" | "land";
  ticks: number;        // safety counter to abandon stale navs
}

export interface BotState {
  jumpCooldown: number;
  shooting: boolean;
  decisionTick: number;
  lastX: number;
  lastY: number;
  stuckTicks: number;
  nav: PlatformNav | null;
}

export function createBotState(): BotState {
  return {
    jumpCooldown: 0,
    shooting: false,
    decisionTick: 0,
    lastX: -1,
    lastY: -1,
    stuckTicks: 0,
    nav: null,
  };
}

// ── Bot Think ──────────────────────────────────────────────
//
// WASM exports: weapon/stompedBy/stompingOn use -1 for null.
// Aim values are i8 integers: -1 = left, 0 = neutral, 1 = right.

interface ExportedPlayer {
  x: number; y: number;
  vx: number; vy: number;
  grounded: boolean;
  wallSliding: boolean;
  weapon: number;       // -1 = no weapon
  ammo: number;
  shootCooldown: number;
  lives: number;
  stateFlags: number;
  stompedBy: number;    // -1 = not stomped
  respawnTimer: number;
  jumpsLeft: number;
}

interface ExportedProjectile {
  x: number; y: number;
  vx: number; vy: number;
  ownerId: number;
}

interface ExportedPickup {
  x: number; y: number;
  respawnTimer: number;
}

interface ExportedState {
  tick: number;
  players: ExportedPlayer[];
  projectiles: ExportedProjectile[];
  weaponPickups: ExportedPickup[];
}

const ALIVE_FLAG = 1;

/** Find the platform a point sits on (within 8px of platform top). */
function findPlatformAt(map: GameMap, x: number, y: number): Platform | null {
  for (const p of map.platforms) {
    if (x >= p.x && x <= p.x + p.width &&
        y >= p.y - 8 && y <= p.y + 8) {
      return p;
    }
  }
  return null;
}

/** Plan a route to reach the top of a platform from below. */
function planPlatformNav(bot: ExportedPlayer, plat: Platform): PlatformNav {
  const leftEdge = plat.x - PLAYER_WIDTH - 4;
  const rightEdge = plat.x + plat.width + 4;
  // Pick whichever edge is closer
  const distLeft = Math.abs(bot.x - leftEdge);
  const distRight = Math.abs(bot.x - rightEdge);
  if (distLeft <= distRight) {
    return { platY: plat.y, approachX: leftEdge, inwardDir: 1, phase: "approach", ticks: 0 };
  } else {
    return { platY: plat.y, approachX: rightEdge, inwardDir: -1, phase: "approach", ticks: 0 };
  }
}

export function botThink(
  botId: number,
  state: ExportedState,
  map: GameMap,
  botState: BotState,
): PlayerInput {
  const bot = state.players[botId]!;
  const opp = state.players[1 - botId]!;

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
  if (botState.lastX >= 0 &&
      Math.abs(bot.x - botState.lastX) < 1 &&
      Math.abs(bot.y - botState.lastY) < 1) {
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
  const aimX: number = dx > 8 ? 1 : dx < -8 ? -1 : (bot.vx >= 0 ? 1 : -1);

  // 1. Stomped → mash L/R
  if (bot.stompedBy >= 0) {
    botState.nav = null;
    const dir = Math.floor(state.tick / 4) % 2 === 0 ? Button.Left : Button.Right;
    return { buttons: dir, aimX, aimY: 0 };
  }

  // 2. Dodge projectiles (overrides everything)
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
    if (ticksToArrive > 25) continue;
    const closestX = proj.x + nvx * dot;
    const closestY = proj.y + nvy * dot;
    const perpDist = Math.sqrt((bot.x - closestX) ** 2 + (bot.y - closestY) ** 2);
    if (perpDist < 70) {
      dodging = true;
      botState.nav = null; // abandon nav during dodge
      const cross = nvx * py - nvy * px;
      buttons |= cross > 0 ? Button.Right : Button.Left;
      if (bot.grounded && ticksToArrive < 12 && botState.jumpCooldown <= 0) {
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
        // Move to the approach point (outside platform edge)
        const adx = nav.approachX - bot.x;
        if (Math.abs(adx) > 6) {
          if (adx < 0) buttons |= Button.Left;
          else buttons |= Button.Right;
        } else if (bot.grounded && botState.jumpCooldown <= 0) {
          // At approach point + grounded → jump
          nav.phase = "jump";
          buttons |= Button.Jump;
          botState.jumpCooldown = 5; // short cooldown, we need to move inward right away
        }
      } else if (nav.phase === "jump") {
        // Moving upward — move inward onto the platform
        if (nav.inwardDir > 0) buttons |= Button.Right;
        else buttons |= Button.Left;
        // Once above platform top, switch to landing
        if (bot.y < nav.platY) {
          nav.phase = "land";
        }
        // If we landed back on ground (missed), retry approach
        if (bot.grounded && bot.y > nav.platY + 20) {
          nav.phase = "approach";
        }
      } else if (nav.phase === "land") {
        // Keep moving inward until grounded on the platform
        if (nav.inwardDir > 0) buttons |= Button.Right;
        else buttons |= Button.Left;
        if (bot.grounded && bot.y <= nav.platY) {
          // Successfully landed on platform
          botState.nav = null;
        }
        // Fell past platform — retry
        if (bot.y > nav.platY + 40) {
          nav.phase = "approach";
        }
      }
    }

    // ── Normal behavior (when not navigating) ──
    if (!botState.nav) {
      // 3. Chase opponent
      if (oppAlive) {
        if (dx < -20) buttons |= Button.Left;
        else if (dx > 20) buttons |= Button.Right;
      }

      // 4. Weapon pickup — detour for same-level pickups, or navigate to elevated ones
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

        if (bestDist < Infinity) {
          const pickupDy = bestPickupY - bot.y;
          if (Math.abs(pickupDy) <= 40) {
            // Same level — just walk toward it
            const pdx = bestPickupX - bot.x;
            if (Math.abs(pdx) < 200 && Math.abs(pdx) > 8) {
              buttons &= ~(Button.Left | Button.Right);
              if (pdx < 0) buttons |= Button.Left;
              else buttons |= Button.Right;
            }
          } else if (pickupDy < -40 && bestDist < 350) {
            // Pickup is above — find its platform and navigate there
            const plat = findPlatformAt(map, bestPickupX, bestPickupY);
            if (plat) {
              botState.nav = planPlatformNav(bot, plat);
            }
          }
        }
      }

      // 5. Jump (when not in platform nav)
      if (botState.jumpCooldown <= 0) {
        if (oppAlive && dy < -40) {
          // Opponent above — try platform nav to reach their platform
          if (bot.grounded) {
            const oppPlat = findPlatformAt(map, opp.x, opp.y);
            if (oppPlat && bot.y > oppPlat.y + 20) {
              botState.nav = planPlatformNav(bot, oppPlat);
            } else {
              buttons |= Button.Jump;
              botState.jumpCooldown = 20;
            }
          } else if (bot.jumpsLeft > 0 && bot.vy > 0) {
            buttons |= Button.Jump;
            botState.jumpCooldown = 20;
          }
        }
        // Wall-jump
        if (bot.wallSliding) {
          buttons |= Button.Jump;
          botState.jumpCooldown = 10;
        }
      }

      // Unstuck handler
      if (botState.stuckTicks > 25) {
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
        botState.stuckTicks = 0;
      }
    }

    // 6. Shoot (always, regardless of nav state)
    if (oppAlive && hasWeapon && bot.shootCooldown <= 0) {
      let maxRange = 300;
      if (bot.weapon === 1) maxRange = 180;
      else if (bot.weapon === 2) maxRange = 600;
      else if (bot.weapon === 4) maxRange = 280;

      if (dist < maxRange) {
        if (state.tick >= botState.decisionTick) {
          botState.shooting = Math.random() < 0.75;
          botState.decisionTick = state.tick + 6;
        }
        if (botState.shooting) buttons |= Button.Shoot;
      } else {
        botState.shooting = false;
      }
    } else {
      botState.shooting = false;
    }
  }

  return { buttons, aimX, aimY: 0 };
}
