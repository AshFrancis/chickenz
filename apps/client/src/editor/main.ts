import Phaser from "phaser";
import { initChickenzWasm } from "../wasm";
import { EditorScene } from "./EditorScene";
import { TestScene } from "./TestScene";

async function boot() {
  await initChickenzWasm();

  const container = document.getElementById("editor-container")!;

  new Phaser.Game({
    type: Phaser.AUTO,
    parent: container,
    width: 960,
    height: 540,
    pixelArt: true,
    backgroundColor: "#1a1a2e",
    scene: [EditorScene, TestScene],
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    input: {
      keyboard: true,
      mouse: true,
    },
    render: {
      antialias: false,
      roundPixels: true,
    },
  });
}

boot().catch(console.error);
