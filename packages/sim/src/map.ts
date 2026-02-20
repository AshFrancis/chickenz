import type { GameMap } from "./types";

/** 960×540 arena with ground + 5 floating platforms. Classic layout.
 *  All platform coords snapped to 16px grid for tile-based rendering. */
export const ARENA: GameMap = {
  width: 960,
  height: 540,
  platforms: [
    // Ground (2 tiles tall)
    { x: 0, y: 512, width: 960, height: 32 },
    // Lower platforms
    { x: 128, y: 416, width: 176, height: 16 },
    { x: 672, y: 416, width: 176, height: 16 },
    // Mid platform
    { x: 352, y: 304, width: 256, height: 16 },
    // Upper platforms
    { x: 64, y: 208, width: 144, height: 16 },
    { x: 752, y: 208, width: 144, height: 16 },
  ],
  spawnPoints: [
    { x: 144, y: 480 },
    { x: 832, y: 480 },
    { x: 432, y: 272 },
    { x: 480, y: 176 },
  ],
  weaponSpawnPoints: [
    { x: 192, y: 384 },
    { x: 736, y: 384 },
    { x: 464, y: 272 },
    { x: 464, y: 480 },
  ],
};

/** Vertical tower layout — tall platforms, more jumping. */
export const TOWERS: GameMap = {
  width: 960,
  height: 540,
  platforms: [
    // Ground
    { x: 0, y: 512, width: 960, height: 32 },
    // Left tower
    { x: 64, y: 400, width: 128, height: 16 },
    { x: 80, y: 256, width: 144, height: 16 },
    // Right tower
    { x: 784, y: 400, width: 128, height: 16 },
    { x: 736, y: 256, width: 144, height: 16 },
    // Center bridge
    { x: 304, y: 336, width: 352, height: 16 },
    // Top platform
    { x: 336, y: 144, width: 288, height: 16 },
  ],
  spawnPoints: [
    { x: 112, y: 480 },
    { x: 832, y: 480 },
    { x: 432, y: 304 },
    { x: 448, y: 112 },
  ],
  weaponSpawnPoints: [
    { x: 128, y: 368 },
    { x: 848, y: 368 },
    { x: 480, y: 304 },
    { x: 480, y: 112 },
  ],
};

/** Wide bridges at different heights — long horizontal fights. */
export const BRIDGES: GameMap = {
  width: 960,
  height: 540,
  platforms: [
    // Ground
    { x: 0, y: 512, width: 960, height: 32 },
    // Low bridge
    { x: 240, y: 416, width: 480, height: 16 },
    // Left shelf
    { x: 0, y: 336, width: 240, height: 16 },
    // Right shelf
    { x: 720, y: 336, width: 240, height: 16 },
    // Mid bridge
    { x: 176, y: 240, width: 608, height: 16 },
    // Top platforms
    { x: 64, y: 144, width: 176, height: 16 },
    { x: 720, y: 144, width: 176, height: 16 },
  ],
  spawnPoints: [
    { x: 112, y: 480 },
    { x: 848, y: 480 },
    { x: 368, y: 208 },
    { x: 608, y: 208 },
  ],
  weaponSpawnPoints: [
    { x: 128, y: 304 },
    { x: 848, y: 304 },
    { x: 480, y: 384 },
    { x: 480, y: 208 },
  ],
};

/** Pool of maps for round rotation. */
export const MAP_POOL: GameMap[] = [ARENA, TOWERS, BRIDGES];
