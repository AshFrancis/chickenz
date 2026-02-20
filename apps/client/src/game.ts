import Phaser from "phaser";
import { GameScene } from "./scenes/GameScene";

/**
 * Canvas fills the entire browser window at native pixel resolution.
 * DPR is height-dominant: 540 world-units always fit vertically.
 * VIEW_W/VIEW_H are the viewport dimensions in world coords.
 */
const dpr = window.devicePixelRatio || 1;
const canvasW = Math.round(window.innerWidth * dpr);
const canvasH = Math.round(window.innerHeight * dpr);

export let DPR = canvasH / 540;
export let VIEW_W = canvasW / DPR; // 960 at 16:9, wider on ultrawide
export const VIEW_H = 540;           // always 540

/** Recalculate DPR and VIEW_W from current window size. Returns new canvas pixel dimensions. */
export function recalcDimensions(): { canvasW: number; canvasH: number } {
  const d = window.devicePixelRatio || 1;
  const w = Math.round(window.innerWidth * d);
  const h = Math.round(window.innerHeight * d);
  DPR = h / 540;
  VIEW_W = w / DPR;
  return { canvasW: w, canvasH: h };
}

export const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: canvasW,
  height: canvasH,
  parent: "game-container",
  backgroundColor: "#1a1a2e",
  pixelArt: true,
  roundPixels: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  // NO Phaser physics — sim core handles everything
  scene: [GameScene],
};
