import Phaser from "phaser";
import { History } from "./History";
import {
  BG_KEYS,
  GRID_COLS,
  MAP_HEIGHT,
  MAP_WIDTH,
  TERRAIN_COLS,
  TILE_SIZE,
  type Command,
  type EditorMap,
  type EditorSpawn,
  type EditorTile,
  type SpawnSubMode,
  type Tool,
} from "./types";

interface TileEntry {
  data: EditorTile;
  image: Phaser.GameObjects.Image;
  overlay: Phaser.GameObjects.Rectangle | null;
}

interface SpawnEntry {
  data: EditorSpawn;
  marker: Phaser.GameObjects.Ellipse;
  label: Phaser.GameObjects.Text;
}

const GRID_ROWS_CEIL = Math.ceil(MAP_HEIGHT / TILE_SIZE);

export class EditorScene extends Phaser.Scene {
  // State
  private tiles: TileEntry[] = [];
  private spawns: SpawnEntry[] = [];
  private nextTileId = 1;
  private history!: History;

  // Current tool
  private currentTool: Tool = "paint";
  private selectedFrame = 0;
  private currentCollision = true;
  private currentRotation = 0;
  private currentDepth = 0;
  private spawnSubMode: SpawnSubMode = "player";
  private bgColor: (typeof BG_KEYS)[number] = "blue";

  // Background cells — grid squares marked for bg area
  private bgCells = new Map<string, Phaser.GameObjects.Rectangle>(); // "gx,gy" → marker
  private bgCellData: { gridX: number; gridY: number }[] = [];

  // Selection
  private selectedTileEntry: TileEntry | null = null;
  private selectedSpawnEntry: SpawnEntry | null = null;
  private selectionRect: Phaser.GameObjects.Rectangle | null = null;
  private isDraggingSelected = false;
  private dragStartGrid = { x: 0, y: 0 };

  // Grid
  private gridGraphics!: Phaser.GameObjects.Graphics;

  // Painting state
  private isPointerDown = false;
  private lastPaintGrid = { x: -1, y: -1 };

  // DOM elements
  private toolbar!: HTMLDivElement;
  private palette!: HTMLDivElement;
  private propsPanel!: HTMLDivElement;
  private paletteCells = new Map<number, HTMLDivElement>(); // frame → cell element

  // Tool buttons (for active state toggling)
  private toolButtons = new Map<Tool, HTMLButtonElement>();

  constructor() {
    super({ key: "EditorScene" });
  }

  preload() {
    this.load.spritesheet("terrain", "/sprites/terrain.png", {
      frameWidth: TILE_SIZE,
      frameHeight: TILE_SIZE,
    });
    for (const name of BG_KEYS) {
      this.load.image(`bg-${name}`, `/sprites/bg-${name}.png`);
    }
  }

  create() {
    this.cameras.main.setBackgroundColor("#1a1a2e");
    this.cameras.main.setBounds(-100, -100, MAP_WIDTH + 200, MAP_HEIGHT + 200);
    this.cameras.main.centerOn(MAP_WIDTH / 2, MAP_HEIGHT / 2);

    // Arena bounds rectangle
    const bounds = this.add.graphics().setDepth(-95);
    bounds.fillStyle(0x0d0d1a, 1);
    bounds.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    bounds.lineStyle(2, 0x444444, 1);
    bounds.strokeRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

    // Grid overlay
    this.gridGraphics = this.add.graphics().setDepth(100);
    this.drawGrid();

    // History
    this.history = new History(() => this.updateHistoryButtons());

    // DOM UI
    this.buildToolbar();
    this.buildPalette();
    this.buildPropsPanel();

    // Input
    this.setupInput();
    this.setupKeyboard();

    // Camera controls
    this.setupCamera();
  }

  // ─── Grid ──────────────────────────────────────────────

  private drawGrid() {
    const g = this.gridGraphics;
    g.clear();
    g.lineStyle(1, 0xffffff, 0.08);
    for (let x = 0; x <= MAP_WIDTH; x += TILE_SIZE) {
      g.moveTo(x, 0);
      g.lineTo(x, MAP_HEIGHT);
    }
    for (let y = 0; y <= MAP_HEIGHT; y += TILE_SIZE) {
      g.moveTo(0, y);
      g.lineTo(MAP_WIDTH, y);
    }
    g.strokePath();
  }

  // ─── DOM: Toolbar ──────────────────────────────────────

  private buildToolbar() {
    this.toolbar = document.createElement("div");
    this.toolbar.id = "editor-toolbar";
    Object.assign(this.toolbar.style, {
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
      gap: "4px",
      zIndex: "100",
      fontFamily: '"Silkscreen", monospace',
    });

    const tools: { tool: Tool; label: string; key: string }[] = [
      { tool: "paint", label: "Paint", key: "1" },
      { tool: "erase", label: "Erase", key: "2" },
      { tool: "select", label: "Select", key: "3" },
      { tool: "spawn", label: "Spawn", key: "4" },
      { tool: "bg", label: "BG", key: "5" },
    ];

    for (const { tool, label, key } of tools) {
      const btn = this.makeToolbarBtn(`${label} [${key}]`, tool === this.currentTool);
      btn.addEventListener("click", () => this.setTool(tool));
      this.toolbar.appendChild(btn);
      this.toolButtons.set(tool, btn);
    }

    this.addSeparator();

    const btnUndo = this.makeToolbarBtn("Undo");
    btnUndo.id = "btn-undo";
    btnUndo.addEventListener("click", () => this.history.undo());
    this.toolbar.appendChild(btnUndo);

    const btnRedo = this.makeToolbarBtn("Redo");
    btnRedo.id = "btn-redo";
    btnRedo.addEventListener("click", () => this.history.redo());
    this.toolbar.appendChild(btnRedo);

    this.addSeparator();

    const btnTest = this.makeToolbarBtn("Test", false, "#1a6b3c", "#2a9d5c");
    btnTest.addEventListener("click", () => this.startTest());
    this.toolbar.appendChild(btnTest);

    const btnExport = this.makeToolbarBtn("Export");
    btnExport.addEventListener("click", () => this.exportEditorMap());
    this.toolbar.appendChild(btnExport);

    const btnExportGame = this.makeToolbarBtn("Export GameMap");
    btnExportGame.addEventListener("click", () => this.exportGameMap());
    this.toolbar.appendChild(btnExportGame);

    const btnImport = this.makeToolbarBtn("Import");
    btnImport.addEventListener("click", () => this.importEditorMap());
    this.toolbar.appendChild(btnImport);

    const btnClear = this.makeToolbarBtn("Clear");
    btnClear.addEventListener("click", () => this.clearAll());
    this.toolbar.appendChild(btnClear);

    document.getElementById("editor-container")!.appendChild(this.toolbar);
  }

