import type { GameMap } from "@chickenz/sim";
import { ARENA, WeaponType } from "@chickenz/sim";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TranscriptInput {
  buttons: number;
  aimX?: number;
  aimY?: number;
  aim_x?: number;
  aim_y?: number;
}

export type TickInputPair = [TranscriptInput, TranscriptInput];

// ── Color constants ──────────────────────────────────────────────────────────

export const PLAYER_COLORS = [0x4fc3f7, 0xef5350]; // blue, red
export const WALL_COLOR = 0xff0000;

// ── Terrain tileset constants ────────────────────────────────────────────────

export const TERRAIN_COLS = 22; // tiles per row in terrain spritesheet
export const GRASS_TERRAIN = { col: 6, row: 0 }; // green grass 9-slice: TL=(6,0) T=(7,0) TR=(8,0)
export const THIN_PLATFORM = { col: 12, row: 0 }; // thin platform tiles: L=(12,0) M=(13,0) R=(14,0)

// ── Character sprite constants ───────────────────────────────────────────────

export const CHARACTER_SLUGS = ["ninja-frog", "mask-dude", "pink-man", "virtual-guy"] as const;

export const CHARACTER_ANIMS = [
  { key: "idle", frames: 11, repeat: -1, rate: 20 },
  { key: "run", frames: 12, repeat: -1, rate: 20 },
  { key: "jump", frames: 1, repeat: 0, rate: 20 },
  { key: "double-jump", frames: 6, repeat: 0, rate: 20 },
  { key: "fall", frames: 1, repeat: 0, rate: 20 },
  { key: "hit", frames: 7, repeat: 0, rate: 20 },
  { key: "wall-jump", frames: 5, repeat: -1, rate: 20 },
] as const;

// ── Gun config ───────────────────────────────────────────────────────────────

/** Weapon sprite texture keys, indexed by WeaponType */
export const GUN_TEXTURES: Record<number, string> = {
  [WeaponType.Pistol]: "gun-pistol",
  [WeaponType.Shotgun]: "gun-shotgun",
  [WeaponType.Sniper]: "gun-sniper",
  [WeaponType.Rocket]: "gun-rocket",
  [WeaponType.SMG]: "gun-smg",
};

/** Per-gun visual config: position offset, scale, muzzle (shot origin), bob */
export interface GunConfig {
  offsetX: number; // from character center, before facing flip
  offsetY: number;
  scale: number;
  muzzleX: number; // from gun center, before facing flip (scaled)
  muzzleY: number;
  bobAmplitude: number; // max pixels of vertical bob (synced to anim frames)
}

export const GUN_CONFIG: Record<number, GunConfig> = {
  [WeaponType.Pistol]: { offsetX: 14, offsetY: 6.5, scale: 0.5, muzzleX: 13.5, muzzleY: -5, bobAmplitude: 0.6 },
  [WeaponType.Shotgun]: { offsetX: 4.5, offsetY: 11.5, scale: 0.5, muzzleX: 29, muzzleY: -3, bobAmplitude: 0.9 },
  [WeaponType.Sniper]: { offsetX: 7, offsetY: 8.5, scale: 0.5, muzzleX: 27, muzzleY: -2, bobAmplitude: 0.6 },
  [WeaponType.Rocket]: { offsetX: 5, offsetY: 8, scale: 0.5, muzzleX: 23.5, muzzleY: 0, bobAmplitude: 1 },
  [WeaponType.SMG]: { offsetX: 11.5, offsetY: 6.5, scale: 0.5, muzzleX: 14, muzzleY: -4.5, bobAmplitude: 1 },
};

// ── Sound config ─────────────────────────────────────────────────────────────

/** Per-character crouch/taunt sound, indexed by CHARACTER_SLUGS */
export const CROUCH_SOUNDS: Record<string, string> = {
  "ninja-frog": "frog-croak",
  "mask-dude": "ooga",
  "pink-man": "wub",
  "virtual-guy": "pop",
};

export const BG_KEYS = ["bg-blue", "bg-brown", "bg-gray", "bg-green", "bg-pink", "bg-purple", "bg-yellow"];

// ── Font ─────────────────────────────────────────────────────────────────────

export const PIXEL_FONT = '"Silkscreen", monospace';

// ── Map config ───────────────────────────────────────────────────────────────

/** Tutorial map -- ARENA with an extra high platform requiring double jump to reach. */
export const TUTORIAL_MAP: GameMap = {
  ...ARENA,
  platforms: [...ARENA.platforms, { x: 368, y: 144, width: 224, height: 16 }],
};

// ── Terrain frame calculation ────────────────────────────────────────────────

/** Compute the spritesheet frame index for a tile at (tx,ty) in a platform grid. */
export function getTerrainFrame(tx: number, ty: number, tilesW: number, tilesH: number): number {
  // Single-height platforms use dedicated thin platform tiles
  if (tilesH === 1) {
    const p = THIN_PLATFORM;
    const cx = tx === 0 ? 0 : tx === tilesW - 1 ? 2 : 1;
    return p.row * TERRAIN_COLS + (p.col + cx);
  }
  // Multi-height platforms use green grass 9-slice
  const t = GRASS_TERRAIN;
  const cx = tx === 0 ? 0 : tx === tilesW - 1 ? 2 : 1;
  const cy = ty === 0 ? 0 : ty === tilesH - 1 ? 2 : 1;
  return (t.row + cy) * TERRAIN_COLS + (t.col + cx);
}

// ── Utility functions ────────────────────────────────────────────────────────

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent smoothing: factor is the convergence rate at 60fps (16.667ms). */
export function smoothLerp(a: number, b: number, factor: number, dt: number): number {
  return a + (b - a) * (1 - Math.pow(1 - factor, dt / 16.667));
}

// ── Announce helpers (DOM) ───────────────────────────────────────────────────

const announceEl = document.getElementById("announce-text")!;
const announceOverlay = document.getElementById("announce-overlay")!;

export function showAnnounce(text: string) {
  announceEl.textContent = text;
  announceOverlay.classList.add("visible");
}

export function hideAnnounce() {
  announceOverlay.classList.remove("visible");
  announceEl.textContent = "";
}
