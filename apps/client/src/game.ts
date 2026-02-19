import Phaser from "phaser";
import { GameScene } from "./scenes/GameScene";

/**
 * Compute canvas size to match the native physical pixel resolution of the
 * display area, so Phaser.Scale.FIT does ~1:1 CSS scaling (no blur).
 * DPR = ratio from 960x540 game-world coords to canvas pixels.
 */
const dpr = window.devicePixelRatio || 1;
const maxW = window.innerWidth;
const maxH = window.innerHeight - 60; // top bar
const fitW = Math.min(maxW, maxH * (16 / 9));
const fitH = fitW / (16 / 9);
const canvasW = Math.round(fitW * dpr);
const canvasH = Math.round(fitH * dpr);

export const DPR = canvasW / 960;

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
