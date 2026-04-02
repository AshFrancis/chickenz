import Phaser from "phaser";
import {
  ARENA,
  MAP_POOL,
  GRAVITY,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  INITIAL_LIVES,
  MATCH_DURATION_TICKS,
  SUDDEN_DEATH_START_TICK,
  TICK_RATE,
  TICK_DT_MS,
  WEAPON_STATS,
  Button,
  PlayerStateFlag,
  WeaponType,
  Facing,
  NULL_INPUT,
} from "@chickenz/sim";
import type { GameMap, MatchConfig, PlayerInput } from "@chickenz/sim";
import { WasmState } from "../wasm";
import { InputManager } from "../input/InputManager";
import type { Tutorial, TutorialTickResult } from "../tutorial/Tutorial";
import { PredictionManager } from "../net/PredictionManager";
import type { StateMessage, SerializedPlayer, SerializedProjectile } from "../../../../services/server/src/protocol";
/** Game state data — shared shape of StateMessage, SpectateStateMessage, and WASM exports */
type GameStateData = Omit<StateMessage, "type">;
import { DPR, VIEW_W, VIEW_H } from "../game";
import {
  PLAYER_COLORS,
  WALL_COLOR,
  TERRAIN_COLS,
  CHARACTER_SLUGS,
  CHARACTER_ANIMS,
  GUN_TEXTURES,
  GUN_CONFIG,
  CROUCH_SOUNDS,
  BG_KEYS,
  PIXEL_FONT,
  TUTORIAL_MAP,
  getTerrainFrame,
  smoothLerp,
  showAnnounce,
  hideAnnounce,
} from "./constants";
import type { TickInputPair } from "./constants";
import { AudioManager } from "./AudioManager";
import { CameraSystem } from "./CameraSystem";

export class GameScene extends Phaser.Scene {
  private prevState: GameStateData | null = null;
  private currState: GameStateData | null = null;
  private config!: MatchConfig;
  private warmupWasm: WasmState | null = null;
  private replayWasm: WasmState | null = null;
  readonly inputManager = new InputManager();
  private playing = false;
  private localPlayerId = 0;
  private prediction: PredictionManager | null = null;
  private predictionAccum = 0;
  onLocalInput?: (input: PlayerInput, tick: number) => void;

  // Player usernames
  private playerUsernames: [string, string] = ["", ""];

  // Round system
  private currentRound = 0;
  private totalRounds = 3;
  private roundWins: [number, number] = [0, 0];
  private roundTransition = false;

  // Graphics objects
  private gfx!: Phaser.GameObjects.Graphics;
  private gfxOverlay!: Phaser.GameObjects.Graphics; // high-depth layer for stomp bars
  private timerText!: Phaser.GameObjects.Text;
  private suddenDeathText!: Phaser.GameObjects.Text;
  // winText + roundPopupText are DOM-based (see #announce-overlay)
  private controlsText!: Phaser.GameObjects.Text;
  private highPingShown = false;
  private nameTexts: Phaser.GameObjects.Text[] = [];

  // Rocket explosion effects
  private explosions: { x: number; y: number; timer: number }[] = [];
  private prevRockets: Map<number, { x: number; y: number }> = new Map();

  // Tile-based platform sprites + background
  private platformTiles: Phaser.GameObjects.Image[] = [];
  private borderTiles: Phaser.GameObjects.Image[] = [];
  private bgTile: Phaser.GameObjects.TileSprite | null = null;
  private bgScrollX = 0;
  private bgScrollY = 0;

  // Character sprites (animated)
  private playerSprites: Phaser.GameObjects.Sprite[] = [];
  private gunSprites: Phaser.GameObjects.Image[] = [];
  private characterSlots: [number, number] = [0, 1]; // indices into CHARACTER_SLUGS

  // Weapon pickup sprites and collection tracking
  private pickupSprites: Map<number, Phaser.GameObjects.Image> = new Map();
  private pickupGlowEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private prevPickupActive: Map<number, boolean> = new Map(); // track active→inactive transitions

  // Dust particle effects
  private dustEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private dustGroundEmitL: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private dustGroundEmitR: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private prevPlayerGrounded: boolean[] = [false, false];
  private prevPlayerJumpsLeft: number[] = [2, 2];

  // Smooth render positions (spring damper absorbs prediction/reconciliation snaps)
  private localSmooth: {
    x: number;
    y: number; // visual position
    velX: number;
    velY: number; // spring velocity (pixels/ms)
    initialized: boolean;
  } = { x: 0, y: 0, velX: 0, velY: 0, initialized: false };
  private remoteSmooth: { x: number; y: number; vx: number; vy: number; initialized: boolean } = {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    initialized: false,
  };

  // Camera system
  private camera: CameraSystem;

  // Netcode: tick ordering
  private lastServerTick = 0;

  // Audio system
  audio: AudioManager;

  // Warmup mode (waiting room with jumping)
  private warmupMode = false;
  private warmupState: GameStateData | null = null;
  private warmupConfig: MatchConfig | null = null;
  private warmupAccum = 0;
  private warmupJoinCode = "";
  // Warmup overlay is DOM-based (see index.html #warmup-overlay)

  // Tutorial mode (standalone local WASM session)
  private tutorialMode = false;
  private tutorialRef: Tutorial | null = null;
  private tutorialCallback: (() => void) | null = null;

  // Diamond transition
  private transitionActive = false;

  // Stomp alert texts (one per player, like nameTexts)
  private stompAlertTexts: Phaser.GameObjects.Text[] = [];

  // Button tracking for crouch animation (per player)
  private lastReceivedButtons: [number, number] = [0, 0];
  private prevFrameButtons: [number, number] = [0, 0];

  // Death ragdoll physics (per player)
  private deathRagdoll: {
    active: boolean;
    settled: boolean;
    x: number;
    y: number;
    vx: number;
    vy: number;
    rotation: number;
    angularVel: number;
    bounces: number;
    wasAlive: boolean; // track alive→dead transition
  }[] = [
    { active: false, settled: false, x: 0, y: 0, vx: 0, vy: 0, rotation: 0, angularVel: 0, bounces: 0, wasAlive: true },
    { active: false, settled: false, x: 0, y: 0, vx: 0, vy: 0, rotation: 0, angularVel: 0, bounces: 0, wasAlive: true },
  ];

  // Pending server state — buffer latest, apply once per update frame (prevents queue feedback loop)
  private pendingServerState: GameStateData | null = null;
  private pendingServerButtons: [number, number] | undefined = undefined;

  // Netcode diagnostics
  private diagTimer = 0;
  private diagMaxErrX = 0;
  private diagMaxErrY = 0;
  private diagTeleports = 0;
  private diagMaxVisualJump = 0;
  private diagPrevVisualX = 0;
  private diagPrevVisualY = 0;
  // RTT from NetworkManager (set externally via setter)
  private networkRtt = 0;

  // Scene lifecycle — create() may not have run yet when network callbacks fire
  private sceneReady = false;
  private readyQueue: (() => void)[] = [];

  // Spectate mode (tournament)
  private spectateMode = false;

