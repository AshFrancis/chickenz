import Phaser from "phaser";
import { PLAYER_WIDTH, PLAYER_HEIGHT, TICK_DT_MS } from "@chickenz/sim";
import type { GameMap } from "@chickenz/sim";
import { WasmState } from "../wasm";
import { InputManager } from "../input/InputManager";
import type { EditorMap } from "./types";
import { TILE_SIZE, MAP_WIDTH, MAP_HEIGHT, BG_KEYS } from "./types";

interface TestSceneData {
  gameMap: GameMap;
  editorMap: EditorMap;
}

export class TestScene extends Phaser.Scene {
  private wasm!: WasmState;
  private inputManager!: InputManager;
  private gameMap!: GameMap;
  private editorMap!: EditorMap;
  private tickAccum = 0;
  private lastTime = 0;

  // Player rendering
  private playerRect!: Phaser.GameObjects.Rectangle;
  private bgTile: Phaser.GameObjects.TileSprite | null = null;
  private bgScrollX = 0;
  private bgScrollY = 0;
  private backButton!: HTMLDivElement;

  constructor() {
    super({ key: "TestScene" });
  }

  init(data: TestSceneData) {
    this.gameMap = data.gameMap;
    this.editorMap = data.editorMap;
  }

  preload() {
    // Assets already loaded by EditorScene
  }

  create() {
    this.cameras.main.setBackgroundColor("#0d0d1a");

    // Initialize WASM with the custom map
    const seed = Math.floor(Math.random() * 0xffffffff);
    this.wasm = WasmState.new_warmup(seed, JSON.stringify(this.gameMap));

    this.inputManager = new InputManager();
    this.inputManager.init(this.game.canvas as HTMLCanvasElement);

    // Full-arena animated background
    const bgKey = BG_KEYS[Math.floor(Math.random() * BG_KEYS.length)]!;
    const angle = Math.random() * Math.PI * 2;
    this.bgScrollX = Math.cos(angle) * 0.3;
    this.bgScrollY = Math.sin(angle) * 0.3;
    this.bgTile = this.add
      .tileSprite(MAP_WIDTH / 2, MAP_HEIGHT / 2, MAP_WIDTH, MAP_HEIGHT, `bg-${bgKey}`)
      .setDepth(-100);

    // Mask cells — solid dark rectangles covering bg where user painted
    for (const cell of this.editorMap.bgCells) {
      const px = cell.gridX * TILE_SIZE + TILE_SIZE / 2;
      const py = cell.gridY * TILE_SIZE + TILE_SIZE / 2;
      this.add.rectangle(px, py, TILE_SIZE, TILE_SIZE, 0x0d0d1a, 1).setDepth(-90);
    }

    // Render editor tiles (visual decoration)
    for (const tile of this.editorMap.tiles) {
      const px = tile.gridX * TILE_SIZE + TILE_SIZE / 2;
      const py = tile.gridY * TILE_SIZE + TILE_SIZE / 2;
      this.add.image(px, py, "terrain", tile.frame).setAngle(tile.rotation).setDepth(tile.depth);
    }

    // Player rectangle (simple colored box) — origin top-left to match sim coords
    this.playerRect = this.add
      .rectangle(0, 0, PLAYER_WIDTH, PLAYER_HEIGHT, 0x4fc3f7, 0.8)
      .setDepth(20)
      .setOrigin(0, 0);

    // Spawn markers
    for (const spawn of this.editorMap.spawns) {
      const px = spawn.gridX * TILE_SIZE + TILE_SIZE / 2;
      const py = spawn.gridY * TILE_SIZE + TILE_SIZE / 2;
      const color = spawn.type === "player" ? 0x66bb6a : 0xffa726;
      this.add.ellipse(px, py, 8, 8, color, 0.3).setDepth(150);
    }

    // Camera
    this.cameras.main.setBounds(0, 0, MAP_WIDTH, MAP_HEIGHT);

    // Top bar with Test (stop) button
    this.backButton = document.createElement("div");
    Object.assign(this.backButton.style, {
      position: "absolute",
      top: "0",
      left: "0",
      right: "0",
      height: "40px",
      background: "#111122",
      borderBottom: "2px solid #333",
      display: "flex",
      alignItems: "center",
      padding: "0 8px",
      gap: "8px",
      zIndex: "200",
      fontFamily: '"Silkscreen", monospace',
    });
    const testBtn = document.createElement("button");
    testBtn.textContent = "Stop Test [Esc]";
    Object.assign(testBtn.style, {
      background: "#6b1a1a",
      color: "#fff",
      border: "2px solid #9d2a2a",
      padding: "4px 10px",
      fontFamily: '"Silkscreen", monospace',
      fontSize: "10px",
      cursor: "pointer",
      textTransform: "uppercase",
      letterSpacing: "1px",
    });
    testBtn.addEventListener("click", () => this.returnToEditor());
    this.backButton.appendChild(testBtn);
    const hint = document.createElement("span");
    hint.textContent = "TEST MODE — WASD to move, SPACE to jump";
    Object.assign(hint.style, { color: "#888", fontSize: "10px" });
    this.backButton.appendChild(hint);
    document.getElementById("editor-container")!.appendChild(this.backButton);

    // Escape key to exit
    this.input.keyboard!.on("keydown-ESC", () => this.returnToEditor());

    this.lastTime = performance.now();
  }

  update(_time: number, delta: number) {
    this.tickAccum += delta;

    // Step WASM at 60Hz
    while (this.tickAccum >= TICK_DT_MS) {
      this.tickAccum -= TICK_DT_MS;
      const input = this.inputManager.getPlayer1Input(0, 0);
      // Step: player 0 gets input, player 1 idle
      this.wasm.step(input.buttons, input.aimX, input.aimY, 0, 0, 0);
    }

    // Read state
    const state = this.wasm.export_state() as {
      players: { x: number; y: number; vx: number; vy: number; facing: number; health: number }[];
    };

    const p = state.players[0];
    if (p) {
      this.playerRect.setPosition(p.x, p.y);

      // Camera follow (center on player center)
      const cx = p.x + PLAYER_WIDTH / 2;
      const cy = p.y + PLAYER_HEIGHT / 2;
      this.cameras.main.centerOn(
        Phaser.Math.Clamp(cx, MAP_WIDTH * 0.3, MAP_WIDTH * 0.7),
        Phaser.Math.Clamp(cy, MAP_HEIGHT * 0.3, MAP_HEIGHT * 0.7),
      );
    }

    // Scroll background
    if (this.bgTile) {
      this.bgTile.tilePositionX += this.bgScrollX * (delta / 16.667);
      this.bgTile.tilePositionY += this.bgScrollY * (delta / 16.667);
    }
  }

  private returnToEditor() {
    // Cleanup
    this.backButton.remove();
    this.wasm.free();
    // Go back to editor with the map data
    this.scene.start("EditorScene");
    // Restore editor map after scene starts
    this.scene.get("EditorScene").events.once("create", () => {
      (this.scene.get("EditorScene") as unknown as { loadEditorMap: (m: EditorMap) => void }).loadEditorMap(
        this.editorMap,
      );
    });
  }
}
