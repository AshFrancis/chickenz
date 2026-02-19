import Phaser from "phaser";
import { GameScene } from "./scenes/GameScene";

/** Device pixel ratio — capped at 2 for performance */
export const DPR = Math.min(window.devicePixelRatio || 1, 2);

export const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 960 * DPR,
  height: 540 * DPR,
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
