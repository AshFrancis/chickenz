import Phaser from "phaser";
import { GameScene } from "./scenes/GameScene";

export const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  parent: "game-container",
  backgroundColor: "#1a1a2e",
  // NO Phaser physics — sim core handles everything
  scene: [GameScene],
};
