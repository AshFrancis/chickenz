import type { ServerWebSocket } from "bun";
import type { PlayerInput, GameMap } from "@chickenz/sim";
import { Button } from "@chickenz/sim";
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

export interface BotState {
  jumpCooldown: number;
  aimJitterSeed: number;
  shooting: boolean;
  decisionTick: number; // next tick to re-evaluate shooting
}

export function createBotState(): BotState {
  return {
    jumpCooldown: 0,
    aimJitterSeed: Math.random() * Math.PI * 2,
    shooting: false,
    decisionTick: 0,
  };
}

// ── Bot Think ──────────────────────────────────────────────

/** Exported state shape from wasmState.export_state() */
interface ExportedPlayer {
  x: number; y: number;
  vx: number; vy: number;
  grounded: boolean;
  wallSliding: boolean;
  weapon: number | null;
  ammo: number;
  shootCooldown: number;
  lives: number;
  stateFlags: number;
  stompedBy: number | null;
  respawnTimer: number;
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

export function botThink(
  botId: number,
  state: ExportedState,
  _map: GameMap,
  botState: BotState,
): PlayerInput {
  const bot = state.players[botId]!;
  const opp = state.players[1 - botId]!;

  // Decrement jump cooldown
  if (botState.jumpCooldown > 0) botState.jumpCooldown--;

  // 0. Dead/respawning → null input
  if (!(bot.stateFlags & ALIVE_FLAG) || bot.respawnTimer > 0) {
    return { buttons: 0, aimX: 0, aimY: 0 };
  }

  let buttons = 0;
  let aimX = opp.x - bot.x;
  let aimY = opp.y - bot.y;

  // Normalize aim
  const aimLen = Math.sqrt(aimX * aimX + aimY * aimY) || 1;
  aimX /= aimLen;
  aimY /= aimLen;

  // 1. Stomped → alternate Left/Right every 4 ticks to shake off
  if (bot.stompedBy != null && bot.stompedBy >= 0) {
    const dir = Math.floor(state.tick / 4) % 2 === 0 ? Button.Left : Button.Right;
    return { buttons: dir, aimX, aimY };
  }

  const dx = opp.x - bot.x;
  const dy = opp.y - bot.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;

  // 2. Dodge projectiles
  let dodging = false;
  for (const proj of state.projectiles) {
    if (proj.ownerId === botId) continue;

    // Vector from projectile to bot
    const px = bot.x - proj.x;
    const py = bot.y - proj.y;
    const projSpeed = Math.sqrt(proj.vx * proj.vx + proj.vy * proj.vy) || 1;
    const nvx = proj.vx / projSpeed;
    const nvy = proj.vy / projSpeed;

    // Time to closest approach
    const dot = px * nvx + py * nvy;
    if (dot < 0) continue; // projectile moving away

    const ticksToArrive = dot / projSpeed;
    if (ticksToArrive > 30) continue; // too far away in time

    // Perpendicular distance
    const closestX = proj.x + nvx * dot;
    const closestY = proj.y + nvy * dot;
    const perpDist = Math.sqrt((bot.x - closestX) ** 2 + (bot.y - closestY) ** 2);

    if (perpDist < 120) {
      dodging = true;
      // Move perpendicular to projectile velocity
      // Choose direction away from projectile path
      const cross = nvx * py - nvy * px;
      if (cross > 0) {
        buttons |= Button.Right;
      } else {
        buttons |= Button.Left;
      }
      // Jump if grounded and projectile is close
      if (bot.grounded && ticksToArrive < 15 && botState.jumpCooldown <= 0) {
        buttons |= Button.Jump;
        botState.jumpCooldown = 20;
      }
      break;
    }
  }

  // 3. Pick up weapon (if unarmed or out of ammo)
  const needsWeapon = bot.weapon == null || bot.weapon < 0 || bot.ammo <= 0;

  if (!dodging && needsWeapon) {
    // Find nearest active weapon pickup
    let nearestDist = Infinity;
    let nearestX = 0;
    for (const pickup of state.weaponPickups) {
      if (pickup.respawnTimer > 0) continue;
      const pdist = Math.abs(pickup.x - bot.x) + Math.abs(pickup.y - bot.y);
      if (pdist < nearestDist) {
        nearestDist = pdist;
        nearestX = pickup.x;
      }
    }
    if (nearestDist < Infinity && nearestDist < 400) {
      // Move toward pickup
      if (nearestX < bot.x - 8) buttons |= Button.Left;
      else if (nearestX > bot.x + 8) buttons |= Button.Right;
    }
  }

  // 4. Chase opponent (if not dodging and not urgently picking up weapon nearby)
  const oppAlive = (opp.stateFlags & ALIVE_FLAG) && opp.respawnTimer <= 0;
  if (!dodging && !(needsWeapon && buttons !== 0)) {
    if (oppAlive) {
      if (dx < -32) buttons |= Button.Left;
      else if (dx > 32) buttons |= Button.Right;
    }
  }

  // 5. Jump logic
  if (botState.jumpCooldown <= 0) {
    // Jump if target is above and bot is grounded
    if (dy < -48 && bot.grounded) {
      buttons |= Button.Jump;
      botState.jumpCooldown = 20;
    }
    // Wall jump if wall-sliding
    if (bot.wallSliding) {
      buttons |= Button.Jump;
      botState.jumpCooldown = 20;
    }
    // Jump over gaps / when falling
    if (bot.grounded && !oppAlive) {
      // Wander — occasionally jump
      if (state.tick % 90 === 0) {
        buttons |= Button.Jump;
        botState.jumpCooldown = 20;
      }
    }
  }

  // 6. Shoot
  if (oppAlive && !needsWeapon && bot.shootCooldown <= 0) {
    // Weapon-dependent range
    const weapon = bot.weapon!;
    let maxRange = 300;
    if (weapon === 1) maxRange = 180;      // Shotgun
    else if (weapon === 2) maxRange = 600; // Sniper
    else if (weapon === 4) maxRange = 250; // SMG

    if (dist < maxRange) {
      // Decision tick — re-evaluate every 6 ticks (~100ms)
      if (state.tick >= botState.decisionTick) {
        botState.shooting = Math.random() < 0.7;
        botState.decisionTick = state.tick + 6;
      }
      if (botState.shooting) {
        buttons |= Button.Shoot;
      }
    } else {
      botState.shooting = false;
    }
  } else {
    botState.shooting = false;
  }

  // Add sinusoidal jitter to aim
  const jitter = Math.sin(state.tick * 0.15 + botState.aimJitterSeed) * 0.12;
  const cos = Math.cos(jitter);
  const sin = Math.sin(jitter);
  const jitteredAimX = aimX * cos - aimY * sin;
  const jitteredAimY = aimX * sin + aimY * cos;

  return { buttons, aimX: jitteredAimX, aimY: jitteredAimY };
}