  // Replay mode
  private replayMode = false;
  private replayTranscript: TickInputPair[] = [];
  private replayTick = 0;
  private replayPaused = false;
  private replaySpeed = 1;
  private replayAccum = 0;
  private replayRounds: { seed: number; mapIndex: number; transcript: TickInputPair[] }[] = [];
  private replayCurrentRound = 0;
  private replayRoundWins: [number, number] = [0, 0];
  private replayRoundTransitionTimer = 0;
  private replayInfoText!: Phaser.GameObjects.Text;
  private roundText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: "GameScene" });
    this.audio = new AudioManager(this);
    this.camera = new CameraSystem(this);
  }

  preload() {
    // BGM tracks loaded lazily on-demand (18+ MB total — don't block initial load)
    // Crouch/taunt sounds per character
    try {
      for (const key of Object.values(CROUCH_SOUNDS)) {
        this.load.audio(key, `/audio/${key}.mp3`);
      }
    } catch {
      // Audio files may not exist yet
    }
    // Terrain spritesheet (16×16 tiles, 22 cols × 11 rows)
    this.load.spritesheet("terrain", "/sprites/terrain.png", { frameWidth: 16, frameHeight: 16 });
    // Background tiles (one per color, chosen deterministically per match)
    const BG_NAMES = ["blue", "brown", "gray", "green", "pink", "purple", "yellow"];
    for (const name of BG_NAMES) {
      this.load.image(`bg-${name}`, `/sprites/bg-${name}.png`);
    }
    this.load.image("dust", "/sprites/dust.png");

    // Gun sprites
    for (const [, tex] of Object.entries(GUN_TEXTURES)) {
      this.load.image(tex, `/sprites/${tex}.png`);
    }

    // Pickup collection animation (6 frames, 32x32 each)
    this.load.spritesheet("collected", "/sprites/collected.png", { frameWidth: 32, frameHeight: 32 });

    // Character spritesheets (32×32 frames)
    for (const slug of CHARACTER_SLUGS) {
      for (const anim of CHARACTER_ANIMS) {
        this.load.spritesheet(`${slug}-${anim.key}`, `/sprites/characters/${slug}-${anim.key}.png`, {
          frameWidth: 32,
          frameHeight: 32,
        });
      }
    }

    this.load.on("complete", () => {
      this.audio.setAudioLoaded();
      // Try to start BGM now that audio is loaded (requires prior user gesture)
      this.audio.startBGM();
    });

    // Load persisted settings
    const storedBGM = localStorage.getItem("chickenz-bgm-volume");
    if (storedBGM !== null) this.audio.bgmVolume = parseInt(storedBGM, 10) / 100;
    const storedSFX = localStorage.getItem("chickenz-sfx-volume");
    if (storedSFX !== null) this.audio.sfxVolume = parseInt(storedSFX, 10) / 100;
    const storedZoom = localStorage.getItem("chickenz-dynamic-zoom");
    if (storedZoom !== null) this.camera.dynamicZoom = storedZoom !== "false";
    this.audio.setMusicMuted(localStorage.getItem("chickenz-music-muted") !== "false");
  }

  create() {
    this.gfx = this.add.graphics();
    this.gfxOverlay = this.add.graphics();

    // Warm up font: create a hidden text to force Phaser to rasterize the font atlas
    const warmFont = this.add
      .text(-100, -100, "ABCabc123", {
        fontFamily: PIXEL_FONT,
        fontSize: "16px",
      })
      .setResolution(DPR)
      .setVisible(false);
    this.time.delayedCall(100, () => warmFont.destroy());

    // JIT warmup: run ~300 silent WASM sim ticks to warm up the module
    {
      const ws = WasmState.new_arena(1);
      for (let t = 0; t < 300; t++) {
        ws.step(0, 0, 0, 0, 0, 0);
      }
      ws.free();
    }

    // HUD texts (rendered on separate HUD camera, immune to zoom)
    this.timerText = this.add
      .text(VIEW_W - 20, 10, "", {
        fontSize: "16px",
        color: "#ffffff",
        fontFamily: PIXEL_FONT,
        align: "right",
      })
      .setOrigin(1, 0)
      .setResolution(DPR)
      .setDepth(100);
    this.suddenDeathText = this.add
      .text(VIEW_W / 2, 40, "SUDDEN DEATH", {
        fontSize: "16px",
        color: "#ff4444",
        fontFamily: PIXEL_FONT,
        align: "center",
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 0)
      .setResolution(DPR)
      .setVisible(false)
      .setDepth(100);
    this.inputManager.init(this.game.canvas);

    this.controlsText = this.add
      .text(10, VIEW_H - 25, "", {
        fontSize: "8px",
        color: "#888888",
        fontFamily: PIXEL_FONT,
      })
      .setResolution(DPR)
      .setDepth(100);

    // Player name texts (rendered on main camera, move with players)
    for (let i = 0; i < 2; i++) {
      const text = this.add
        .text(0, 0, "", {
          fontSize: "10px",
          color: "#ffffff",
          fontFamily: PIXEL_FONT,
          align: "center",
        })
        .setOrigin(0.5, 1)
        .setResolution(DPR)
        .setDepth(50)
        .setShadow(1, 1, "#000000", 0);
      this.nameTexts.push(text);
    }

    // Stomp alert texts (one per player, world-space below player)
    for (let i = 0; i < 2; i++) {
      const alertText = this.add
        .text(0, 0, "SHAKE HIM OFF!", {
          fontSize: "7px",
          color: "#ffffff",
          fontFamily: PIXEL_FONT,
          align: "center",
          stroke: "#000000",
          strokeThickness: 2,
        })
        .setOrigin(0.5, 0)
        .setDepth(50)
        .setResolution(DPR)
        .setAlpha(0);
      this.stompAlertTexts.push(alertText);
    }

    // Round indicator (top-left)
    this.roundText = this.add
      .text(10, 10, "", {
        fontSize: "10px",
        color: "#ffffff",
        fontFamily: PIXEL_FONT,
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setResolution(DPR)
      .setDepth(100);

    // Replay info text
    this.replayInfoText = this.add
      .text(VIEW_W / 2, VIEW_H - 10, "", {
        fontSize: "10px",
        color: "#ffee58",
        fontFamily: PIXEL_FONT,
        align: "center",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 1)
      .setResolution(DPR)
      .setDepth(100)
      .setVisible(false);

    // Camera setup — main camera for game world, HUD camera for overlay
    // DPR-scaled canvas: zoom by DPR so world coords map to pixels
    // Bounds extend beyond map so wider viewports can see background
    const mapW = this.config?.map?.width ?? 960;
    const mapH = this.config?.map?.height ?? 540;
    const padX = VIEW_W / 2;
    const padY = VIEW_H / 2;
    this.cameras.main.setBounds(-padX, -padY, mapW + padX * 2, mapH + padY * 2);
    this.cameras.main.setZoom(DPR);

    // HUD camera: fixed zoom at DPR, covers full canvas viewport
    this.camera.hudCamera = this.cameras.add(0, 0, Math.round(VIEW_W * DPR), Math.round(VIEW_H * DPR));
    this.camera.hudCamera.setScroll(0, 0);
    this.camera.hudCamera.setZoom(DPR);

    // Collect HUD elements (rendered only on hudCamera)
    const hudElements = [this.timerText, this.suddenDeathText, this.controlsText, this.roundText, this.replayInfoText];
    // stompAlertTexts are world-space (not HUD) — HUD camera should ignore them
    for (const at of this.stompAlertTexts) this.camera.hudCamera.ignore(at);

    // Main camera ignores HUD texts
    for (const el of hudElements) {
      this.cameras.main.ignore(el);
    }

    // HUD camera ignores game graphics and name texts
    this.camera.hudCamera.ignore(this.gfx);
    this.camera.hudCamera.ignore(this.gfxOverlay);
    for (const nt of this.nameTexts) {
      this.camera.hudCamera.ignore(nt);
    }

    // Dark blue background outside arena (scene background color)
    this.cameras.main.setBackgroundColor(0x211f30);

    // Graphics layer above platform tiles
    this.gfx.setDepth(10);
    this.gfxOverlay.setDepth(30); // above all sprites, for stomped player bars

    // Character animations + sprites
    for (const slug of CHARACTER_SLUGS) {
      for (const anim of CHARACTER_ANIMS) {
        const key = `${slug}-${anim.key}`;
        this.anims.create({
          key,
          frames: this.anims.generateFrameNumbers(key, { start: 0, end: anim.frames - 1 }),
          frameRate: anim.rate,
          repeat: anim.repeat,
        });
      }
      // Crouch animation: hit spritesheet frames 2-6, play once per press
      this.anims.create({
        key: `${slug}-crouch`,
        frames: this.anims.generateFrameNumbers(`${slug}-hit`, { start: 2, end: 6 }),
        frameRate: 20,
        repeat: 0,
      });
    }
    for (let i = 0; i < 2; i++) {
      const slug = CHARACTER_SLUGS[this.characterSlots[i] ?? 0];
      const sprite = this.add.sprite(0, 0, `${slug}-idle`).setDepth(20).setVisible(false);
      this.camera.hudCamera.ignore(sprite);
      this.playerSprites.push(sprite);

      // Gun sprite (rendered on top of character, scale set per-weapon in drawPlayers)
      const gun = this.add.image(0, 0, "gun-pistol").setDepth(21).setVisible(false);
      this.camera.hudCamera.ignore(gun);
      this.gunSprites.push(gun);
    }

    // Dust emitter for airborne effects (jump, double jump) — puffs upward
    this.dustEmitter = this.add.particles(0, 0, "dust", {
      speed: { min: 20, max: 60 },
      angle: { min: 200, max: 340 },
      scale: { start: 0.6, end: 0 },
      alpha: { start: 0.7, end: 0 },
      lifespan: { min: 350, max: 600 },
      gravityY: 20,
      emitting: false,
    });
    this.dustEmitter.setDepth(19);
    this.camera.hudCamera.ignore(this.dustEmitter);

    // Dust emitters for ground effects — one spreads left, one spreads right
    this.dustGroundEmitL = this.add.particles(0, 0, "dust", {
      speed: { min: 25, max: 55 },
      angle: { min: 160, max: 200 },
      scale: { start: 0.6, end: 0 },
      alpha: { start: 0.7, end: 0 },
      lifespan: { min: 350, max: 600 },
      gravityY: -5,
      emitting: false,
    });
    this.dustGroundEmitL.setDepth(19);
    this.camera.hudCamera.ignore(this.dustGroundEmitL);

    this.dustGroundEmitR = this.add.particles(0, 0, "dust", {
      speed: { min: 25, max: 55 },
      angle: { min: -20, max: 20 },
      scale: { start: 0.6, end: 0 },
      alpha: { start: 0.7, end: 0 },
      lifespan: { min: 350, max: 600 },
      gravityY: -5,
      emitting: false,
    });
    this.dustGroundEmitR.setDepth(19);
    this.camera.hudCamera.ignore(this.dustGroundEmitR);

    // Pickup collection animation
    this.anims.create({
      key: "collected",
      frames: this.anims.generateFrameNumbers("collected", { start: 0, end: 5 }),
      frameRate: 20,
      repeat: 0,
    });

    // Pickup glow particle emitter (soft dust particles floating around pickups)
    this.pickupGlowEmitter = this.add.particles(0, 0, "dust", {
      speed: { min: 5, max: 15 },
      angle: { min: 0, max: 360 },
      scale: { start: 0.4, end: 0 },
      alpha: { start: 0.5, end: 0 },
      lifespan: { min: 600, max: 1000 },
      gravityY: -10,
      emitting: false,
    });
    this.pickupGlowEmitter.setDepth(14);
    this.camera.hudCamera.ignore(this.pickupGlowEmitter);

    // Disable Phaser's default audio pause-on-blur (abrupt stop/start).
    // We handle it manually with a fade below.
    this.sound.pauseOnBlur = false;

    // Fade BGM out/in on window/tab focus change instead of abrupt pause.
    this.audio.setupFocusFade();

    this.sceneReady = true;

    // Flush any deferred calls that arrived before create() finished
    for (const fn of this.readyQueue) fn();
    this.readyQueue = [];
  }

  /** Defer a function call until create() has finished (scene is ready). */
  private onReady(fn: () => void) {
    if (this.sceneReady) {
      fn();
    } else {
      this.readyQueue.push(fn);
    }
  }

  // ── Warmup Mode ──────────────────────────────────────────────────────────

  private assignCharacters() {
    const p1 = Math.floor(Math.random() * CHARACTER_SLUGS.length);
    let p2 = Math.floor(Math.random() * (CHARACTER_SLUGS.length - 1));
    if (p2 >= p1) p2++;
    this.characterSlots = [p1, p2];
  }

  startWarmup(joinCode: string, username?: string, onStarted?: () => void, character?: number) {
    if (!this.sceneReady) {
      // deferred — scene not ready yet
      this.onReady(() => this.startWarmup(joinCode, username, onStarted, character));
      return;
    }
    if (character !== undefined) {
      // Use the pre-chosen character for P1, random for P2
      const NUM_CHARS = 4;
      let p2 = Math.floor(Math.random() * (NUM_CHARS - 1));
      if (p2 >= character) p2++;
      this.characterSlots = [character, p2];
    } else {
      this.assignCharacters();
    }
    onStarted?.();
    this.warmupMode = true;
    this.warmupJoinCode = joinCode;
    this.playerUsernames = [username || "", ""];
    this.warmupAccum = 0;

    const map = ARENA;
    this.createMapTiles(map, Date.now() >>> 0);
    this.warmupConfig = {
      seed: 0,
      map,
      playerCount: 2,
      tickRate: TICK_RATE,
      initialLives: 99,
      matchDurationTicks: 999999, // infinite
      suddenDeathStartTick: 999999,
    };
    // Free previous WASM state if any
    if (this.warmupWasm) {
      try {
        this.warmupWasm.free();
      } catch {
        /* already freed */
      }
    }
    // Use warmup constructor: 99 lives, no sudden death, no match end
    this.warmupWasm = WasmState.new_warmup(0, JSON.stringify(map));
    this.warmupState = this.warmupWasm!.export_state();
    // Banish player 2 off-screen and import back so WASM sim knows they're gone
    this.banishWarmupPlayer2(this.warmupState!);
    this.warmupWasm!.import_state(this.warmupState);
    this.currState = this.warmupState;
    this.prevState = this.warmupState;
    this.config = this.warmupConfig;
    this.localPlayerId = 0;
    this.resetRagdolls();
    this.playing = false; // not a real match
    this.prediction = null;
    hideAnnounce();
    document.getElementById("sudden-death-overlay")?.classList.remove("visible");
    this.camera.currentZoom = 1.0;
    this.camera.cameraX = 480;
    this.camera.cameraY = 270;
    this.localSmooth = { x: 0, y: 0, velX: 0, velY: 0, initialized: false };
    this.remoteSmooth = { x: 0, y: 0, vx: 0, vy: 0, initialized: false };
    this.explosions = [];

    const warmupEl = document.getElementById("warmup-overlay");
    const codeEl = document.getElementById("warmup-code");
    if (codeEl) codeEl.textContent = joinCode;
    warmupEl?.classList.add("visible");
    this.roundText?.setVisible(false);
    this.replayInfoText?.setVisible(false);
  }

  get isWarmup(): boolean {
    return this.warmupMode || this.tutorialMode;
  }

  get isPlaying(): boolean {
    return this.playing && !this.warmupMode;
  }

  /** Move player 2 far off-screen so they can't absorb bullets or affect camera. */
  private banishWarmupPlayer2(state: GameStateData) {
    const p1 = state.players[1];
    if (p1) {
      p1.x = -9999;
      p1.y = -9999;
      p1.vx = 0;
      p1.vy = 0;
    }
  }

  stopWarmup() {
    this.warmupMode = false;
    this.warmupState = null;
    this.resetRagdolls();
    if (this.warmupWasm) {
      try {
        this.warmupWasm.free();
      } catch {
        /* already freed */
      }
      this.warmupWasm = null;
    }
    document.getElementById("warmup-overlay")?.classList.remove("visible");
  }

  /** Start a standalone tutorial session (local WASM, no network). */
  startTutorial(tutorial: Tutorial, onComplete: () => void, character?: number) {
    if (!this.sceneReady) {
      this.onReady(() => this.startTutorial(tutorial, onComplete, character));
      return;
    }
    if (character !== undefined) {
      const NUM_CHARS = 4;
      let p2 = Math.floor(Math.random() * (NUM_CHARS - 1));
      if (p2 >= character) p2++;
      this.characterSlots = [character, p2];
    } else {
      this.assignCharacters();
    }
    this.tutorialMode = true;
    this.tutorialRef = tutorial;
    this.tutorialCallback = onComplete;
    this.warmupAccum = 0;

    const map = TUTORIAL_MAP;
    this.createMapTiles(map, Date.now() >>> 0);
    this.warmupConfig = {
      seed: 0,
      map,
      playerCount: 2,
      tickRate: TICK_RATE,
      initialLives: 99,
      matchDurationTicks: 999999,
      suddenDeathStartTick: 999999,
    };
    if (this.warmupWasm) {
      try {
        this.warmupWasm.free();
      } catch {
        /* already freed */
      }
    }
    this.warmupWasm = WasmState.new_warmup(0, JSON.stringify(map));
    this.warmupState = this.warmupWasm!.export_state();
    this.currState = this.warmupState;
    this.prevState = this.warmupState;
    this.config = this.warmupConfig;
    this.localPlayerId = 0;
    this.resetRagdolls();
    this.playing = false;
    this.prediction = null;
    hideAnnounce();
    document.getElementById("sudden-death-overlay")?.classList.remove("visible");
    const whTut = document.getElementById("weapon-hud");
    if (whTut) whTut.style.display = "none";
    this.camera.currentZoom = 1.0;
    this.camera.cameraX = 480;
    this.camera.cameraY = 270;
    this.localSmooth = { x: 0, y: 0, velX: 0, velY: 0, initialized: false };
    this.remoteSmooth = { x: 0, y: 0, vx: 0, vy: 0, initialized: false };
    this.explosions = [];
    this.roundText?.setVisible(false);
    this.replayInfoText?.setVisible(false);
    // Don't show warmup overlay — tutorial has its own overlay
  }

  stopTutorial() {
    this.tutorialMode = false;
    this.warmupState = null;
    this.currState = null;
    this.prevState = null;
    this.resetRagdolls();
    if (this.warmupWasm) {
      try {
        this.warmupWasm.free();
      } catch {
        /* already freed */
      }
      this.warmupWasm = null;
    }
    const cb = this.tutorialCallback;
    this.tutorialRef = null;
    this.tutorialCallback = null;
    cb?.();
  }

  get isTutorial(): boolean {
    return this.tutorialMode;
  }

  startOnlineMatch(
    playerId: number,
    seed: number,
    usernames?: [string, string],
    mapIndex: number = 0,
    totalRounds: number = 3,
    characters?: [number, number],
    onCovered?: () => void,
  ) {
    if (!this.sceneReady) {
      // deferred — scene not ready yet
      this.onReady(() =>
        this.startOnlineMatch(playerId, seed, usernames, mapIndex, totalRounds, characters, onCovered),
      );
      return;
    }
    this.localPlayerId = playerId;
    if (characters) {
      this.characterSlots = characters;
    } else {
      this.assignCharacters();
    }
    this.playerUsernames = usernames ?? ["", ""];
    this.replayMode = false;
    this.replayInfoText.setVisible(false);
    this.currentRound = 0;
    this.totalRounds = totalRounds;
    this.roundWins = [0, 0];
    this.roundTransition = false;

    this.playing = false;

    // Diamond transition covers screen, THEN swap map at midpoint (fully black)
    // Keep warmupMode alive during grow-in so camera stays stable (P2 is at -9999)
    this.playTransition(() => {
      // Screen is now fully covered — safe to close lobby behind the transition
      onCovered?.();
      this.warmupMode = false;
      this.tutorialMode = false;
      this.warmupState = null;
      document.getElementById("warmup-overlay")?.classList.remove("visible");
      this.initRound(seed, mapIndex);
      this.showCountdown(() => {
        this.predictionAccum = 0;
        this.playing = true;
        this.showRoundPopup(1);
        this.audio.playSound("match-start");
      });
    });

    this.audio.startBGM();
  }

  /** Start a new round with the given seed and map. */
  startNewRound(seed: number, mapIndex: number, round: number) {
    this.currentRound = round;
    this.roundTransition = false;
    this.playing = false; // freeze input/prediction during transition + countdown
    this.pendingServerState = null;
    this.pendingServerButtons = undefined;
    this.lastServerTick = 0;

    // Transition covers screen, swap map at midpoint (fully black), then reveal
    this.playTransition(() => {
      this.initRound(seed, mapIndex);
      // Spectators don't predict
      if (this.spectateMode) this.prediction = null;
      this.showCountdown(() => {
        this.predictionAccum = 0;
        this.playing = true;
        this.showRoundPopup(round + 1);
        this.audio.playSound("match-start");
      });
    });
  }

  private showRoundPopup(roundNumber: number) {
    showAnnounce(`ROUND ${roundNumber}`);
    this.time.delayedCall(500, () => {
      hideAnnounce();
    });
  }

  private showCountdown(onComplete: () => void) {
    const steps = ["3", "2", "1", "GO!"];
    let i = 0;
    showAnnounce(steps[0]!);
    const advance = () => {
      i++;
      if (i < steps.length) {
        showAnnounce(steps[i]!);
        if (steps[i] === "GO!") {
          onComplete();
          this.time.delayedCall(400, () => {
            hideAnnounce();
          });
        } else {
          this.time.delayedCall(350, advance);
        }
      }
    };
    this.time.delayedCall(350, advance);
  }

  // Transition timing constants
  private static readonly TRANS_COLS = 5;
  private static readonly TRANS_WAVE_DELAY = 60;
  private static readonly TRANS_GROW_MS = 180;
  private static readonly TRANS_HOLD_MS = 250;
  private static readonly TRANS_SHRINK_MS = 180;

  /** Play a diamond wipe transition using a DOM overlay (bypasses Phaser camera issues). */
  playTransition(onMidpoint: () => void) {
    if (this.transitionActive) {
      onMidpoint();
      return;
    }
    this.transitionActive = true;

    const overlay = document.getElementById("transition-overlay");
    if (!overlay) {
      onMidpoint();
      this.transitionActive = false;
      return;
    }
    const cells = overlay.querySelectorAll<HTMLElement>(".t-cell");

    const {
      TRANS_COLS: cols,
      TRANS_WAVE_DELAY: WAVE_DELAY,
      TRANS_GROW_MS: GROW_MS,
      TRANS_HOLD_MS: HOLD_MS,
      TRANS_SHRINK_MS: SHRINK_MS,
    } = GameScene;

    // Reset all cells
    for (const cell of cells) {
      cell.className = "t-cell";
      cell.style.setProperty("--td", "0ms");
    }

    overlay.classList.add("active");

    // Phase 1: Grow — stagger columns left-to-right
    requestAnimationFrame(() => {
      for (let i = 0; i < cells.length; i++) {
        const col = i % cols;
        cells[i]!.style.setProperty("--td", `${col * WAVE_DELAY}ms`);
        cells[i]!.classList.add("grow");
      }
    });

    // Phase 2: At midpoint (all columns grown), fire callback.
    // Diamonds stay at scale(1) with overlap = full coverage, no "hold" class needed.
    const totalIn = GROW_MS + WAVE_DELAY * (cols - 1);
    setTimeout(() => {
      onMidpoint();

      // Phase 3: After hold, shrink out with column wave
      setTimeout(() => {
        // Pre-shrink: keep scale(1), disable transition
        for (const cell of cells) {
          cell.className = "t-cell pre-shrink";
          cell.style.setProperty("--td", "0ms");
        }
        // Force reflow so browser commits scale(1) state
        void overlay.offsetHeight;
        // Shrink: animate scale(1) → scale(0) with staggered delays
        for (let i = 0; i < cells.length; i++) {
          const col = i % cols;
          cells[i]!.className = "t-cell shrink";
          cells[i]!.style.setProperty("--td", `${col * WAVE_DELAY}ms`);
        }

        // Phase 4: Clean up after shrink completes
        const totalOut = SHRINK_MS + WAVE_DELAY * (cols - 1);
        setTimeout(() => {
          overlay.classList.remove("active");
          for (const cell of cells) {
            cell.className = "t-cell";
            cell.style.setProperty("--td", "0ms");
          }
          this.transitionActive = false;
        }, totalOut + 50);
      }, HOLD_MS);
    }, totalIn + 30);
  }

  /** Handle round end — show result, let players keep moving. */
  handleRoundEnd(round: number, winner: number, roundWins: [number, number]) {
    this.roundWins = roundWins;
    this.roundTransition = true;
    const winnerName = (this.playerUsernames[winner] || `Player ${winner + 1}`).toUpperCase();
    showAnnounce(`Round ${round + 1} - ${winnerName} wins!\n${roundWins[0]} - ${roundWins[1]}`);
  }

  /** Reset ragdoll state and sprite properties for both players. */
  private resetRagdolls() {
    for (let i = 0; i < this.deathRagdoll.length; i++) {
      const r = this.deathRagdoll[i]!;
      r.active = false;
      r.settled = false;
      r.rotation = 0;
      r.angularVel = 0;
      r.bounces = 0;
      r.wasAlive = false; // false: don't re-trigger ragdoll if player is still dead in currState
      const sprite = this.playerSprites[i];
      if (sprite) {
        sprite.setRotation(0);
        sprite.setOrigin(0.5, 0.5);
        sprite.setAlpha(1);
      }
    }
  }

  private initRound(seed: number, mapIndex: number) {
    const map = MAP_POOL[mapIndex] ?? MAP_POOL[0] ?? ARENA;
    const mapJson = JSON.stringify(map);
    this.createMapTiles(map, seed);
    this.config = {
      seed,
      map,
      playerCount: 2,
      tickRate: TICK_RATE,
      initialLives: INITIAL_LIVES,
      matchDurationTicks: MATCH_DURATION_TICKS,
      suddenDeathStartTick: SUDDEN_DEATH_START_TICK,
    };
    // Get initial state from a temp WASM instance for display
    const tempWasm = new WasmState(seed, mapJson);
    const initial = tempWasm.export_state();
    tempWasm.free();
    this.prevState = initial;
    this.currState = initial;
    // Don't set playing here — caller controls when gameplay starts (after countdown)
    hideAnnounce();
    document.getElementById("sudden-death-overlay")?.classList.remove("visible");
    this.explosions = [];
    if (this.prediction) {
      try {
        this.prediction.free();
      } catch {
        /* already freed */
      }
    }
    this.prediction = new PredictionManager(seed, mapJson, this.localPlayerId);
    this.predictionAccum = 0;
    // Snap camera to midpoint between both players so they're visible immediately
    const p0 = initial.players[0];
    const p1 = initial.players[1];
    if (p0 && p1) {
      this.camera.cameraX = (p0.x + p1.x) / 2 + PLAYER_WIDTH / 2;
      this.camera.cameraY = (p0.y + p1.y) / 2 + PLAYER_HEIGHT / 2;
      // Start at correct zoom for narrow viewports
      const PAD = 80;
      const needW = Math.abs(p0.x - p1.x) + PLAYER_WIDTH + PAD * 2;
      const needH = Math.abs(p0.y - p1.y) + PLAYER_HEIGHT + PAD * 2;
      const fitZoom = Math.min(VIEW_W / needW, VIEW_H / needH);
      this.camera.currentZoom = Math.min(1.0, fitZoom);
    } else if (p0) {
      this.camera.cameraX = p0.x + PLAYER_WIDTH / 2;
      this.camera.cameraY = p0.y + PLAYER_HEIGHT / 2;
      this.camera.currentZoom = 1.0;
    } else {
      this.camera.cameraX = 480;
      this.camera.cameraY = 270;
      this.camera.currentZoom = 1.0;
    }
    this.localSmooth = { x: 0, y: 0, velX: 0, velY: 0, initialized: false };
    this.remoteSmooth = { x: 0, y: 0, vx: 0, vy: 0, initialized: false };
    this.lastServerTick = 0;
    this.resetRagdolls();
  }

  /** Create tile sprites for all platforms in the map using 9-slice terrain tiles. */
  private createMapTiles(map: GameMap, seed: number) {
    if (!this.camera.hudCamera) console.warn(`[createMapTiles] hudCamera not set — tiles will render on both cameras!`);
    // Destroy previous round's tiles
    for (const t of this.platformTiles) t.destroy();
    this.platformTiles = [];
    for (const t of this.borderTiles) t.destroy();
    this.borderTiles = [];
    // Clean up pickup sprites from previous round
    for (const [, sprite] of this.pickupSprites) sprite.destroy();
    this.pickupSprites.clear();
    this.prevPickupActive.clear();

    // Deterministic background: hash seed for better distribution
    // Mulberry32-style mix to spread bits evenly
    let h = seed | 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
    h = (h ^ (h >>> 16)) >>> 0;
    const bgKey = BG_KEYS[h % BG_KEYS.length]!;
    const angle = (((h >>> 8) & 0xffff) / 0xffff) * Math.PI * 2;
    this.bgScrollX = Math.cos(angle) * 0.3;
    this.bgScrollY = Math.sin(angle) * 0.3;

    // Create/update background tileSprite clipped to arena bounds
    if (this.bgTile) this.bgTile.destroy();
    this.bgTile = this.add.tileSprite(map.width / 2, map.height / 2, map.width, map.height, bgKey).setDepth(-100);
    this.camera.hudCamera?.ignore(this.bgTile);

    for (const plat of map.platforms) {
      const tilesW = Math.max(1, Math.round(plat.width / 16));
      const tilesH = Math.max(1, Math.round(plat.height / 16));
      for (let ty = 0; ty < tilesH; ty++) {
        for (let tx = 0; tx < tilesW; tx++) {
          const frame = getTerrainFrame(tx, ty, tilesW, tilesH);
          const img = this.add
            .image(
              plat.x + tx * 16 + 8, // center of tile
              plat.y + ty * 16 + 8,
              "terrain",
              frame,
            )
            .setDepth(0);
          this.camera.hudCamera?.ignore(img);
          this.platformTiles.push(img);
        }
      }
    }

    // Pedestal tiles under weapon spawn points (3 tiles wide: L=17, M=18, R=19)
    // Visual content is at top ~3px of the 16x16 tile frame.
    // Position so the visual sits on the platform surface below the spawn point.
    const PEDESTAL_FRAMES = [17, 18, 19]; // col 17-19 row 0 in terrain spritesheet
    for (const sp of map.weaponSpawnPoints) {
      // Find the nearest platform surface below this spawn point
      let platformTop = map.height; // fallback to bottom
      for (const plat of map.platforms) {
        if (plat.y > sp.y && plat.y < platformTop && sp.x >= plat.x && sp.x <= plat.x + plat.width) {
          platformTop = plat.y;
        }
      }
      // Place tile so visual (top 3px of frame) rests on platform: center = platformTop + 5
      const tileY = platformTop + 5;
      for (let i = 0; i < 3; i++) {
        const img = this.add.image(sp.x + (i - 1) * 16, tileY, "terrain", PEDESTAL_FRAMES[i]!).setDepth(0);
        this.camera.hudCamera?.ignore(img);
        this.platformTiles.push(img);
      }
    }

    // Border tiles around arena using dark stone 9-slice (cols 0-2, rows 0-2)
    const TC = TERRAIN_COLS; // 22 tiles per row
    const B_TL = 3,
      B_T = 2 * TC + 1,
      B_TR = 4;
    const B_ML = TC + 2,
      B_MR = TC;
    const B_BL = TC + 3,
      B_B = 1,
      B_BR = TC + 4;
    const mw = map.width,
      mh = map.height;
    const tilesX = Math.ceil(mw / 16);
    const tilesY = Math.ceil(mh / 16);

    const addBorder = (x: number, y: number, frame: number) => {
      const img = this.add.image(x, y, "terrain", frame).setDepth(11);
      this.camera.hudCamera?.ignore(img);
      this.borderTiles.push(img);
    };

    // Border shifted inward so tile content sits flush against arena edge
    const bo = -4; // outward offset
    // Left column
    for (let ty = 0; ty < tilesY; ty++) addBorder(bo, ty * 16 + 8, B_ML);
    // Right column
    for (let ty = 0; ty < tilesY; ty++) addBorder(mw - bo, ty * 16 + 8, B_MR);
    // Top row
    for (let tx = 0; tx < tilesX; tx++) addBorder(tx * 16 + 8, bo, B_T);
    // Bottom row
    for (let tx = 0; tx < tilesX; tx++) addBorder(tx * 16 + 8, mh - bo, B_B);
    // Corners on top (rendered last = highest z within same depth)
    addBorder(bo, bo, B_TL);
    addBorder(mw - bo, bo, B_TR);
    addBorder(bo, mh - bo, B_BL);
    addBorder(mw - bo, mh - bo, B_BR);
  }

  startReplay(
    transcript: TickInputPair[],
    seed: number,
    mapIndex?: number,
    usernames?: [string, string],
    characters?: [number, number],
  ) {
    if (!this.sceneReady) {
      this.onReady(() => this.startReplay(transcript, seed, mapIndex, usernames, characters));
      return;
    }
    if (characters) {
      this.characterSlots = characters;
    } else {
      this.assignCharacters();
    }
    this.replayMode = true;
    this.replayTranscript = transcript;
    this.replayTick = 0;
    this.replayPaused = false;
    this.replaySpeed = 1;
    this.replayAccum = 0;
    this.localPlayerId = 0;
    this.playerUsernames = usernames ?? ["P1", "P2"];
    this.prediction = null;

    const map = mapIndex !== undefined ? (MAP_POOL[mapIndex] ?? ARENA) : ARENA;
    const mapJson = JSON.stringify(map);
    this.createMapTiles(map, seed);
    this.config = {
      seed,
      map,
      playerCount: 2,
      tickRate: TICK_RATE,
      initialLives: INITIAL_LIVES,
      matchDurationTicks: MATCH_DURATION_TICKS,
      suddenDeathStartTick: SUDDEN_DEATH_START_TICK,
    };
    // Free previous replay WASM state
    if (this.replayWasm) {
      try {
        this.replayWasm.free();
      } catch {
        /* already freed */
      }
    }
    this.replayWasm = new WasmState(seed, mapJson);
    const initial = this.replayWasm.export_state();
    this.prevState = initial;
    this.currState = initial;
    this.playing = true;
    hideAnnounce();
    document.getElementById("sudden-death-overlay")?.classList.remove("visible");
    this.explosions = [];
    this.camera.currentZoom = 1.0;
    this.camera.cameraX = 480;
    this.camera.cameraY = 270;
    this.localSmooth = { x: 0, y: 0, velX: 0, velY: 0, initialized: false };
    this.remoteSmooth = { x: 0, y: 0, vx: 0, vy: 0, initialized: false };
    this.resetRagdolls();
    this.replayInfoText.setVisible(true);

    // Remove previous replay listeners to prevent stacking.
    // Safe: removeAllListeners() is always called before re-adding below.
    this.input.keyboard?.removeAllListeners();

    // Keyboard controls for replay
    this.input.keyboard?.on("keydown-SPACE", () => {
      if (this.replayMode) this.replayPaused = !this.replayPaused;
    });
    this.input.keyboard?.on("keydown-ESC", () => {
      if (this.replayMode) this.exitReplay();
    });
    this.input.keyboard?.on("keydown-UP", () => {
      if (this.replayMode) this.replaySpeed = Math.min(this.replaySpeed * 2, 8);
    });
    this.input.keyboard?.on("keydown-DOWN", () => {
      if (this.replayMode) this.replaySpeed = Math.max(this.replaySpeed / 2, 0.5);
    });
  }

  startMultiRoundReplay(
    rounds: { seed: number; mapIndex: number; transcript: TickInputPair[] }[],
    usernames?: [string, string],
    characters?: [number, number],
  ) {
    if (!rounds.length) return;
    this.replayRounds = rounds;
    this.replayCurrentRound = 0;
    this.replayRoundWins = [0, 0];
    this.replayRoundTransitionTimer = 0;
    const first = rounds[0]!;
    this.startReplay(first.transcript, first.seed, first.mapIndex, usernames, characters);
  }

  private startReplayRound(roundIndex: number) {
    const round = this.replayRounds[roundIndex];
    if (!round) return;
    this.replayCurrentRound = roundIndex;
    this.replayTick = 0;
    this.replayAccum = 0;
    this.replayTranscript = round.transcript;
    this.replayRoundTransitionTimer = 0;

    const map = MAP_POOL[round.mapIndex] ?? MAP_POOL[0] ?? ARENA;
    const mapJson = JSON.stringify(map);
    this.createMapTiles(map, round.seed);
    this.config = {
      seed: round.seed,
      map,
      playerCount: 2,
      tickRate: TICK_RATE,
      initialLives: INITIAL_LIVES,
      matchDurationTicks: MATCH_DURATION_TICKS,
      suddenDeathStartTick: SUDDEN_DEATH_START_TICK,
    };
    // Free previous replay WASM state
    if (this.replayWasm) {
      try {
        this.replayWasm.free();
      } catch {
        /* already freed */
      }
    }
    this.replayWasm = new WasmState(round.seed, mapJson);
    const initial = this.replayWasm.export_state();
    this.prevState = initial;
    this.currState = initial;
    this.playing = true;
    hideAnnounce();
    document.getElementById("sudden-death-overlay")?.classList.remove("visible");
    this.explosions = [];
    this.resetRagdolls();
  }

  private exitReplay() {
    this.replayMode = false;
    this.playing = false;
    this.replayRounds = [];
    this.replayRoundTransitionTimer = 0;
    this.replayInfoText.setVisible(false);
    this.resetRagdolls();
    if (this.replayWasm) {
      try {
        this.replayWasm.free();
      } catch {
        /* already freed */
      }
      this.replayWasm = null;
    }
    hideAnnounce();
    this.input.keyboard?.removeAllListeners();
    // Return to lobby (dispatch event to main.ts)
    window.dispatchEvent(new CustomEvent("replayEnded"));
  }

  setNetworkRtt(ms: number) {
    this.networkRtt = ms;
  }

  receiveState(state: StateMessage, lastButtons?: [number, number]) {
    // Drop out-of-order packets — prevents old states from overwriting newer ones
    if (state.tick <= this.lastServerTick) return;
    this.lastServerTick = state.tick;

    // Buffer latest state — only applied once per update frame.
    // This prevents a feedback loop: if the frame is slow, multiple WebSocket
    // states queue up → processing all of them makes the next frame even slower.
    this.pendingServerState = state;
    this.pendingServerButtons = lastButtons as [number, number] | undefined;
  }

  endOnlineMatch(winner: number, silent = false) {
    this.playing = false;
    document.getElementById("sudden-death-overlay")?.classList.remove("visible");
    if (!silent) {
      if (winner === -1) {
        showAnnounce("DRAW!");
      } else {
        const name = this.playerUsernames[winner]?.toUpperCase();
        showAnnounce(name ? `${name} wins!` : `Player ${winner + 1} wins!`);
      }
    }
    this.audio.playSound("match-end");
    this.pendingServerState = null;
    this.pendingServerButtons = undefined;
    this.lastServerTick = 0;
    this.explosions = [];
    this.resetRagdolls();
  }

  // ── Spectator Mode (Tournament) ───────────────────────────────────────────

  startSpectating(
    seed: number,
    usernames: [string, string],
    mapIndex: number,
    totalRounds: number,
    characters: [number, number],
  ) {
    if (!this.sceneReady) {
      this.onReady(() => this.startSpectating(seed, usernames, mapIndex, totalRounds, characters));
      return;
    }
    this.spectateMode = true;
    this.localPlayerId = 0; // arbitrary, spectator doesn't control anyone
    this.characterSlots = characters;
    this.playerUsernames = usernames;
    this.replayMode = false;
    this.currentRound = 0;
    this.totalRounds = totalRounds;
    this.roundWins = [0, 0];
    this.roundTransition = false;
    this.lastServerTick = 0;

    this.playTransition(() => {
      this.warmupMode = false;
      this.tutorialMode = false;
      this.warmupState = null;
      document.getElementById("warmup-overlay")?.classList.remove("visible");
      this.initRound(seed, mapIndex);
      this.prediction = null; // spectators don't predict
      this.playing = true;
      document.getElementById("spectate-overlay")?.classList.add("visible");
    });
  }

  receiveSpectateState(state: GameStateData, lastButtons?: [number, number]) {
    // Same as receiveState but skip prediction
    if (state.tick <= this.lastServerTick) return;
    this.lastServerTick = state.tick;

    if (lastButtons) {
      this.lastReceivedButtons = [...lastButtons] as [number, number];
    }

    if (this.currState) {
      this.audio.detectAudioEvents(this.currState, state);
    }

    this.prevState = this.currState;
    this.currState = state;
    // No prediction for spectators
  }

  stopSpectating() {
    this.spectateMode = false;
    this.playing = false;
    document.getElementById("spectate-overlay")?.classList.remove("visible");
  }

  /** Clear rendered game visuals (used between tournament matches to avoid flashes). */
  clearVisuals() {
    this.gfx.clear();
    this.gfxOverlay.clear();
    for (const sprite of this.playerSprites) {
      if (sprite) sprite.setVisible(false);
    }
    for (const [, sprite] of this.pickupSprites) {
      sprite.setVisible(false);
    }
  }

  get isSpectating(): boolean {
    return this.spectateMode;
  }

  setMuted(muted: boolean) {
    this.audio.setMusicMuted(muted);
  }

  setMusicMuted(muted: boolean) {
    this.audio.setMusicMuted(muted);
  }

  setBGMVolume(vol: number) {
    this.audio.setBGMVolume(vol);
  }

  setSFXVolume(vol: number) {
    this.audio.setSFXVolume(vol);
  }

  setDynamicZoom(enabled: boolean) {
    this.camera.dynamicZoom = enabled;
  }

  setControlsHint(text: string) {
    if (this.controlsText) this.controlsText.setText(text);
  }

  /** Handle browser window resize — reposition HUD, update cameras, resize background. */
  handleResize() {
    // Reposition HUD texts to new viewport edges
    this.timerText.setPosition(VIEW_W - 20, 10).setResolution(DPR);
    this.suddenDeathText.setPosition(VIEW_W / 2, this.suddenDeathText.y).setResolution(DPR);
    this.controlsText.setPosition(10, VIEW_H - 25).setResolution(DPR);
    this.roundText.setResolution(DPR);
    this.replayInfoText.setPosition(VIEW_W / 2, VIEW_H - 10).setResolution(DPR);
    this.camera.handleResize(this.config);

    // bgTile is arena-sized (clipped to border), no resize needed
  }

  update(_time: number, delta: number) {
    // Flush pending server state (only the latest — prevents queue feedback loop)
    if (this.pendingServerState) {
      const state = this.pendingServerState;
      const lastButtons = this.pendingServerButtons;
      this.pendingServerState = null;
      this.pendingServerButtons = undefined;

      if (lastButtons) {
        this.lastReceivedButtons = [...lastButtons] as [number, number];
      }
      if (this.currState) {
        this.audio.detectAudioEvents(this.currState, state);
      }
      this.prevState = this.currState;
      this.currState = state;
      if (this.prediction) {
        this.prediction.applyServerState(state, state.tick, lastButtons);
      }
    }

    if (!this.currState) return;
    // Cap delta to prevent burst of ticks after scene transitions
    if (delta > 100) delta = TICK_DT_MS;

    // Tutorial mode — step local WASM sim with P1 input + tutorial-controlled P2
    if (this.tutorialMode && this.warmupWasm && this.warmupConfig && this.tutorialRef) {
      this.warmupAccum += delta;
      const maxTicks = 3;
      let ticksRun = 0;
      while (this.warmupAccum >= TICK_DT_MS && ticksRun < maxTicks) {
        this.warmupAccum -= TICK_DT_MS;
        ticksRun++;
        if (this.warmupWasm.match_over()) break;
        const p0 = this.warmupState?.players?.[0];
        const input = p0
          ? this.inputManager.getPlayer1Input(p0.x + PLAYER_WIDTH / 2, p0.y + PLAYER_HEIGHT / 2)
          : NULL_INPUT;
        const result: TutorialTickResult = this.tutorialRef.tick(this.warmupState!, input);
        const prevWarmup = this.warmupState;
        this.warmupWasm.step(input.buttons, input.aimX, input.aimY, result.p2Buttons, result.p2AimX, result.p2AimY);
        this.warmupState = this.warmupWasm.export_state();
        if (result.banishP2) {
          this.banishWarmupPlayer2(this.warmupState!);
        }
        if (result.modifyState) {
          result.modifyState(this.warmupState!);
        }
        this.warmupWasm.import_state(this.warmupState);
        this.audio.detectAudioEvents(prevWarmup!, this.warmupState!);
      }
      if (this.warmupAccum > TICK_DT_MS * 2) this.warmupAccum = 0;
      this.currState = this.warmupState;
      this.render(delta);
      return;
    }

    // Warmup mode — step local WASM sim with player 0 input
    if (this.warmupMode && this.warmupWasm && this.warmupConfig) {
      this.warmupAccum += delta;
      const maxTicks = 3;
      let ticksRun = 0;
      while (this.warmupAccum >= TICK_DT_MS && ticksRun < maxTicks) {
        this.warmupAccum -= TICK_DT_MS;
        ticksRun++;
        if (this.warmupWasm.match_over()) break;
        const p0 = this.warmupState?.players?.[0];
        const input = p0
          ? this.inputManager.getPlayer1Input(p0.x + PLAYER_WIDTH / 2, p0.y + PLAYER_HEIGHT / 2)
          : NULL_INPUT;
        const prevWarmup = this.warmupState;
        this.warmupWasm.step(input.buttons, input.aimX, input.aimY, 0, 0, 0);
        this.warmupState = this.warmupWasm.export_state();
        this.banishWarmupPlayer2(this.warmupState!);
        // Import banished state back so WASM sim has P2 off-screen (prevents bullet absorption)
        this.warmupWasm.import_state(this.warmupState);
        this.audio.detectAudioEvents(prevWarmup!, this.warmupState!);
      }
      if (this.warmupAccum > TICK_DT_MS * 2) this.warmupAccum = 0;
      this.currState = this.warmupState;
      this.render(delta);
      return;
    }

    // Replay mode
    if (this.replayMode && !this.replayPaused && this.playing) {
      this.replayAccum += delta * this.replaySpeed;
      const maxTicks = 6;
      let ticksRun = 0;
      while (this.replayAccum >= TICK_DT_MS && ticksRun < maxTicks) {
        this.replayAccum -= TICK_DT_MS;
        ticksRun++;
        if (this.replayTick < this.replayTranscript.length && !this.currState!.matchOver && this.replayWasm) {
          const tickInputs = this.replayTranscript[this.replayTick];
          if (!tickInputs || !tickInputs[0] || !tickInputs[1]) {
            // Truncated/corrupt transcript — stop replay gracefully
            this.playing = false;
            break;
          }
          const p0i = tickInputs[0];
          const p1i = tickInputs[1];
          const b0 = p0i.buttons,
            ax0 = p0i.aim_x ?? p0i.aimX ?? 0,
            ay0 = p0i.aim_y ?? p0i.aimY ?? 0;
          const b1 = p1i.buttons,
            ax1 = p1i.aim_x ?? p1i.aimX ?? 0,
            ay1 = p1i.aim_y ?? p1i.aimY ?? 0;
          this.prevState = this.currState;
          this.replayWasm.step(b0, ax0, ay0, b1, ax1, ay1);
          this.currState = this.replayWasm.export_state();
          this.replayTick++;
        } else if (this.currState!.matchOver) {
          const w = this.currState!.winner;
          if (w === 0) this.replayRoundWins[0]++;
          else if (w === 1) this.replayRoundWins[1]++;
          const wName = (this.playerUsernames[w] || `Player ${w + 1}`).toUpperCase();
          const hasMoreRounds = this.replayCurrentRound + 1 < this.replayRounds.length;
          if (hasMoreRounds) {
            showAnnounce(
              `Round ${this.replayCurrentRound + 1} - ${wName} wins!\n${this.replayRoundWins[0]} - ${this.replayRoundWins[1]}`,
            );
            this.replayRoundTransitionTimer = 2000;
          } else {
            const mw = this.replayRoundWins[0] > this.replayRoundWins[1] ? 0 : 1;
            const mwName = (this.playerUsernames[mw] || `Player ${mw + 1}`).toUpperCase();
            showAnnounce(`${mwName} wins!\n${this.replayRoundWins[0]} - ${this.replayRoundWins[1]}`);
            // Auto-exit replay after delay + transition
            setTimeout(() => {
              if (!this.replayMode) return;
              this.playTransition(() => {
                this.exitReplay();
              });
            }, 2500);
          }
          this.playing = false;
          break;
        } else {
          // Transcript exhausted before matchOver — stop replay to prevent freeze
          this.playing = false;
          break;
        }
      }
    }

    // Replay round transition timer
    if (this.replayMode && !this.playing && this.replayRoundTransitionTimer > 0) {
      this.replayRoundTransitionTimer -= delta;
      if (this.replayRoundTransitionTimer <= 0) {
        this.startReplayRound(this.replayCurrentRound + 1);
      }
    }

    if (this.playing && this.prediction && !this.replayMode) {
      // Cap prediction: don't run further than MAX_LEAD ticks ahead of server
      const MAX_LEAD = 10;
      const canPredict = this.lastServerTick === 0 || this.prediction.currentTick < this.lastServerTick + MAX_LEAD;

      // Run prediction at fixed 60Hz rate
      this.predictionAccum += delta;
      const maxTicks = 3;
      let ticksRun = 0;

      while (this.predictionAccum >= TICK_DT_MS && ticksRun < maxTicks) {
        if (!canPredict) {
          // Don't advance prediction, just drain accumulator
          this.predictionAccum -= TICK_DT_MS;
          ticksRun++;
          continue;
        }
        this.predictionAccum -= TICK_DT_MS;
        ticksRun++;

        const predState = this.prediction.predictedState;
        if (!predState) continue;
        const player = predState.players[this.localPlayerId];
        if (player) {
          const input = this.inputManager.getPlayer1Input(player.x + PLAYER_WIDTH / 2, player.y + PLAYER_HEIGHT / 2);
          const nextTick = this.prediction.currentTick + 1;
          this.onLocalInput?.(input, nextTick);
          this.prediction.predictTick(input);
        }
      }

      // Clamp accumulator to prevent runaway
      if (this.predictionAccum > TICK_DT_MS * 2) {
        this.predictionAccum = 0;
      }

      // Adaptive prediction lead based on RTT
      // One-way latency in ticks + 1 tick buffer, clamped to [2, 12]
      const rttMs = this.networkRtt;
      const PRED_LEAD = Math.max(2, Math.min(8, Math.ceil(rttMs / (2 * TICK_DT_MS)) + 1));
      if (this.lastServerTick > 0) {
        const targetTick = this.lastServerTick + PRED_LEAD;
        let extraTicks = 0;
        while (this.prediction.currentTick < targetTick && extraTicks < PRED_LEAD) {
          const predState2 = this.prediction.predictedState;
          if (!predState2) break;
          const player = predState2.players[this.localPlayerId];
          if (!player) break;
          const input = this.inputManager.getPlayer1Input(player.x + PLAYER_WIDTH / 2, player.y + PLAYER_HEIGHT / 2);
          const nextTick = this.prediction.currentTick + 1;
          this.onLocalInput?.(input, nextTick);
          this.prediction.predictTick(input);
          extraTicks++;
        }
      }

      // Track peak reconciliation error
      if (this.prediction) {
        const err = this.prediction.lastReconcileError;
        this.diagMaxErrX = Math.max(this.diagMaxErrX, err.x);
        this.diagMaxErrY = Math.max(this.diagMaxErrY, err.y);
      }

      this.diagTimer += delta;
      if (this.diagTimer > 2000) {
        this.diagTimer = 0;
        if (this.prediction) {
          console.log(
            `[netcode] RTT=${Math.round(rttMs)}ms PRED=${PRED_LEAD} gap=${this.prediction.currentTick - this.lastServerTick} ` +
              `peakErr=${this.diagMaxErrX.toFixed(1)}/${this.diagMaxErrY.toFixed(1)} ` +
              `teleports=${this.diagTeleports} maxJump=${this.diagMaxVisualJump.toFixed(1)}`,
          );
        }
        this.diagMaxErrX = 0;
        this.diagMaxErrY = 0;
        this.diagTeleports = 0;
        this.diagMaxVisualJump = 0;
        const showHighPing = rttMs > 180;
        if (showHighPing !== this.highPingShown) {
          this.highPingShown = showHighPing;
          document.getElementById("high-ping-overlay")?.classList.toggle("visible", showHighPing);
        }
      }
    }

    this.render(delta);
  }

  private render(delta: number) {
    // Animate background scroll
    if (this.bgTile) {
      this.bgTile.tilePositionX += this.bgScrollX * (delta / 16.667);
      this.bgTile.tilePositionY += this.bgScrollY * (delta / 16.667);
    }

    const g = this.gfx;
    g.clear();
    this.gfxOverlay.clear();

    const curr = this.currState;
    if (!curr) return;

    const predicted = this.replayMode ? null : (this.prediction?.predictedState ?? null);
    const displayState = predicted ?? curr;

    // Detect rocket explosions — track all rockets from server state only
    // (using predicted state causes phantom explosions when prediction disagrees with server)
    const currentRocketIds = new Set<number>();
    for (const proj of curr.projectiles) {
      if (proj.weapon === WeaponType.Rocket) currentRocketIds.add(proj.id);
    }
    for (const [id, pos] of this.prevRockets) {
      if (!currentRocketIds.has(id)) {
        this.explosions.push({ x: pos.x, y: pos.y, timer: 15 });
        this.audio.playSound("explosion");
      }
    }
    this.prevRockets.clear();
    // Store rocket positions for next-frame disappearance detection
    const rcfg = GUN_CONFIG[WeaponType.Rocket];
    const ryOff = rcfg ? rcfg.offsetY + rcfg.muzzleY * rcfg.scale : 0;
    // Store all rocket positions from server state for next-frame disappearance detection
    for (const proj of curr.projectiles) {
      if (proj.weapon === WeaponType.Rocket) {
        this.prevRockets.set(proj.id, { x: proj.x, y: proj.y + ryOff });
      }
    }

    this.camera.updateCamera(curr, predicted, delta, {
      config: this.config,
      warmupConfig: this.warmupConfig,
      warmupMode: this.warmupMode,
      tutorialMode: this.tutorialMode,
      localPlayerId: this.localPlayerId,
      roundTransition: this.roundTransition,
    });
    this.drawArena(g, displayState);
    this.drawPickups(g, curr);
    this.drawPlayers(g, curr, predicted, delta);
    this.drawProjectiles(g, curr, predicted, delta);
    this.drawExplosions(g);
    this.drawHUD(curr, displayState, predicted);
  }

  private drawArena(g: Phaser.GameObjects.Graphics, displayState: GameStateData) {
    const map = this.config?.map ?? ARENA;
    // Platforms are rendered by tile sprites (createMapTiles), not Graphics.
    // Draw sudden death damage zone (cosmetic — zone is damage-only, not physical).
    if (displayState.arenaLeft > 0) {
      g.fillStyle(WALL_COLOR, 0.5);
      g.fillRect(0, 0, displayState.arenaLeft, map.height);
      g.fillRect(displayState.arenaRight, 0, map.width - displayState.arenaRight, map.height);
    }
  }

  private drawPickups(_g: Phaser.GameObjects.Graphics, displayState: GameStateData) {
    const tick = displayState.tick;
    const activeIds = new Set<number>();

    for (const pickup of displayState.weaponPickups) {
      activeIds.add(pickup.id);
      const wasActive = this.prevPickupActive.get(pickup.id) ?? pickup.respawnTimer <= 0;

      if (pickup.respawnTimer > 0) {
        // Respawning — hide sprite, show faint outline via graphics
        this.getPickupSprite(pickup.id)?.setVisible(false);
        this.prevPickupActive.set(pickup.id, false);

        // Detect collection: was active, now respawning → play collection animation
        if (wasActive) {
          const fx = this.add
            .sprite(pickup.x, pickup.y + 20, "collected")
            .setDepth(25)
            .setScale(1);
          this.camera.hudCamera.ignore(fx);
          fx.play("collected");
          fx.once("animationcomplete", () => fx.destroy());
        }
        continue;
      }

      this.prevPickupActive.set(pickup.id, true);

      // Active pickup — show gun icon sprite with bob, lowered to sit above stand
      const bob = Math.sin(tick * 0.08) * 2;
      const py = pickup.y + 20 + bob;
      const tex = GUN_TEXTURES[pickup.weapon];
      let sprite = this.getPickupSprite(pickup.id);
      if (!sprite) {
        sprite = this.add
          .image(pickup.x, py, tex ?? "gun-pistol")
          .setDepth(15)
          .setScale(0.6);
        this.camera.hudCamera.ignore(sprite);
        this.pickupSprites.set(pickup.id, sprite);
      }
      if (tex && sprite.texture.key !== tex) {
        sprite.setTexture(tex);
      }
      sprite.setPosition(pickup.x, py);
      sprite.setVisible(true);
      sprite.setAlpha(0.9 + Math.sin(tick * 0.06) * 0.1);

      // Emit glow particles around active pickups
      if (this.pickupGlowEmitter && tick % 8 === 0) {
        this.pickupGlowEmitter.emitParticleAt(
          pickup.x + (Math.random() - 0.5) * 16,
          py + (Math.random() - 0.5) * 16,
          1,
        );
      }
    }

    // Hide sprites for pickups no longer in the state
    for (const [id, sprite] of this.pickupSprites) {
      if (!activeIds.has(id)) {
        sprite.setVisible(false);
      }
    }
  }

  private getPickupSprite(id: number): Phaser.GameObjects.Image | undefined {
    return this.pickupSprites.get(id);
  }

  private drawPlayers(
    g: Phaser.GameObjects.Graphics,
    curr: GameStateData,
    predicted: GameStateData | null,
    delta?: number,
  ) {
    // First pass: compute draw positions for all players
    const drawPositions: { x: number; y: number }[] = [];
    const playerStates: (SerializedPlayer | null)[] = [];

    for (let i = 0; i < curr.players.length; i++) {
      if (this.warmupMode && i === 1) {
        drawPositions.push({ x: 0, y: 0 });
        playerStates.push(null);
        continue;
      }
      const isLocal = i === this.localPlayerId && !this.replayMode;
      const raw = curr.players[i]!;
      let cp: SerializedPlayer;
      let drawX: number, drawY: number;

      if (this.replayMode) {
        cp = raw;
        drawX = Math.round(cp.x);
        drawY = Math.round(cp.y);
      } else if (isLocal) {
        // Use predicted position for responsiveness, but server-authoritative combat fields
        // (health, lives, deaths) to avoid desync artifacts like "healing" when server disagrees
        const pred = predicted?.players[i];
        cp = pred
          ? {
              ...pred,
              health: raw.health,
              lives: raw.lives,
              stateFlags: raw.stateFlags,
              stompedBy: raw.stompedBy,
              stompingOn: raw.stompingOn,
              stompShakeProgress: raw.stompShakeProgress,
            }
          : raw;
        // Exponential smoothing: frame-rate-independent blend toward predicted position
        // Uses smoothLerp (exponential decay) which is unconditionally stable at any dt
        // Blend rate scales down for larger errors to prevent visible teleporting
        const ls = this.localSmooth;
        const dt = delta ?? 16.667;
        if (!ls.initialized) {
          ls.x = cp.x;
          ls.y = cp.y;
          ls.velX = 0;
          ls.velY = 0;
          ls.initialized = true;
        }
        const dx = cp.x - ls.x;
        const dy = cp.y - ls.y;
        const errMag = Math.max(Math.abs(dx), Math.abs(dy));
        if (errMag > 200) {
          ls.x = cp.x;
          ls.y = cp.y;
          this.diagTeleports++;
        } else {
          // Hybrid: exponential blend (natural deceleration) + pixel cap (prevents snaps).
          // At 50px error, blend produces 15px correction (exactly at cap) — smooth transition.
          // Below 50px: purely exponential. Above 50px: capped at 15px then exponential tail.
          const maxCorr = 15 * (dt / TICK_DT_MS);

          const targetX = smoothLerp(ls.x, cp.x, 0.3, dt);
          const corrX = targetX - ls.x;
          ls.x += Math.abs(corrX) <= maxCorr ? corrX : Math.sign(corrX) * maxCorr;

          // Y: snap to ground when close (crisp ground movement), smooth when airborne or far
          if (cp.grounded && Math.abs(dy) < 25) {
            ls.y = cp.y;
          } else {
            const targetY = smoothLerp(ls.y, cp.y, 0.3, dt);
            const corrY = targetY - ls.y;
            ls.y += Math.abs(corrY) <= maxCorr ? corrY : Math.sign(corrY) * maxCorr;
          }
        }
        drawX = Math.round(ls.x);
        drawY = Math.round(ls.y);
        // Track visual jump magnitude for diagnostics
        const visualJump = Math.max(Math.abs(drawX - this.diagPrevVisualX), Math.abs(drawY - this.diagPrevVisualY));
        if (this.diagPrevVisualX !== 0) this.diagMaxVisualJump = Math.max(this.diagMaxVisualJump, visualJump);
        this.diagPrevVisualX = drawX;
        this.diagPrevVisualY = drawY;
      } else {
        // Remote player: dead reckoning with server correction
        cp = raw;
        const smooth = this.remoteSmooth;
        const dt = delta ?? 16.667;
        if (!smooth.initialized) {
          smooth.x = cp.x;
          smooth.y = cp.y;
          smooth.vx = cp.vx ?? 0;
          smooth.vy = cp.vy ?? 0;
          smooth.initialized = true;
        }
        const teleported = Math.abs(smooth.x - cp.x) > 160 || Math.abs(smooth.y - cp.y) > 160;
        if (teleported) {
          smooth.x = cp.x;
          smooth.y = cp.y;
        } else {
          // Advance by velocity (dead reckoning) with parabolic Y, then correct toward server
          const ticks = dt / TICK_DT_MS;
          smooth.x += smooth.vx * ticks;
          smooth.y += smooth.vy * ticks + 0.5 * GRAVITY * ticks * ticks;
          // Pull toward server position
          smooth.x = smooth.x + (cp.x - smooth.x) * 0.4;
          smooth.y = smooth.y + (cp.y - smooth.y) * 0.4;
        }
        // Update velocity from latest server state
        smooth.vx = cp.vx ?? 0;
        smooth.vy = cp.vy ?? 0;
        // Snap to ground when server says grounded (prevents floating)
        if (cp.grounded) smooth.y = cp.y;
        drawX = Math.round(smooth.x);
        drawY = Math.round(smooth.y);
      }
      drawPositions.push({ x: drawX, y: drawY });
      playerStates.push(cp);
    }

    // Snap riders to victim draw positions so they match exactly
    for (let i = 0; i < playerStates.length; i++) {
      const cp = playerStates[i];
      if (!cp || cp.stompingOn === null || cp.stompingOn < 0) continue;
      const victimIdx = curr.players.findIndex((p) => p.id === cp.stompingOn);
      if (victimIdx >= 0 && drawPositions[victimIdx]) {
        drawPositions[i] = {
          x: drawPositions[victimIdx]!.x,
          y: drawPositions[victimIdx]!.y - PLAYER_HEIGHT + 10,
        };
      }
    }

    // Second pass: render all players
    for (let i = 0; i < curr.players.length; i++) {
      if (this.warmupMode && i === 1) {
        this.playerSprites[i]?.setVisible(false);
        this.gunSprites[i]?.setVisible(false);
        this.nameTexts[i]?.setVisible(false);
        continue;
      }
      const cp = playerStates[i]!;
      const drawX = drawPositions[i]!.x;
      const drawY = drawPositions[i]!.y;

      const sprite = this.playerSprites[i];
      const alive = !!(cp.stateFlags & PlayerStateFlag.Alive);

      if (!alive) {
        // Always hide gun, stomp alert, name immediately
        this.gunSprites[i]?.setVisible(false);
        this.stompAlertTexts[i]?.setAlpha(0);
        this.nameTexts[i]?.setVisible(false);

        const ragdoll = this.deathRagdoll[i]!;
        const dt = (delta ?? 16.667) / 1000; // seconds
        const currentMap = this.config?.map ?? ARENA;

        // Detect fresh death (was alive last frame, now dead)
        if (ragdoll.wasAlive && !ragdoll.active && !ragdoll.settled) {
          ragdoll.active = true;
          ragdoll.x = drawX;
          ragdoll.y = drawY;
          // Preserve momentum — exaggerate for comedy
          ragdoll.vx = (cp.vx ?? 0) * 1.5;
          ragdoll.vy = Math.min(cp.vy ?? 0, -2) * 1.2 - 3; // always pop up a bit
          // Spin direction: if moving, topple in movement direction; if still, fall backward (away from facing)
          if (Math.abs(cp.vx ?? 0) > 0.5) {
            ragdoll.angularVel = (cp.vx ?? 0) > 0 ? 6 : -6;
          } else {
            ragdoll.angularVel = cp.facing === Facing.Right ? -5 : 5; // fall backward
          }
          ragdoll.rotation = 0;
          ragdoll.bounces = 0;
          // Play hit animation
          if (sprite) {
            const slug = CHARACTER_SLUGS[this.characterSlots[i] ?? 0];
            sprite.play(`${slug}-hit`);
          }
        }
        ragdoll.wasAlive = false;

        // Ragdoll physics simulation
        if (ragdoll.active && sprite) {
          const prevBottom = ragdoll.y + PLAYER_HEIGHT;

          // Gravity + movement
          ragdoll.vy += GRAVITY * 60 * dt;
          ragdoll.x += ragdoll.vx * 60 * dt;
          ragdoll.y += ragdoll.vy * 60 * dt;

          // Rotation: spin until lying flat (±PI/2), then stop
          if (Math.abs(ragdoll.rotation) < Math.PI / 2) {
            ragdoll.rotation += ragdoll.angularVel * dt;
            // Clamp to ±PI/2 — body topples flat and stays
            if (Math.abs(ragdoll.rotation) >= Math.PI / 2) {
              ragdoll.rotation = (Math.sign(ragdoll.rotation) * Math.PI) / 2;
              ragdoll.angularVel = 0;
            }
          }

          // Ground collision: only catch surfaces the body falls ONTO from above
          const bodyBottom = ragdoll.y + PLAYER_HEIGHT;
          let floorY = currentMap.height; // map floor
          for (const plat of currentMap.platforms) {
            if (
              ragdoll.x + PLAYER_WIDTH > plat.x &&
              ragdoll.x < plat.x + plat.width &&
              bodyBottom >= plat.y &&
              prevBottom <= plat.y + 4 && // was above (or near top of) this platform last frame
              ragdoll.vy > 0
            ) {
              floorY = Math.min(floorY, plat.y);
            }
          }

          if (bodyBottom >= floorY && ragdoll.vy > 0) {
            ragdoll.y = floorY - PLAYER_HEIGHT;
            ragdoll.bounces++;
            if (ragdoll.bounces >= 3 || Math.abs(ragdoll.vy) < 1.5) {
              // Settle
              ragdoll.active = false;
              ragdoll.settled = true;
              ragdoll.vx = 0;
              ragdoll.vy = 0;
              ragdoll.angularVel = 0;
            } else {
              // Bounce! Dampen and reverse
              ragdoll.vy *= -0.45;
              ragdoll.vx *= 0.7;
            }
          }

          // Wall collision: clamp to MAP bounds (not arena/zone — corpses ignore the red zone)
          if (ragdoll.x < 0) {
            ragdoll.x = 0;
            ragdoll.vx = Math.abs(ragdoll.vx) * 0.4;
          } else if (ragdoll.x + PLAYER_WIDTH > currentMap.width) {
            ragdoll.x = currentMap.width - PLAYER_WIDTH;
            ragdoll.vx = -Math.abs(ragdoll.vx) * 0.4;
          }

          // Render: center pivot, position at hitbox center
          sprite.setOrigin(0.5, 0.5);
          sprite.setPosition(Math.round(ragdoll.x + PLAYER_WIDTH / 2), Math.round(ragdoll.y + PLAYER_HEIGHT / 2));
          sprite.setRotation(ragdoll.rotation);
          sprite.setAlpha(0.9);
          sprite.setVisible(true);
          sprite.setDepth(15); // behind living players
        } else if (ragdoll.settled && sprite) {
          // Settled: corpse lying flat on the ground, nudge down so body rests on surface
          sprite.setOrigin(0.5, 0.5);
          sprite.setPosition(Math.round(ragdoll.x + PLAYER_WIDTH / 2), Math.round(ragdoll.y + PLAYER_HEIGHT / 2 + 6));
          sprite.setRotation(ragdoll.rotation);
          sprite.setAlpha(0.5);
          sprite.setVisible(true);
          sprite.setDepth(15);
        } else {
          sprite?.setVisible(false);
        }

        // Respawn pulse rectangle at spawn point (if lives remain)
        if (cp.lives > 0) {
          const spawn = currentMap.spawnPoints[cp.id % currentMap.spawnPoints.length]!;
          const displayTick = predicted?.tick ?? curr.tick;
          const pulse = Math.sin(displayTick * 0.15) * 0.3 + 0.5;
          const color = PLAYER_COLORS[cp.id] ?? 0xffffff;
          g.fillStyle(color, pulse);
          g.fillRect(spawn.x, spawn.y, PLAYER_WIDTH, PLAYER_HEIGHT);
        }
        continue;
      }

      // Player is alive — snapshot position for ragdoll, handle respawn reset
      {
        const ragdoll = this.deathRagdoll[i]!;
        const hasActiveRagdoll = ragdoll.active || ragdoll.settled;
        if (hasActiveRagdoll) {
          // Ragdoll in progress — only reset on genuine respawn (invincible flag)
          const invincibleNow = !!(cp.stateFlags & PlayerStateFlag.Invincible);
          if (invincibleNow) {
            ragdoll.active = false;
            ragdoll.settled = false;
            ragdoll.rotation = 0;
            ragdoll.angularVel = 0;
            ragdoll.bounces = 0;
            ragdoll.wasAlive = true;
            if (sprite) {
              sprite.setOrigin(0.5, 0.5);
              sprite.setRotation(0);
              sprite.setAlpha(1);
            }
          }
          // Otherwise: prediction flicker — don't touch ragdoll, don't set wasAlive
        } else {
          ragdoll.wasAlive = true;
        }
      }

      // If ragdoll is still active (prediction flicker — briefly "alive"), skip alive rendering
      if (this.deathRagdoll[i]!.active || this.deathRagdoll[i]!.settled) {
        continue;
      }

      const invincible = !!(cp.stateFlags & PlayerStateFlag.Invincible);
      const displayTick = predicted?.tick ?? curr.tick;
      if (invincible && displayTick % 6 < 3) {
        sprite?.setVisible(false);
        this.gunSprites[i]?.setVisible(false);
        this.nameTexts[i]?.setVisible(false);
        continue;
      }

      // Update character sprite
      if (sprite) {
        const slug = CHARACTER_SLUGS[this.characterSlots[i] ?? 0];
        let animKey: string;
        const hasGun = cp.weapon !== null && cp.weapon >= 0;
        // Determine crouch button state for edge detection
        // Local player: read inputManager directly (no round-trip delay)
        const isLocal =
          (i === this.localPlayerId && !this.replayMode) || ((this.warmupMode || this.tutorialMode) && i === 0);
        const playerBtns = isLocal
          ? this.inputManager.getPlayer1Input(cp.x, cp.y).buttons
          : this.lastReceivedButtons[i];
        const tauntNow = !!((playerBtns ?? 0) & Button.Taunt);
        const tauntPrev = !!((this.prevFrameButtons[i] ?? 0) & Button.Taunt);
        const tauntEdge = tauntNow && !tauntPrev && cp.grounded;
        const tauntPlaying = sprite.anims.currentAnim?.key === `${slug}-crouch` && sprite.anims.isPlaying;
        if (!this.playing && !this.replayMode && !this.spectateMode && !this.tutorialMode && !this.warmupMode) {
          // During countdown freeze, force idle animation
          animKey = `${slug}-idle`;
        } else if (tauntEdge) {
          // Restart animation + sound immediately (interrupts previous)
          sprite.play(`${slug}-crouch`);
          const soundKey = CROUCH_SOUNDS[slug!];
          if (soundKey) this.audio.playSoundInterrupt(soundKey);
          animKey = `${slug}-crouch`;
        } else if (tauntPlaying) {
          animKey = `${slug}-crouch`;
        } else if (cp.wallSliding) {
          animKey = `${slug}-wall-jump`;
        } else if (!cp.grounded && cp.vy < 0 && cp.jumpsLeft === 0 && !hasGun) {
          animKey = `${slug}-double-jump`;
        } else if (!cp.grounded && cp.vy < 0) {
          animKey = `${slug}-jump`;
        } else if (!cp.grounded) {
          animKey = `${slug}-fall`;
        } else if (Math.abs(cp.vx) > 0.5) {
          animKey = `${slug}-run`;
        } else {
          animKey = `${slug}-idle`;
        }
        if (!tauntEdge && !tauntPlaying && sprite.anims.currentAnim?.key !== animKey) {
          sprite.play(animKey);
        }
        // Nudge sprite toward wall when sliding against platform edge (sprite 32px, hitbox 24px)
        // Don't nudge at map boundary walls — sprite already flush with wall tiles
        const mapW = this.config?.map.width ?? 960;
        const atMapWall = cp.x <= 0 || cp.x + PLAYER_WIDTH >= mapW;
        const wallNudge = cp.wallSliding && !atMapWall ? cp.wallDir * 4 : 0;
        sprite.setPosition(Math.round(drawX + PLAYER_WIDTH / 2 + wallNudge), Math.round(drawY + PLAYER_HEIGHT / 2));
        sprite.setFlipX(cp.facing === Facing.Left);
        sprite.setVisible(true);
        sprite.setAlpha(invincible ? 0.6 : 1);
        sprite.setRotation(0);
        sprite.setOrigin(0.5, 0.5);
        // Rider renders behind victim; victim on top so their bars are visible
        if (cp.stompingOn !== null && cp.stompingOn >= 0) {
          sprite.setDepth(18);
        } else if (cp.stompedBy !== null && cp.stompedBy >= 0) {
          sprite.setDepth(22);
        } else {
          sprite.setDepth(20);
        }
      }

      // Gun sprite — position at character's hand, bob synced to animation frame
      const gunSprite = this.gunSprites[i];
      if (gunSprite) {
        if (cp.weapon !== null && cp.weapon >= 0 && alive) {
          const tex = GUN_TEXTURES[cp.weapon];
          if (tex && gunSprite.texture.key !== tex) {
            gunSprite.setTexture(tex);
          }
          const gcfg = GUN_CONFIG[cp.weapon];
          // When wall sliding, point gun AWAY from wall (opposite of facing)
          const gunFacing = cp.wallSliding ? -(cp.facing as number) : (cp.facing as number);
          // Bob derived from current animation frame — steps at 20fps, in sync with the sprite
          const frameIdx = sprite?.anims?.currentFrame?.index ?? 0;
          const totalFrames = sprite?.anims?.currentAnim?.frames?.length ?? 1;
          const bobY =
            gcfg && totalFrames > 1 ? Math.sin((frameIdx / totalFrames) * Math.PI * 2) * gcfg.bobAmplitude : 0;
          const gunOffX = gunFacing * (gcfg?.offsetX ?? 10);
          const gunOffY = (gcfg?.offsetY ?? 4) + bobY;
          gunSprite.setPosition(drawX + PLAYER_WIDTH / 2 + gunOffX, drawY + PLAYER_HEIGHT / 2 + gunOffY);
          gunSprite.setScale(gcfg?.scale ?? 0.5);
          gunSprite.setFlipX(gunFacing === -1);
          gunSprite.setVisible(true);
          gunSprite.setAlpha(invincible ? 0.6 : 1);
          // Match sprite depth for stomp layering
          gunSprite.setDepth(
            cp.stompingOn !== null && cp.stompingOn >= 0 ? 19 : cp.stompedBy !== null && cp.stompedBy >= 0 ? 23 : 21,
          );
        } else {
          gunSprite.setVisible(false);
        }
      }

      // Dust particle effects: jump, double jump, landing
      {
        const feetX = drawX + PLAYER_WIDTH / 2;
        const feetY = drawY + PLAYER_HEIGHT;
        const wasGrounded = this.prevPlayerGrounded[i];
        const prevJumps = this.prevPlayerJumpsLeft[i];

        // Landing: sideways cloud at feet level — bursts left + right
        // Use physics y (cp.y) instead of smoothed drawY so dust is at actual ground
        if (!wasGrounded && cp.grounded && this.dustGroundEmitL && this.dustGroundEmitR) {
          const groundY = cp.y + PLAYER_HEIGHT;
          for (let p = 0; p < 5; p++) {
            this.dustGroundEmitL.emitParticleAt(feetX - Math.random() * 6, groundY, 1);
            this.dustGroundEmitR.emitParticleAt(feetX + Math.random() * 6, groundY, 1);
          }
        }
        // Jump from ground: sideways puff at feet — bursts left + right
        if (wasGrounded && !cp.grounded && cp.jumpsLeft < prevJumps! && this.dustGroundEmitL && this.dustGroundEmitR) {
          for (let p = 0; p < 4; p++) {
            this.dustGroundEmitL.emitParticleAt(feetX - Math.random() * 4, feetY, 1);
            this.dustGroundEmitR.emitParticleAt(feetX + Math.random() * 4, feetY, 1);
          }
        }
        // Double jump in air: cloud arc below character
        if (!wasGrounded && !cp.grounded && cp.jumpsLeft < prevJumps! && cp.vy < 0 && this.dustEmitter) {
          for (let p = 0; p < 12; p++) {
            this.dustEmitter.emitParticleAt(feetX + (Math.random() - 0.5) * 24, feetY - 4, 1);
          }
        }

        this.prevPlayerGrounded[i] = cp.grounded;
        this.prevPlayerJumpsLeft[i] = cp.jumpsLeft;
      }

      this.drawPlayerOverlays(g, cp, drawX, drawY, i, predicted, curr);
    }

    // Update prevFrameButtons for next frame's edge detection
    for (let i = 0; i < 2; i++) {
      const cp = playerStates[i];
      if (!cp) continue;
      const isLocal =
        (i === this.localPlayerId && !this.replayMode) || ((this.warmupMode || this.tutorialMode) && i === 0);
      const btns = isLocal ? this.inputManager.getPlayer1Input(cp.x, cp.y).buttons : this.lastReceivedButtons[i];
      this.prevFrameButtons[i] = btns ?? 0;
    }
  }

  private drawPlayerOverlays(
    g: Phaser.GameObjects.Graphics,
    cp: SerializedPlayer,
    drawX: number,
    drawY: number,
    index: number,
    predicted: GameStateData | null,
    curr: GameStateData,
  ) {
    // Stomped victims draw bars on high-depth overlay so they render above rider sprite
    const barGfx = cp.stompedBy !== null && cp.stompedBy >= 0 ? this.gfxOverlay : g;

    // Health bar with black stroke
    const barY = drawY - 3;
    const healthPct = cp.health / 100;
    barGfx.fillStyle(0x000000);
    barGfx.fillRect(drawX - 1, barY - 1, PLAYER_WIDTH + 2, 6);
    barGfx.fillStyle(0x333333);
    barGfx.fillRect(drawX, barY, PLAYER_WIDTH, 4);
    barGfx.fillStyle(healthPct > 0.5 ? 0x66bb6a : healthPct > 0.25 ? 0xffa726 : 0xef5350);
    barGfx.fillRect(drawX, barY, PLAYER_WIDTH * healthPct, 4);

    // "Shake him off!" alert + progress bar below stomped player
    const alertText = this.stompAlertTexts[index];
    const shakeBarBelow = drawY + PLAYER_HEIGHT + 2;
    if (cp.stompedBy !== null && cp.stompedBy >= 0 && cp.stompShakeProgress > 0) {
      const shakePct = cp.stompShakeProgress / 100;
      barGfx.fillStyle(0x000000);
      barGfx.fillRect(drawX - 1, shakeBarBelow - 1, PLAYER_WIDTH + 2, 5);
      barGfx.fillStyle(0x444444);
      barGfx.fillRect(drawX, shakeBarBelow, PLAYER_WIDTH, 3);
      barGfx.fillStyle(0xffee58);
      barGfx.fillRect(drawX, shakeBarBelow, PLAYER_WIDTH * shakePct, 3);
    }
    if (alertText) {
      const alertY =
        cp.stompedBy !== null && cp.stompedBy >= 0 && cp.stompShakeProgress > 0
          ? shakeBarBelow + 6
          : drawY + PLAYER_HEIGHT + 2;
      alertText.setPosition(drawX + PLAYER_WIDTH / 2, alertY);
      if (cp.stompedBy !== null && cp.stompedBy >= 0) {
        const pulse = Math.sin((predicted?.tick ?? curr.tick) * 0.2) * 0.3 + 0.7;
        alertText.setAlpha(pulse);
      } else {
        alertText.setAlpha(0);
      }
    }

    // Username above player
    const nameText = this.nameTexts[index];
    if (!nameText) return;
    const uname = this.playerUsernames[index];
    if (uname) {
      nameText.setText(uname);
      nameText.setPosition(drawX + PLAYER_WIDTH / 2, drawY - 6);
      nameText.setVisible(true);
    } else {
      nameText.setVisible(false);
    }
  }

  private drawProjectiles(
    g: Phaser.GameObjects.Graphics,
    curr: GameStateData,
    predicted: GameStateData | null,
    _delta: number,
  ) {
    // Local player's bullets from predicted state (instant feedback).
    // Remote player's bullets from server state (matches their rendered position).
    const localId = this.localPlayerId;
    const projectiles: { proj: SerializedProjectile; ownerState: GameStateData }[] = [];

    if (predicted && !this.replayMode) {
      for (const p of predicted.projectiles) {
        if (p.ownerId === localId) projectiles.push({ proj: p, ownerState: predicted });
      }
      for (const p of curr.projectiles) {
        if (p.ownerId !== localId) projectiles.push({ proj: p, ownerState: curr });
      }
    } else {
      for (const p of curr.projectiles) projectiles.push({ proj: p, ownerState: curr });
    }

    for (const { proj: p, ownerState } of projectiles) {
      let px = p.x;
      const gcfg = GUN_CONFIG[p.weapon];
      // Consistent Y offset: shift to gun height on every frame (avoids vertical jump)
      const yOff = gcfg ? gcfg.offsetY + gcfg.muzzleY * gcfg.scale : 0;

      // First frame only: snap X to muzzle position (forward motion masks the transition)
      const maxLife = WEAPON_STATS[p.weapon as WeaponType]?.lifetime ?? 90;
      if (p.lifetime >= maxLife - 1 && gcfg) {
        const owner = ownerState.players.find((pl) => pl.id === p.ownerId);
        if (owner) {
          // When wall sliding, gun points away from wall (same logic as gun sprite)
          const fdir = owner.wallSliding ? -(owner.facing as number) : (owner.facing as number);
          px = owner.x + PLAYER_WIDTH / 2 + fdir * (gcfg.offsetX + gcfg.muzzleX * gcfg.scale);
        }
      }

      const py = p.y + yOff;
      // Per-weapon bullet size (w × h)
      let bw: number, bh: number;
      switch (p.weapon) {
        case WeaponType.Pistol:
          bw = 3;
          bh = 2;
          break;
        case WeaponType.SMG:
          bw = 3;
          bh = 2;
          break;
        case WeaponType.Shotgun:
          bw = 4;
          bh = 2;
          break;
        case WeaponType.Sniper:
          bw = 6;
          bh = 2;
          break;
        case WeaponType.Rocket:
          bw = 6;
          bh = 4;
          break;
        default:
          bw = 3;
          bh = 2;
          break;
      }
      // Black shadow behind white rectangular bullet
      g.fillStyle(0x000000, 0.6);
      g.fillRect(px - bw / 2 - 1, py - bh / 2 - 1, bw + 2, bh + 2);
      g.fillStyle(0xffffff);
      g.fillRect(px - bw / 2, py - bh / 2, bw, bh);
    }
  }

  private drawExplosions(g: Phaser.GameObjects.Graphics) {
    this.explosions = this.explosions.filter((e) => {
      e.timer--;
      if (e.timer <= 0) return false;
      const alpha = e.timer / 15;
      const radius = 40 * (1 - alpha * 0.5);
      g.fillStyle(0xff6600, alpha * 0.6);
      g.fillCircle(e.x, e.y, radius);
      g.fillStyle(0xffcc00, alpha * 0.4);
      g.fillCircle(e.x, e.y, radius * 0.5);
      return true;
    });
  }

  private drawHUD(curr: GameStateData, displayState: GameStateData, _predicted: GameStateData | null) {
    // Warmup/tutorial mode — hide all game HUD
    if (this.warmupMode || this.tutorialMode) {
      this.timerText.setText("");
      document.getElementById("sudden-death-overlay")?.classList.remove("visible");
      this.roundText.setVisible(false);
      const wh = document.getElementById("weapon-hud");
      if (wh) wh.style.display = "none";
      return;
    }

    // Timer
    const ticksRemaining = (this.config?.matchDurationTicks ?? MATCH_DURATION_TICKS) - displayState.tick;
    const secondsRemaining = Math.max(0, Math.ceil(ticksRemaining / TICK_RATE));
    this.timerText.setText(`${secondsRemaining}s`);

    // Sudden death countdown + text (DOM overlay for guaranteed visibility)
    const sdTick = this.config?.suddenDeathStartTick ?? SUDDEN_DEATH_START_TICK;
    const ticksUntilSD = sdTick - displayState.tick;
    const inSuddenDeath = displayState.tick >= sdTick;
    const sdOverlay = document.getElementById("sudden-death-overlay");
    const sdText = document.getElementById("sudden-death-text");
    if (sdOverlay && sdText) {
      if (!this.playing) {
        sdOverlay.classList.remove("visible");
      } else if (inSuddenDeath) {
        sdText.textContent = "SUDDEN DEATH";
        sdText.style.fontSize = "16px";
        sdOverlay.classList.add("visible");
      } else if (ticksUntilSD <= 180 && ticksUntilSD > 0) {
        const countNum = Math.ceil(ticksUntilSD / 60);
        sdText.textContent = `SUDDEN DEATH IN ${countNum}`;
        sdText.style.fontSize = "20px";
        sdOverlay.classList.add("visible");
      } else {
        sdOverlay.classList.remove("visible");
      }
    }

    // Round info
    if (!this.replayMode) {
      this.roundText.setText(
        `R${this.currentRound + 1}/${this.totalRounds}  ${this.roundWins[0]}-${this.roundWins[1]}`,
      );
      this.roundText.setVisible(true);
    } else {
      this.roundText.setVisible(false);
    }

    // Weapon + ammo (DOM overlay for guaranteed visibility)
    const weaponHud = document.getElementById("weapon-hud");
    const weaponHudText = document.getElementById("weapon-hud-text");
    if (weaponHud && weaponHudText) {
      const localP = displayState.players[this.localPlayerId];
      if (localP && localP.weapon !== null && localP.weapon >= 0) {
        const names = ["PISTOL", "SHOTGUN", "SNIPER", "ROCKET", "SMG"];
        weaponHudText.textContent = `${names[localP.weapon] ?? "?"} ${localP.ammo}`;
        weaponHud.style.display = "block";
      } else {
        weaponHud.style.display = "none";
      }
    }

    // Stomp alert alpha reset (drawPlayerOverlays sets alpha when active)

    // Replay controls
    if (this.replayMode) {
      const status = this.replayPaused ? "PAUSED" : "PLAYING";
      this.replayInfoText.setText(`REPLAY ${status} ${this.replaySpeed}x | Space: Pause | Up/Down: Speed | Esc: Exit`);
    }
  }

}