  private makeToolbarBtn(label: string, active = false, bg = "#333", border = "#555"): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = label;
    Object.assign(btn.style, {
      background: active ? "#444" : bg,
      color: active ? "#ffee58" : "#ccc",
      border: `2px solid ${active ? "#ffee58" : border}`,
      padding: "4px 10px",
      fontFamily: '"Silkscreen", monospace',
      fontSize: "10px",
      cursor: "pointer",
      whiteSpace: "nowrap",
      textTransform: "uppercase",
      letterSpacing: "1px",
    });
    btn.addEventListener("mouseenter", () => {
      if (!btn.style.color?.includes("ffee58")) btn.style.color = "#fff";
    });
    btn.addEventListener("mouseleave", () => {
      if (!btn.style.color?.includes("ffee58")) btn.style.color = "#ccc";
    });
    return btn;
  }

  private addSeparator() {
    const sep = document.createElement("div");
    Object.assign(sep.style, {
      width: "1px",
      height: "20px",
      background: "#555",
      margin: "0 4px",
    });
    this.toolbar.appendChild(sep);
  }

  // ─── DOM: Tile Palette ────────────────────────────────

  private buildPalette() {
    const S = 32; // display size per tile (2× zoom)
    const GAP = 2; // gap between cells
    const COLS = 3;
    const PALETTE_W = COLS * S + (COLS - 1) * GAP + 16; // cells + gaps + padding

    this.palette = document.createElement("div");
    this.palette.id = "editor-palette";
    Object.assign(this.palette.style, {
      position: "absolute",
      top: "42px",
      left: "0",
      width: `${PALETTE_W}px`,
      bottom: "0",
      background: "#111122",
      borderRight: "2px solid #333",
      overflowY: "auto",
      zIndex: "100",
      padding: "6px",
    });

    const label = document.createElement("div");
    label.textContent = "TILES";
    Object.assign(label.style, {
      color: "#ffee58",
      fontFamily: '"Silkscreen", monospace',
      fontSize: "10px",
      textAlign: "center",
      padding: "4px 0 6px",
      letterSpacing: "2px",
    });
    this.palette.appendChild(label);

    // Custom palette layout: each entry is [col, row] or null (gap).
    // 3 entries per visual row. null-null-null = separator row.
    // prettier-ignore
    const layout: ([number, number] | null)[] = [
      // ── Dark stone 9-slice ──
      [0,0],[1,0],[2,0],  [0,1],[1,1],[2,1],  [0,2],[1,2],[2,2],
      [3,0],[4,0],null,   [3,1],[4,1],null,
      null,null,null,
      // ── Green grass 9-slice ──
      [6,0],[7,0],[8,0],  [6,1],[7,1],[8,1],  [6,2],[7,2],[8,2],
      [9,0],[10,0],null,  [9,1],[10,1],null,
      null,null,null,
      // ── Thin platforms + pedestals ──
      [12,0],[13,0],[14,0],
      [13,1],[14,1],[15,0],
      [13,2],[14,2],[15,1],
      [12,1],null,[15,2],
      null,null,null,
      // ── Pedestal ──
      [17,0],[18,0],[19,0],  [17,1],[18,1],[19,1],  [17,2],[18,2],[19,2],
      null,null,null,
      // ── Brown terrain 9-slice ──
      [0,4],[1,4],[2,4],  [0,5],[1,5],[2,5],  [0,6],[1,6],[2,6],
      [3,4],[4,4],null,   [3,5],[4,5],null,
      null,null,null,
      // ── Teal/cyan 9-slice ──
      [6,4],[7,4],[8,4],  [6,5],[7,5],[8,5],  [6,6],[7,6],[8,6],
      [9,4],[10,4],null,  [9,5],[10,5],null,
      null,null,null,
      // ── Thin platforms variant 2 ──
      [12,4],[13,4],[14,4],
      [13,5],[14,5],[15,4],
      [13,6],[14,6],[15,5],
      [12,5],null,[15,6],
      null,null,null,
      // ── Pedestal variant 2 ──
      [17,4],[18,4],[19,4],  [17,5],[18,5],[19,5],  [17,6],[18,6],[19,6],
      [20,4],[21,4],null,    [20,5],[21,5],null,
      null,null,null,
      // ── Purple terrain 9-slice ──
      [0,8],[1,8],[2,8],  [0,9],[1,9],[2,9],  [0,10],[1,10],[2,10],
      [3,8],[4,8],null,   [3,9],[4,9],null,
      null,null,null,
      // ── Pink terrain 9-slice ──
      [6,8],[7,8],[8,8],  [6,9],[7,9],[8,9],  [6,10],[7,10],[8,10],
      [9,8],[10,8],null,  [9,9],[10,9],null,
      null,null,null,
      // ── Thin platforms variant 3 ──
      [12,8],[13,8],[14,8],
      [13,9],[14,9],[15,8],
      [13,10],[14,10],[15,9],
      [12,9],null,[15,10],
      null,null,null,
      // ── Last group ──
      [17,0],[18,0],[19,0],
      [18,9],[19,9],[20,8],
      [18,10],[19,10],[20,9],
      [17,9],null,[20,10],
    ];

    const terrainTex = this.textures.get("terrain");
    const source = terrainTex.getSourceImage() as HTMLImageElement;

    const grid = document.createElement("div");
    Object.assign(grid.style, {
      display: "grid",
      gridTemplateColumns: `repeat(${COLS}, ${S}px)`,
      gap: `${GAP}px`,
    });

    this.paletteCells.clear();

    for (let i = 0; i < layout.length; i++) {
      const entry = layout[i]!;

      if (entry === null) {
        // Check if entire row is null → separator
        const rowStart = i - (i % COLS);
        const allNull = layout.slice(rowStart, rowStart + COLS).every((e) => e === null);
        const spacer = document.createElement("div");
        if (allNull && i % COLS === 0) {
          spacer.style.height = "4px";
          spacer.style.gridColumn = `1 / ${COLS + 1}`;
          spacer.style.borderBottom = "1px solid #2a2a3a";
          grid.appendChild(spacer);
          i += COLS - 1; // skip rest of separator row
        } else {
          // Empty cell in a non-separator row
          spacer.style.width = `${S}px`;
          spacer.style.height = `${S}px`;
          grid.appendChild(spacer);
        }
        continue;
      }

      const [col, row] = entry;
      const frame = row * TERRAIN_COLS + col;

      const cell = document.createElement("div");
      Object.assign(cell.style, {
        width: `${S}px`,
        height: `${S}px`,
        border: frame === this.selectedFrame ? "2px solid #ffee58" : "1px solid #333",
        boxSizing: "border-box",
        cursor: "pointer",
        imageRendering: "pixelated",
      });

      const cvs = document.createElement("canvas");
      cvs.width = TILE_SIZE;
      cvs.height = TILE_SIZE;
      Object.assign(cvs.style, {
        width: "100%",
        height: "100%",
        display: "block",
        imageRendering: "pixelated",
      });
      const ctx = cvs.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(source, col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE, 0, 0, TILE_SIZE, TILE_SIZE);
      cell.appendChild(cvs);

      cell.addEventListener("click", () => {
        this.selectedFrame = frame;
        this.updatePaletteSelection();
      });

      grid.appendChild(cell);
      this.paletteCells.set(frame, cell);
    }

    this.palette.appendChild(grid);
    document.getElementById("editor-container")!.appendChild(this.palette);
  }

  private updatePaletteSelection() {
    this.paletteCells.forEach((cell, frame) => {
      cell.style.border = frame === this.selectedFrame ? "2px solid #ffee58" : "1px solid #333";
    });
  }

  // ─── DOM: Properties Panel ────────────────────────────

  private buildPropsPanel() {
    this.propsPanel = document.createElement("div");
    this.propsPanel.id = "editor-props";
    Object.assign(this.propsPanel.style, {
      position: "absolute",
      top: "42px",
      right: "0",
      width: "140px",
      bottom: "0",
      background: "#111122",
      borderLeft: "2px solid #333",
      zIndex: "100",
      padding: "8px",
      fontFamily: '"Silkscreen", monospace',
      fontSize: "10px",
      color: "#ccc",
      overflowY: "auto",
    });

    this.propsPanel.innerHTML = `
      <div style="color:#ffee58;text-align:center;padding:4px 0;letter-spacing:2px;margin-bottom:8px">PROPS</div>

      <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;cursor:pointer">
        <input type="checkbox" id="prop-collision" checked style="accent-color:#66bb6a" />
        <span>Collision</span>
      </label>

      <div style="margin-bottom:8px">
        <div style="margin-bottom:4px">Rotation</div>
        <div style="display:flex;gap:2px">
          <button class="rot-btn" data-rot="0" style="background:#444;color:#ffee58;border:1px solid #ffee58;padding:2px 6px;cursor:pointer;font-family:inherit;font-size:10px">0</button>
          <button class="rot-btn" data-rot="90" style="background:#333;color:#ccc;border:1px solid #555;padding:2px 6px;cursor:pointer;font-family:inherit;font-size:10px">90</button>
          <button class="rot-btn" data-rot="180" style="background:#333;color:#ccc;border:1px solid #555;padding:2px 6px;cursor:pointer;font-family:inherit;font-size:10px">180</button>
          <button class="rot-btn" data-rot="270" style="background:#333;color:#ccc;border:1px solid #555;padding:2px 6px;cursor:pointer;font-family:inherit;font-size:10px">270</button>
        </div>
      </div>

      <div style="margin-bottom:8px">
        <div style="margin-bottom:4px">Depth</div>
        <input type="number" id="prop-depth" value="0" min="-10" max="100"
          style="width:60px;background:#222;border:1px solid #555;color:#ccc;padding:2px 4px;font-family:inherit;font-size:10px" />
      </div>

      <div style="border-top:1px solid #333;padding-top:8px;margin-top:8px">
        <div style="margin-bottom:4px">Spawn Mode</div>
        <div style="display:flex;gap:2px">
          <button id="spawn-player" style="background:#444;color:#66bb6a;border:1px solid #66bb6a;padding:2px 6px;cursor:pointer;font-family:inherit;font-size:10px">Player</button>
          <button id="spawn-weapon" style="background:#333;color:#ccc;border:1px solid #555;padding:2px 6px;cursor:pointer;font-family:inherit;font-size:10px">Weapon</button>
        </div>
      </div>

      <div id="selection-info" style="border-top:1px solid #333;padding-top:8px;margin-top:8px;display:none">
        <div style="color:#ffee58;margin-bottom:4px">SELECTED</div>
        <div id="sel-frame" style="margin-bottom:2px">Frame: -</div>
        <div id="sel-pos" style="margin-bottom:2px">Pos: -</div>
        <button id="btn-delete-sel" style="background:#6b1a1a;color:#ccc;border:1px solid #9d2a2a;padding:2px 8px;cursor:pointer;font-family:inherit;font-size:10px;margin-top:4px">Delete</button>
      </div>
    `;

    document.getElementById("editor-container")!.appendChild(this.propsPanel);

    // Wire up collision checkbox
    const collCheck = this.propsPanel.querySelector("#prop-collision") as HTMLInputElement;
    collCheck.addEventListener("change", () => {
      this.currentCollision = collCheck.checked;
      if (this.selectedTileEntry) {
        const entry = this.selectedTileEntry;
        const oldVal = entry.data.collision;
        this.history.execute({
          execute: () => {
            entry.data.collision = collCheck.checked;
            this.updateTileOverlay(entry);
          },
          undo: () => {
            entry.data.collision = oldVal;
            collCheck.checked = oldVal;
            this.updateTileOverlay(entry);
          },
        });
      }
    });

    // Rotation buttons
    this.propsPanel.querySelectorAll(".rot-btn").forEach((btn) => {
      (btn as HTMLButtonElement).addEventListener("click", () => {
        const rot = parseInt((btn as HTMLElement).dataset.rot!);
        this.currentRotation = rot;
        this.updateRotationButtons();
        if (this.selectedTileEntry) {
          const entry = this.selectedTileEntry;
          const oldRot = entry.data.rotation;
          this.history.execute({
            execute: () => {
              entry.data.rotation = rot;
              entry.image.setAngle(rot);
            },
            undo: () => {
              entry.data.rotation = oldRot;
              entry.image.setAngle(oldRot);
              this.currentRotation = oldRot;
              this.updateRotationButtons();
            },
          });
        }
      });
    });

    // Depth input
    const depthInput = this.propsPanel.querySelector("#prop-depth") as HTMLInputElement;
    depthInput.addEventListener("change", () => {
      this.currentDepth = parseInt(depthInput.value) || 0;
      if (this.selectedTileEntry) {
        const entry = this.selectedTileEntry;
        const oldDepth = entry.data.depth;
        const newDepth = this.currentDepth;
        this.history.execute({
          execute: () => {
            entry.data.depth = newDepth;
            entry.image.setDepth(newDepth);
            if (entry.overlay) entry.overlay.setDepth(newDepth + 0.1);
          },
          undo: () => {
            entry.data.depth = oldDepth;
            entry.image.setDepth(oldDepth);
            if (entry.overlay) entry.overlay.setDepth(oldDepth + 0.1);
            depthInput.value = String(oldDepth);
          },
        });
      }
    });

    // Spawn sub-mode buttons
    const spawnPlayer = this.propsPanel.querySelector("#spawn-player") as HTMLButtonElement;
    const spawnWeapon = this.propsPanel.querySelector("#spawn-weapon") as HTMLButtonElement;
    spawnPlayer.addEventListener("click", () => {
      this.spawnSubMode = "player";
      this.updateSpawnButtons();
    });
    spawnWeapon.addEventListener("click", () => {
      this.spawnSubMode = "weapon";
      this.updateSpawnButtons();
    });

    // Delete selection
    const btnDelete = this.propsPanel.querySelector("#btn-delete-sel") as HTMLButtonElement;
    btnDelete.addEventListener("click", () => this.deleteSelected());
  }

  private updateRotationButtons() {
    this.propsPanel.querySelectorAll(".rot-btn").forEach((btn) => {
      const rot = parseInt((btn as HTMLElement).dataset.rot!);
      const active = rot === this.currentRotation;
      (btn as HTMLElement).style.background = active ? "#444" : "#333";
      (btn as HTMLElement).style.color = active ? "#ffee58" : "#ccc";
      (btn as HTMLElement).style.borderColor = active ? "#ffee58" : "#555";
    });
  }

  private updateSpawnButtons() {
    const sp = this.propsPanel.querySelector("#spawn-player") as HTMLElement;
    const sw = this.propsPanel.querySelector("#spawn-weapon") as HTMLElement;
    const isPlayer = this.spawnSubMode === "player";
    sp.style.background = isPlayer ? "#444" : "#333";
    sp.style.color = isPlayer ? "#66bb6a" : "#ccc";
    sp.style.borderColor = isPlayer ? "#66bb6a" : "#555";
    sw.style.background = !isPlayer ? "#444" : "#333";
    sw.style.color = !isPlayer ? "#ffa726" : "#ccc";
    sw.style.borderColor = !isPlayer ? "#ffa726" : "#555";
  }

  private updateHistoryButtons() {
    const undoBtn = document.getElementById("btn-undo") as HTMLButtonElement | null;
    const redoBtn = document.getElementById("btn-redo") as HTMLButtonElement | null;
    if (undoBtn) undoBtn.style.opacity = this.history.canUndo ? "1" : "0.4";
    if (redoBtn) redoBtn.style.opacity = this.history.canRedo ? "1" : "0.4";
  }

  // ─── Tool switching ───────────────────────────────────

  private setTool(tool: Tool) {
    this.currentTool = tool;
    this.deselectTile();
    this.toolButtons.forEach((btn, t) => {
      const active = t === tool;
      btn.style.background = active ? "#444" : "#333";
      btn.style.color = active ? "#ffee58" : "#ccc";
      btn.style.borderColor = active ? "#ffee58" : "#555";
    });
    // Update cursor
    const canvas = this.game.canvas;
    switch (tool) {
      case "paint":
        canvas.style.cursor = "crosshair";
        break;
      case "erase":
        canvas.style.cursor = "not-allowed";
        break;
      case "select":
        canvas.style.cursor = "pointer";
        break;
      case "spawn":
        canvas.style.cursor = "cell";
        break;
      case "bg":
        canvas.style.cursor = "crosshair";
        break;
    }
  }

  // ─── Canvas Input ─────────────────────────────────────

  private setupInput() {
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      // Ignore if over DOM panels
      if (this.isOverUI(pointer)) return;
      // Middle mouse for camera pan is handled by setupCamera
      if (pointer.middleButtonDown()) return;

      this.isPointerDown = true;
      const worldX = pointer.worldX;
      const worldY = pointer.worldY;
      const gx = Math.floor(worldX / TILE_SIZE);
      const gy = Math.floor(worldY / TILE_SIZE);

      if (gx < 0 || gx >= GRID_COLS || gy < 0 || gy >= GRID_ROWS_CEIL) return;

      switch (this.currentTool) {
        case "paint":
          if (pointer.event.shiftKey) {
            this.floodFill(gx, gy);
          } else {
            this.paintTile(gx, gy);
            this.lastPaintGrid = { x: gx, y: gy };
          }
          break;
        case "erase":
          this.eraseTile(gx, gy, pointer.event.shiftKey);
          this.lastPaintGrid = { x: gx, y: gy };
          break;
        case "select":
          this.handleSelect(gx, gy, worldX, worldY);
          break;
        case "spawn":
          this.placeSpawn(gx, gy);
          break;
        case "bg":
          if (pointer.event.shiftKey) {
            this.removeBgCell(gx, gy);
          } else {
            this.paintBgCell(gx, gy);
          }
          this.lastPaintGrid = { x: gx, y: gy };
          break;
      }
    });

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!this.isPointerDown || pointer.middleButtonDown()) return;
      if (this.isOverUI(pointer)) return;

      const gx = Math.floor(pointer.worldX / TILE_SIZE);
      const gy = Math.floor(pointer.worldY / TILE_SIZE);
      if (gx < 0 || gx >= GRID_COLS || gy < 0 || gy >= GRID_ROWS_CEIL) return;
      if (gx === this.lastPaintGrid.x && gy === this.lastPaintGrid.y) return;

      switch (this.currentTool) {
        case "paint":
          this.paintTile(gx, gy);
          break;
        case "erase":
          this.eraseTile(gx, gy, false);
          break;
        case "select":
          if (this.isDraggingSelected && this.selectedTileEntry) {
            this.dragSelectedTo(gx, gy);
          }
          break;
        case "bg":
          if (pointer.event.shiftKey) {
            this.removeBgCell(gx, gy);
          } else {
            this.paintBgCell(gx, gy);
          }
          break;
      }
      this.lastPaintGrid = { x: gx, y: gy };
    });

    this.input.on("pointerup", () => {
      this.isPointerDown = false;
      this.isDraggingSelected = false;
      this.lastPaintGrid = { x: -1, y: -1 };
    });
  }

  private isOverUI(pointer: Phaser.Input.Pointer): boolean {
    const evt = pointer.event as MouseEvent;
    const el = document.elementFromPoint(evt.clientX, evt.clientY);
    if (!el) return false;
    return !!el.closest("#editor-toolbar") || !!el.closest("#editor-palette") || !!el.closest("#editor-props");
  }

  private setupKeyboard() {
    this.input.keyboard!.on("keydown", (e: KeyboardEvent) => {
      // Prevent shortcuts when typing in an input
      if ((e.target as HTMLElement).tagName === "INPUT") return;

      if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        this.history.undo();
      } else if (
        (e.key === "z" && (e.ctrlKey || e.metaKey) && e.shiftKey) ||
        (e.key === "y" && (e.ctrlKey || e.metaKey))
      ) {
        e.preventDefault();
        this.history.redo();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        this.deleteSelected();
      } else if (e.key === "r" || e.key === "R") {
        this.currentRotation = (this.currentRotation + 90) % 360;
        this.updateRotationButtons();
      } else if (e.key === "1") this.setTool("paint");
      else if (e.key === "2") this.setTool("erase");
      else if (e.key === "3") this.setTool("select");
      else if (e.key === "4") this.setTool("spawn");
      else if (e.key === "5") this.setTool("bg");
    });
  }

  private setupCamera() {
    // Scroll to zoom
    this.input.on("wheel", (_pointer: Phaser.Input.Pointer, _gx: number[], _gy: number[], deltaY: number) => {
      const cam = this.cameras.main;
      const newZoom = Phaser.Math.Clamp(cam.zoom + (deltaY > 0 ? -0.1 : 0.1), 0.5, 4);
      cam.setZoom(newZoom);
    });

    // Middle-mouse drag to pan
    let panStart: { x: number; y: number } | null = null;
    let camStart: { x: number; y: number } | null = null;

    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.middleButtonDown()) {
        panStart = { x: pointer.x, y: pointer.y };
        camStart = { x: this.cameras.main.scrollX, y: this.cameras.main.scrollY };
      }
    });
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (panStart && camStart && pointer.middleButtonDown()) {
        const dx = pointer.x - panStart.x;
        const dy = pointer.y - panStart.y;
        this.cameras.main.scrollX = camStart.x - dx / this.cameras.main.zoom;
        this.cameras.main.scrollY = camStart.y - dy / this.cameras.main.zoom;
      }
    });
    this.input.on("pointerup", (pointer: Phaser.Input.Pointer) => {
      if (!pointer.middleButtonDown()) {
        panStart = null;
        camStart = null;
      }
    });
  }

  // ─── Tile Placement ───────────────────────────────────

  private paintTile(gx: number, gy: number) {
    const tile: EditorTile = {
      id: this.nextTileId++,
      gridX: gx,
      gridY: gy,
      frame: this.selectedFrame,
      rotation: this.currentRotation,
      collision: this.currentCollision,
      depth: this.currentDepth,
    };

    const cmd: Command = {
      execute: () => this.addTileEntry(tile),
      undo: () => this.removeTileEntryById(tile.id),
    };
    this.history.execute(cmd);
  }

  private addTileEntry(tile: EditorTile): TileEntry {
    const px = tile.gridX * TILE_SIZE + TILE_SIZE / 2;
    const py = tile.gridY * TILE_SIZE + TILE_SIZE / 2;
    const image = this.add.image(px, py, "terrain", tile.frame).setAngle(tile.rotation).setDepth(tile.depth);

    let overlay: Phaser.GameObjects.Rectangle | null = null;
    if (tile.collision) {
      overlay = this.add.rectangle(px, py, TILE_SIZE, TILE_SIZE, 0xff0000, 0.2).setDepth(tile.depth + 0.1);
    }

    const entry: TileEntry = { data: tile, image, overlay };
    this.tiles.push(entry);
    return entry;
  }

  private removeTileEntryById(id: number) {
    const idx = this.tiles.findIndex((e) => e.data.id === id);
    if (idx === -1) return;
    const entry = this.tiles[idx]!;
    entry.image.destroy();
    if (entry.overlay) entry.overlay.destroy();
    this.tiles.splice(idx, 1);
    if (this.selectedTileEntry === entry) this.deselectTile();
  }

  private updateTileOverlay(entry: TileEntry) {
    if (entry.overlay) {
      entry.overlay.destroy();
      entry.overlay = null;
    }
    if (entry.data.collision) {
      const px = entry.data.gridX * TILE_SIZE + TILE_SIZE / 2;
      const py = entry.data.gridY * TILE_SIZE + TILE_SIZE / 2;
      entry.overlay = this.add.rectangle(px, py, TILE_SIZE, TILE_SIZE, 0xff0000, 0.2).setDepth(entry.data.depth + 0.1);
    }
  }

  // ─── Erase ────────────────────────────────────────────

  private eraseTile(gx: number, gy: number, all: boolean) {
    // Check for spawns at this position first
    const spawnAt = this.spawns.find((s) => s.data.gridX === gx && s.data.gridY === gy);
    if (spawnAt) {
      const saved = { ...spawnAt.data };
      const cmd: Command = {
        execute: () => this.removeSpawnByPos(saved.type, saved.gridX, saved.gridY),
        undo: () => this.addSpawnEntry(saved),
      };
      this.history.execute(cmd);
      if (!all) return;
    }

    const at = this.tiles.filter((e) => e.data.gridX === gx && e.data.gridY === gy);
    if (at.length === 0) return;

    if (all) {
      const removed = at.map((e) => ({ ...e.data }));
      const cmd: Command = {
        execute: () => {
          for (const d of removed) this.removeTileEntryById(d.id);
        },
        undo: () => {
          for (const d of removed) this.addTileEntry(d);
        },
      };
      this.history.execute(cmd);
    } else {
      // Remove topmost (highest depth, or last added)
      const topmost = at.reduce((a, b) =>
        b.data.depth > a.data.depth || (b.data.depth === a.data.depth && b.data.id > a.data.id) ? b : a,
      );
      const saved = { ...topmost.data };
      const cmd: Command = {
        execute: () => this.removeTileEntryById(saved.id),
        undo: () => this.addTileEntry(saved),
      };
      this.history.execute(cmd);
    }
  }

  // ─── Flood Fill ───────────────────────────────────────

  private floodFill(startX: number, startY: number) {
    // Only fill empty cells
    const occupied = new Set<string>();
    for (const t of this.tiles) {
      occupied.add(`${t.data.gridX},${t.data.gridY}`);
    }
    if (occupied.has(`${startX},${startY}`)) return;

    const filled: EditorTile[] = [];
    const visited = new Set<string>();
    const queue: [number, number][] = [[startX, startY]];

    while (queue.length > 0) {
      const [x, y] = queue.shift()!;
      const key = `${x},${y}`;
      if (visited.has(key)) continue;
      if (x < 0 || x >= GRID_COLS || y < 0 || y >= GRID_ROWS_CEIL) continue;
      if (occupied.has(key)) continue;
      visited.add(key);

      filled.push({
        id: this.nextTileId++,
        gridX: x,
        gridY: y,
        frame: this.selectedFrame,
        rotation: this.currentRotation,
        collision: this.currentCollision,
        depth: this.currentDepth,
      });

      queue.push([x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]);
    }

    if (filled.length === 0) return;

    const cmd: Command = {
      execute: () => {
        for (const tile of filled) this.addTileEntry(tile);
      },
      undo: () => {
        for (const tile of filled) this.removeTileEntryById(tile.id);
      },
    };
    this.history.execute(cmd);
  }

  // ─── Select ───────────────────────────────────────────

  private handleSelect(gx: number, gy: number, _worldX: number, _worldY: number) {
    // Check for spawns first (they render on top)
    const spawnAt = this.spawns.find((s) => s.data.gridX === gx && s.data.gridY === gy);
    if (spawnAt) {
      this.deselectTile();
      this.selectSpawn(spawnAt);
      this.isDraggingSelected = true;
      this.dragStartGrid = { x: gx, y: gy };
      return;
    }

    const at = this.tiles.filter((e) => e.data.gridX === gx && e.data.gridY === gy);
    if (at.length === 0) {
      this.deselectTile();
      return;
    }
    // Select topmost
    const topmost = at.reduce((a, b) =>
      b.data.depth > a.data.depth || (b.data.depth === a.data.depth && b.data.id > a.data.id) ? b : a,
    );
    this.selectTile(topmost);
    this.isDraggingSelected = true;
    this.dragStartGrid = { x: gx, y: gy };
  }

  private selectTile(entry: TileEntry) {
    this.deselectTile();
    this.selectedTileEntry = entry;

    // Show selection rectangle
    const px = entry.data.gridX * TILE_SIZE + TILE_SIZE / 2;
    const py = entry.data.gridY * TILE_SIZE + TILE_SIZE / 2;
    this.selectionRect = this.add
      .rectangle(px, py, TILE_SIZE + 2, TILE_SIZE + 2)
      .setStrokeStyle(1, 0xffee58)
      .setFillStyle(0, 0)
      .setDepth(999);

    // Update props panel
    const selInfo = this.propsPanel.querySelector("#selection-info") as HTMLElement;
    selInfo.style.display = "block";
    (this.propsPanel.querySelector("#sel-frame") as HTMLElement).textContent = `Frame: ${entry.data.frame}`;
    (this.propsPanel.querySelector("#sel-pos") as HTMLElement).textContent =
      `Pos: ${entry.data.gridX}, ${entry.data.gridY}`;

    // Sync props
    (this.propsPanel.querySelector("#prop-collision") as HTMLInputElement).checked = entry.data.collision;
    this.currentRotation = entry.data.rotation;
    this.updateRotationButtons();
    (this.propsPanel.querySelector("#prop-depth") as HTMLInputElement).value = String(entry.data.depth);
  }

  private selectSpawn(entry: SpawnEntry) {
    this.deselectTile();
    this.selectedSpawnEntry = entry;

    const px = entry.data.gridX * TILE_SIZE + TILE_SIZE / 2;
    const py = entry.data.gridY * TILE_SIZE + TILE_SIZE / 2;
    this.selectionRect = this.add
      .rectangle(px, py, TILE_SIZE + 2, TILE_SIZE + 2)
      .setStrokeStyle(1, 0xffee58)
      .setFillStyle(0, 0)
      .setDepth(999);

    const selInfo = this.propsPanel.querySelector("#selection-info") as HTMLElement;
    selInfo.style.display = "block";
    (this.propsPanel.querySelector("#sel-frame") as HTMLElement).textContent =
      `Spawn: ${entry.data.type}`;
    (this.propsPanel.querySelector("#sel-pos") as HTMLElement).textContent =
      `Pos: ${entry.data.gridX}, ${entry.data.gridY}`;
  }

  private deselectTile() {
    if (this.selectionRect) {
      this.selectionRect.destroy();
      this.selectionRect = null;
    }
    this.selectedTileEntry = null;
    this.selectedSpawnEntry = null;
    const selInfo = this.propsPanel?.querySelector("#selection-info") as HTMLElement | null;
    if (selInfo) selInfo.style.display = "none";
  }

  private dragSelectedTo(gx: number, gy: number) {
    if (this.selectedSpawnEntry) {
      const entry = this.selectedSpawnEntry;
      if (gx === entry.data.gridX && gy === entry.data.gridY) return;
      entry.data.gridX = gx;
      entry.data.gridY = gy;
      const px = gx * TILE_SIZE + TILE_SIZE / 2;
      const py = gy * TILE_SIZE + TILE_SIZE / 2;
      entry.marker.setPosition(px, py);
      entry.label.setPosition(px, py - 10);
      if (this.selectionRect) this.selectionRect.setPosition(px, py);
      (this.propsPanel.querySelector("#sel-pos") as HTMLElement).textContent = `Pos: ${gx}, ${gy}`;
      return;
    }

    if (!this.selectedTileEntry) return;
    const entry = this.selectedTileEntry;
    const oldX = entry.data.gridX;
    const oldY = entry.data.gridY;
    if (gx === oldX && gy === oldY) return;

    // Move inline (no undo for drag movement during drag — commit on pointerup would be ideal, but keep simple)
    entry.data.gridX = gx;
    entry.data.gridY = gy;
    const px = gx * TILE_SIZE + TILE_SIZE / 2;
    const py = gy * TILE_SIZE + TILE_SIZE / 2;
    entry.image.setPosition(px, py);
    if (entry.overlay) entry.overlay.setPosition(px, py);
    if (this.selectionRect) this.selectionRect.setPosition(px, py);

    (this.propsPanel.querySelector("#sel-pos") as HTMLElement).textContent = `Pos: ${gx}, ${gy}`;
  }

  private deleteSelected() {
    if (this.selectedSpawnEntry) {
      const saved = { ...this.selectedSpawnEntry.data };
      const cmd: Command = {
        execute: () => {
          this.removeSpawnByPos(saved.type, saved.gridX, saved.gridY);
          this.deselectTile();
        },
        undo: () => this.addSpawnEntry(saved),
      };
      this.history.execute(cmd);
      return;
    }

    if (!this.selectedTileEntry) return;
    const saved = { ...this.selectedTileEntry.data };
    const cmd: Command = {
      execute: () => this.removeTileEntryById(saved.id),
      undo: () => {
        const entry = this.addTileEntry(saved);
        this.selectTile(entry);
      },
    };
    this.history.execute(cmd);
  }

  // ─── Spawns ───────────────────────────────────────────

  private placeSpawn(gx: number, gy: number) {
    // Check limits
    const existing = this.spawns.filter((s) => s.data.type === this.spawnSubMode);
    if (existing.length >= 4) {
      // Remove oldest
      this.removeSpawnEntry(existing[0]!);
    }

    const spawn: EditorSpawn = { type: this.spawnSubMode, gridX: gx, gridY: gy };
    const cmd: Command = {
      execute: () => this.addSpawnEntry(spawn),
      undo: () => this.removeSpawnByPos(spawn.type, spawn.gridX, spawn.gridY),
    };
    this.history.execute(cmd);
  }

  private addSpawnEntry(spawn: EditorSpawn) {
    const px = spawn.gridX * TILE_SIZE + TILE_SIZE / 2;
    const py = spawn.gridY * TILE_SIZE + TILE_SIZE / 2;
    const color = spawn.type === "player" ? 0x66bb6a : 0xffa726;
    const marker = this.add.ellipse(px, py, 12, 12, color, 0.6).setDepth(200);
    const label = this.add
      .text(px, py - 10, spawn.type === "player" ? "P" : "W", {
        fontSize: "8px",
        color: "#fff",
        fontFamily: "Silkscreen",
      })
      .setOrigin(0.5)
      .setDepth(201);
    this.spawns.push({ data: spawn, marker, label });
  }

  private removeSpawnEntry(entry: SpawnEntry) {
    entry.marker.destroy();
    entry.label.destroy();
    const idx = this.spawns.indexOf(entry);
    if (idx >= 0) this.spawns.splice(idx, 1);
  }

  private removeSpawnByPos(type: string, gx: number, gy: number) {
    const entry = this.spawns.find((s) => s.data.type === type && s.data.gridX === gx && s.data.gridY === gy);
    if (entry) this.removeSpawnEntry(entry);
  }

  // ─── Background Polygon ───────────────────────────────

  private paintBgCell(gx: number, gy: number) {
    const key = `${gx},${gy}`;
    if (this.bgCells.has(key)) return; // already painted

    const cmd: Command = {
      execute: () => this.addBgCellSprite(gx, gy),
      undo: () => this.removeBgCellSprite(gx, gy),
    };
    this.history.execute(cmd);
  }

  private removeBgCell(gx: number, gy: number) {
    const key = `${gx},${gy}`;
    if (!this.bgCells.has(key)) return;

    const cmd: Command = {
      execute: () => this.removeBgCellSprite(gx, gy),
      undo: () => this.addBgCellSprite(gx, gy),
    };
    this.history.execute(cmd);
  }

  private addBgCellSprite(gx: number, gy: number) {
    const key = `${gx},${gy}`;
    if (this.bgCells.has(key)) return;
    const px = gx * TILE_SIZE + TILE_SIZE / 2;
    const py = gy * TILE_SIZE + TILE_SIZE / 2;
    const rect = this.add.rectangle(px, py, TILE_SIZE, TILE_SIZE, 0xff69b4, 0.35).setDepth(-50);
    this.bgCells.set(key, rect);
    this.bgCellData.push({ gridX: gx, gridY: gy });
  }

  private removeBgCellSprite(gx: number, gy: number) {
    const key = `${gx},${gy}`;
    const rect = this.bgCells.get(key);
    if (rect) {
      rect.destroy();
      this.bgCells.delete(key);
    }
    const idx = this.bgCellData.findIndex((c) => c.gridX === gx && c.gridY === gy);
    if (idx >= 0) this.bgCellData.splice(idx, 1);
  }

  // ─── Export / Import ──────────────────────────────────

  private getEditorMap(): EditorMap {
    return {
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      tiles: this.tiles.map((e) => ({ ...e.data })),
      spawns: this.spawns.map((e) => ({ ...e.data })),
      bgCells: [...this.bgCellData],
      bgColor: this.bgColor,
    };
  }

  private exportEditorMap() {
    const map = this.getEditorMap();
    const json = JSON.stringify(map, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "map.chickenz-map.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  private exportGameMap() {
    const map = this.buildGameMap();
    const json = JSON.stringify(map, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "map.gamemap.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  buildGameMap() {
    // Merge collision tiles into rectangular platforms
    const collisionTiles = this.tiles.filter((e) => e.data.collision);
    const platforms = mergeCollisionTiles(collisionTiles.map((e) => e.data));

    // Extract spawn points
    const playerSpawns = this.spawns
      .filter((s) => s.data.type === "player")
      .map((s) => ({
        x: s.data.gridX * TILE_SIZE + TILE_SIZE / 2,
        y: s.data.gridY * TILE_SIZE + TILE_SIZE / 2,
      }));

    const weaponSpawns = this.spawns
      .filter((s) => s.data.type === "weapon")
      .map((s) => ({
        x: s.data.gridX * TILE_SIZE + TILE_SIZE / 2,
        y: s.data.gridY * TILE_SIZE + TILE_SIZE / 2,
      }));

    return {
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      platforms,
      spawnPoints: playerSpawns.length > 0 ? playerSpawns : [{ x: 480, y: 480 }],
      weaponSpawnPoints: weaponSpawns.length > 0 ? weaponSpawns : [{ x: 480, y: 272 }],
    };
  }

  private importEditorMap() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.chickenz-map.json";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const raw = JSON.parse(reader.result as string);
          if (Array.isArray(raw.tiles)) {
            // EditorMap format
            this.loadEditorMap(raw as EditorMap);
          } else if (Array.isArray(raw.platforms)) {
            // GameMap format — convert platforms to auto-tiled collision tiles
            const editorMap: EditorMap = {
              width: raw.width ?? MAP_WIDTH,
              height: raw.height ?? MAP_HEIGHT,
              tiles: [],
              spawns: [],
              bgCells: [],
              bgColor: "blue",
            };
            const GRASS = { col: 6, row: 0 };
            const THIN = { col: 12, row: 0 };
            for (const plat of raw.platforms as { x: number; y: number; width: number; height: number }[]) {
              const tilesW = Math.max(1, Math.round(plat.width / TILE_SIZE));
              const tilesH = Math.max(1, Math.round(plat.height / TILE_SIZE));
              const gx0 = Math.round(plat.x / TILE_SIZE);
              const gy0 = Math.round(plat.y / TILE_SIZE);
              for (let ty = 0; ty < tilesH; ty++) {
                for (let tx = 0; tx < tilesW; tx++) {
                  let frame: number;
                  if (tilesH === 1) {
                    const cx = tx === 0 ? 0 : tx === tilesW - 1 ? 2 : 1;
                    frame = THIN.row * TERRAIN_COLS + (THIN.col + cx);
                  } else {
                    const cx = tx === 0 ? 0 : tx === tilesW - 1 ? 2 : 1;
                    const cy = ty === 0 ? 0 : ty === tilesH - 1 ? 2 : 1;
                    frame = (GRASS.row + cy) * TERRAIN_COLS + (GRASS.col + cx);
                  }
                  editorMap.tiles.push({
                    id: 0,
                    gridX: gx0 + tx,
                    gridY: gy0 + ty,
                    frame,
                    rotation: 0,
                    collision: true,
                    depth: 0,
                  });
                }
              }
            }
            if (Array.isArray(raw.spawnPoints)) {
              for (const sp of raw.spawnPoints) {
                editorMap.spawns.push({
                  type: "player",
                  gridX: Math.floor(sp.x / TILE_SIZE),
                  gridY: Math.floor(sp.y / TILE_SIZE),
                });
              }
            }
            if (Array.isArray(raw.weaponSpawnPoints)) {
              for (const sp of raw.weaponSpawnPoints) {
                editorMap.spawns.push({
                  type: "weapon",
                  gridX: Math.floor(sp.x / TILE_SIZE),
                  gridY: Math.floor(sp.y / TILE_SIZE),
                });
              }
            }
            this.loadEditorMap(editorMap);
          } else {
            console.error("Unrecognized map format");
          }
        } catch (err) {
          console.error("Failed to import map:", err);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  loadEditorMap(map: EditorMap) {
    // Clear everything
    for (const entry of [...this.tiles]) {
      entry.image.destroy();
      if (entry.overlay) entry.overlay.destroy();
    }
    this.tiles.length = 0;
    for (const entry of [...this.spawns]) {
      entry.marker.destroy();
      entry.label.destroy();
    }
    this.spawns.length = 0;
    for (const sprite of this.bgCells.values()) sprite.destroy();
    this.bgCells.clear();
    this.bgCellData = [];
    this.history.clear();
    this.deselectTile();

    // Load tiles
    for (const tile of map.tiles) {
      tile.id = this.nextTileId++;
      this.addTileEntry(tile);
    }

    // Load spawns
    for (const spawn of map.spawns) {
      this.addSpawnEntry(spawn);
    }

    // Load bg
    if (map.bgColor) {
      this.bgColor = map.bgColor as (typeof BG_KEYS)[number];
    }
    if (map.bgCells) {
      for (const cell of map.bgCells) {
        this.addBgCellSprite(cell.gridX, cell.gridY);
      }
    }
  }

  private clearAll() {
    if (this.tiles.length === 0 && this.spawns.length === 0 && this.bgCellData.length === 0) return;
    const savedTiles = this.tiles.map((e) => ({ ...e.data }));
    const savedSpawns = this.spawns.map((e) => ({ ...e.data }));
    const savedBg = [...this.bgCellData];
    const savedBgColor = this.bgColor;

    const cmd: Command = {
      execute: () => {
        this.loadEditorMap({
          width: MAP_WIDTH,
          height: MAP_HEIGHT,
          tiles: [],
          spawns: [],
          bgCells: [],
          bgColor: "blue",
        });
      },
      undo: () => {
        this.loadEditorMap({
          width: MAP_WIDTH,
          height: MAP_HEIGHT,
          tiles: savedTiles,
          spawns: savedSpawns,
          bgCells: savedBg,
          bgColor: savedBgColor,
        });
      },
    };
    this.history.execute(cmd);
  }

  // ─── Test Mode ────────────────────────────────────────

  private startTest() {
    const gameMap = this.buildGameMap();
    this.scene.start("TestScene", { gameMap, editorMap: this.getEditorMap() });
  }
}

// ─── Platform Merging Algorithm ─────────────────────────

function mergeCollisionTiles(tiles: EditorTile[]): { x: number; y: number; width: number; height: number }[] {
  if (tiles.length === 0) return [];

  // Build occupancy grid
  const grid = new Set<string>();
  for (const t of tiles) {
    grid.add(`${t.gridX},${t.gridY}`);
  }

  const used = new Set<string>();
  const platforms: { x: number; y: number; width: number; height: number }[] = [];

  // Sort tiles by y then x for consistent scanning
  const sorted = [...tiles].sort((a, b) => a.gridY - b.gridY || a.gridX - b.gridX);

  for (const tile of sorted) {
    const key = `${tile.gridX},${tile.gridY}`;
    if (used.has(key)) continue;

    // Greedily extend horizontally
    let w = 1;
    while (grid.has(`${tile.gridX + w},${tile.gridY}`) && !used.has(`${tile.gridX + w},${tile.gridY}`)) {
      w++;
    }

    // Then extend vertically
    let h = 1;
    outer: while (true) {
      for (let dx = 0; dx < w; dx++) {
        const ck = `${tile.gridX + dx},${tile.gridY + h}`;
        if (!grid.has(ck) || used.has(ck)) break outer;
      }
      h++;
    }

    // Mark used
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        used.add(`${tile.gridX + dx},${tile.gridY + dy}`);
      }
    }

    platforms.push({
      x: tile.gridX * TILE_SIZE,
      y: tile.gridY * TILE_SIZE,
      width: w * TILE_SIZE,
      height: h * TILE_SIZE,
    });
  }

  return platforms;
}
