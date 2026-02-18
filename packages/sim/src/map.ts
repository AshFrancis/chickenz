import type { GameMap } from "./types";

/** 960×540 arena with ground + 5 floating platforms. Classic layout. */
export const ARENA: GameMap = {
  width: 960,
  height: 540,
  platforms: [
    // Ground
    { x: 0, y: 508, width: 960, height: 32 },
    // Lower platforms
    { x: 120, y: 410, width: 170, height: 16 },
    { x: 670, y: 410, width: 170, height: 16 },
    // Mid platform
    { x: 350, y: 310, width: 260, height: 16 },
    // Upper platforms
    { x: 60, y: 210, width: 140, height: 16 },
    { x: 760, y: 210, width: 140, height: 16 },
  ],
  spawnPoints: [
    { x: 120, y: 476 },
    { x: 840, y: 476 },
    { x: 420, y: 278 },
    { x: 480, y: 178 },
  ],
  weaponSpawnPoints: [
    { x: 193, y: 378 },
    { x: 743, y: 378 },
    { x: 468, y: 278 },
    { x: 468, y: 476 },
  ],
};

/** Vertical tower layout — tall platforms, more jumping. */
export const TOWERS: GameMap = {
  width: 960,
  height: 540,
  platforms: [
    // Ground
    { x: 0, y: 508, width: 960, height: 32 },
    // Left tower
    { x: 60, y: 400, width: 120, height: 16 },
    { x: 80, y: 260, width: 140, height: 16 },
    // Right tower
    { x: 780, y: 400, width: 120, height: 16 },
    { x: 740, y: 260, width: 140, height: 16 },
    // Center bridge
    { x: 300, y: 330, width: 360, height: 16 },
    // Top platform
    { x: 340, y: 150, width: 280, height: 16 },
  ],
  spawnPoints: [
    { x: 100, y: 476 },
    { x: 820, y: 476 },
    { x: 420, y: 298 },
    { x: 440, y: 118 },
  ],
  weaponSpawnPoints: [
    { x: 120, y: 368 },
    { x: 840, y: 368 },
    { x: 480, y: 298 },
    { x: 480, y: 118 },
  ],
};

/** Wide bridges at different heights — long horizontal fights. */
export const BRIDGES: GameMap = {
  width: 960,
  height: 540,
  platforms: [
    // Ground
    { x: 0, y: 508, width: 960, height: 32 },
    // Low bridge
    { x: 240, y: 420, width: 480, height: 16 },
    // Left shelf
    { x: 0, y: 330, width: 240, height: 16 },
    // Right shelf
    { x: 720, y: 330, width: 240, height: 16 },
    // Mid bridge
    { x: 180, y: 240, width: 600, height: 16 },
    // Top platforms
    { x: 60, y: 150, width: 180, height: 16 },
    { x: 720, y: 150, width: 180, height: 16 },
  ],
  spawnPoints: [
    { x: 100, y: 476 },
    { x: 840, y: 476 },
    { x: 360, y: 208 },
    { x: 600, y: 208 },
  ],
  weaponSpawnPoints: [
    { x: 120, y: 298 },
    { x: 840, y: 298 },
    { x: 480, y: 388 },
    { x: 480, y: 208 },
  ],
};

/** Pool of maps for round rotation. */
export const MAP_POOL: GameMap[] = [ARENA, TOWERS, BRIDGES];
