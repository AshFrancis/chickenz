import Phaser from "phaser";
import type { StateMessage, SerializedProjectile } from "../../../../services/server/src/protocol";
import { WEAPON_STATS, WeaponType } from "@chickenz/sim";
import { GUN_CONFIG } from "./constants";
import { PLAYER_WIDTH } from "@chickenz/sim";

/** Game state data — shared shape of StateMessage, SpectateStateMessage, and WASM exports */
type GameStateData = Omit<StateMessage, "type">;

export interface Explosion {
  x: number;
  y: number;
  timer: number;
}

export function drawProjectiles(
  g: Phaser.GameObjects.Graphics,
  curr: GameStateData,
  predicted: GameStateData | null,
  localId: number,
  replayMode: boolean,
): void {
  // Local player's bullets from predicted state (instant feedback).
  // Remote player's bullets from server state (matches their rendered position).
  const projectiles: { proj: SerializedProjectile; ownerState: GameStateData }[] = [];

  if (predicted && !replayMode) {
    for (const p of predicted.projectiles) {
      if (p.ownerId === localId) projectiles.push({ proj: p, ownerState: predicted });
    }
    for (const p of curr.projectiles) {
      if (p.ownerId !== localId) projectiles.push({ proj: p, ownerState: curr });
    }
  } else {
    for (const p of curr.projectiles) projectiles.push({ proj: p, ownerState: curr });
  }

  for (const { proj: p, ownerState } of projectiles) {
    let px = p.x;
    const gcfg = GUN_CONFIG[p.weapon];
    // Consistent Y offset: shift to gun height on every frame (avoids vertical jump)
    const yOff = gcfg ? gcfg.offsetY + gcfg.muzzleY * gcfg.scale : 0;

    // First frame only: snap X to muzzle position (forward motion masks the transition)
    const maxLife = WEAPON_STATS[p.weapon as WeaponType]?.lifetime ?? 90;
    if (p.lifetime >= maxLife - 1 && gcfg) {
      const owner = ownerState.players.find((pl) => pl.id === p.ownerId);
      if (owner) {
        // When wall sliding, gun points away from wall (same logic as gun sprite)
        const fdir = owner.wallSliding ? -(owner.facing as number) : (owner.facing as number);
        px = owner.x + PLAYER_WIDTH / 2 + fdir * (gcfg.offsetX + gcfg.muzzleX * gcfg.scale);
      }
    }

    const py = p.y + yOff;
    // Per-weapon bullet size (w × h)
    let bw: number, bh: number;
    switch (p.weapon) {
      case WeaponType.Pistol:
        bw = 3;
        bh = 2;
        break;
      case WeaponType.SMG:
        bw = 3;
        bh = 2;
        break;
      case WeaponType.Shotgun:
        bw = 4;
        bh = 2;
        break;
      case WeaponType.Sniper:
        bw = 6;
        bh = 2;
        break;
      case WeaponType.Rocket:
        bw = 6;
        bh = 4;
        break;
      default:
        bw = 3;
        bh = 2;
        break;
    }
    // Black shadow behind white rectangular bullet
    g.fillStyle(0x000000, 0.6);
    g.fillRect(px - bw / 2 - 1, py - bh / 2 - 1, bw + 2, bh + 2);
    g.fillStyle(0xffffff);
    g.fillRect(px - bw / 2, py - bh / 2, bw, bh);
  }
}

export function drawExplosions(g: Phaser.GameObjects.Graphics, explosions: Explosion[]): void {
  // Mutates the array in place (filters out expired ones)
  let write = 0;
  for (let read = 0; read < explosions.length; read++) {
    const e = explosions[read]!;
    e.timer--;
    if (e.timer <= 0) continue;
    const alpha = e.timer / 15;
    const radius = 40 * (1 - alpha * 0.5);
    g.fillStyle(0xff6600, alpha * 0.6);
    g.fillCircle(e.x, e.y, radius);
    g.fillStyle(0xffcc00, alpha * 0.4);
    g.fillCircle(e.x, e.y, radius * 0.5);
    explosions[write++] = e;
  }
  explosions.length = write;
}
