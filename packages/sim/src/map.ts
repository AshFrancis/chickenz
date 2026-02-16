import type { GameMap } from "./types";

/** 800×600 arena with ground + 5 floating platforms and 4 spawn points. */
export const ARENA: GameMap = {
  width: 800,
  height: 600,
  platforms: [
    // Ground
    { x: 0, y: 568, width: 800, height: 32 },
    // Lower platforms
    { x: 100, y: 450, width: 150, height: 16 },
    { x: 550, y: 450, width: 150, height: 16 },
    // Mid platforms
    { x: 300, y: 350, width: 200, height: 16 },
    // Upper platforms
    { x: 50, y: 250, width: 120, height: 16 },
    { x: 630, y: 250, width: 120, height: 16 },
  ],
  spawnPoints: [
    { x: 100, y: 536 },
    { x: 700, y: 536 },
    { x: 350, y: 318 },
    { x: 400, y: 218 },
  ],
};
