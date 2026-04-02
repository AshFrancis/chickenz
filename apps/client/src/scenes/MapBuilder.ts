import Phaser from "phaser";
import type { GameMap } from "@chickenz/sim";
import { BG_KEYS, TERRAIN_COLS, getTerrainFrame } from "./constants";

export interface MapTileResult {
  bgTile: Phaser.GameObjects.TileSprite;
  bgScrollX: number;
  bgScrollY: number;
  platformTiles: Phaser.GameObjects.Image[];
  borderTiles: Phaser.GameObjects.Image[];
}

export function buildMapTiles(
  scene: Phaser.Scene,
  hudCamera: Phaser.Cameras.Scene2D.Camera | undefined,
  map: GameMap,
  seed: number,
  oldBgTile: Phaser.GameObjects.TileSprite | null,
  oldPlatformTiles: Phaser.GameObjects.Image[],
  oldBorderTiles: Phaser.GameObjects.Image[],
): MapTileResult {
  // Destroy previous round's tiles
  for (const t of oldPlatformTiles) t.destroy();
  for (const t of oldBorderTiles) t.destroy();

  // Deterministic background: hash seed for better distribution
  // Mulberry32-style mix to spread bits evenly
  let h = seed | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
  h = (h ^ (h >>> 16)) >>> 0;
  const bgKey = BG_KEYS[h % BG_KEYS.length]!;
  const angle = (((h >>> 8) & 0xffff) / 0xffff) * Math.PI * 2;
  const bgScrollX = Math.cos(angle) * 0.3;
  const bgScrollY = Math.sin(angle) * 0.3;

  // Create/update background tileSprite clipped to arena bounds
  if (oldBgTile) oldBgTile.destroy();
  const bgTile = scene.add.tileSprite(map.width / 2, map.height / 2, map.width, map.height, bgKey).setDepth(-100);
  hudCamera?.ignore(bgTile);

  const platformTiles: Phaser.GameObjects.Image[] = [];

  for (const plat of map.platforms) {
    const tilesW = Math.max(1, Math.round(plat.width / 16));
    const tilesH = Math.max(1, Math.round(plat.height / 16));
    for (let ty = 0; ty < tilesH; ty++) {
      for (let tx = 0; tx < tilesW; tx++) {
        const frame = getTerrainFrame(tx, ty, tilesW, tilesH);
        const img = scene.add
          .image(
            plat.x + tx * 16 + 8, // center of tile
            plat.y + ty * 16 + 8,
            "terrain",
            frame,
          )
          .setDepth(0);
        hudCamera?.ignore(img);
        platformTiles.push(img);
      }
    }
  }

  // Pedestal tiles under weapon spawn points (3 tiles wide: L=17, M=18, R=19)
  // Visual content is at top ~3px of the 16x16 tile frame.
  // Position so the visual sits on the platform surface below the spawn point.
  const PEDESTAL_FRAMES = [17, 18, 19]; // col 17-19 row 0 in terrain spritesheet
  for (const sp of map.weaponSpawnPoints) {
    // Find the nearest platform surface below this spawn point
    let platformTop = map.height; // fallback to bottom
    for (const plat of map.platforms) {
      if (plat.y > sp.y && plat.y < platformTop && sp.x >= plat.x && sp.x <= plat.x + plat.width) {
        platformTop = plat.y;
      }
    }
    // Place tile so visual (top 3px of frame) rests on platform: center = platformTop + 5
    const tileY = platformTop + 5;
    for (let i = 0; i < 3; i++) {
      const img = scene.add.image(sp.x + (i - 1) * 16, tileY, "terrain", PEDESTAL_FRAMES[i]!).setDepth(0);
      hudCamera?.ignore(img);
      platformTiles.push(img);
    }
  }

  // Border tiles around arena using dark stone 9-slice (cols 0-2, rows 0-2)
  const TC = TERRAIN_COLS; // 22 tiles per row
  const B_TL = 3,
    B_T = 2 * TC + 1,
    B_TR = 4;
  const B_ML = TC + 2,
    B_MR = TC;
  const B_BL = TC + 3,
    B_B = 1,
    B_BR = TC + 4;
  const mw = map.width,
    mh = map.height;
  const tilesX = Math.ceil(mw / 16);
  const tilesY = Math.ceil(mh / 16);

  const borderTiles: Phaser.GameObjects.Image[] = [];

  const addBorder = (x: number, y: number, frame: number) => {
    const img = scene.add.image(x, y, "terrain", frame).setDepth(11);
    hudCamera?.ignore(img);
    borderTiles.push(img);
  };

  // Border shifted inward so tile content sits flush against arena edge
  const bo = -4; // outward offset
  // Left column
  for (let ty = 0; ty < tilesY; ty++) addBorder(bo, ty * 16 + 8, B_ML);
  // Right column
  for (let ty = 0; ty < tilesY; ty++) addBorder(mw - bo, ty * 16 + 8, B_MR);
  // Top row
  for (let tx = 0; tx < tilesX; tx++) addBorder(tx * 16 + 8, bo, B_T);
  // Bottom row
  for (let tx = 0; tx < tilesX; tx++) addBorder(tx * 16 + 8, mh - bo, B_B);
  // Corners on top (rendered last = highest z within same depth)
  addBorder(bo, bo, B_TL);
  addBorder(mw - bo, bo, B_TR);
  addBorder(bo, mh - bo, B_BL);
  addBorder(mw - bo, mh - bo, B_BR);

  return { bgTile, bgScrollX, bgScrollY, platformTiles, borderTiles };
}
