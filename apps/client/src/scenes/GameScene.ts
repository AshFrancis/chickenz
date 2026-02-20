import Phaser from "phaser";
import {
  ARENA,
  MAP_POOL,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  PROJECTILE_RADIUS,
  INITIAL_LIVES,
  MATCH_DURATION_TICKS,
  SUDDEN_DEATH_START_TICK,
  TICK_RATE,
  TICK_DT_MS,
  MAX_JUMPS,
  WEAPON_STATS,
  Button,
  PlayerStateFlag,
  WeaponType,
  Facing,
  createInitialState,
  step,
  NULL_INPUT,
} from "@chickenz/sim";
import type { GameState, GameMap, MatchConfig, PlayerInput, PlayerState, WeaponPickup, InputMap } from "@chickenz/sim";
import { InputManager } from "../input/InputManager";
import { PredictionManager } from "../net/PredictionManager";
import { DPR, VIEW_W, VIEW_H } from "../game";
import { playSFX } from "../audio/sfx";

interface TranscriptInput {
  buttons: number;
  aimX?: number;
  aimY?: number;
  aim_x?: number;
  aim_y?: number;
}

type TickInputPair = [TranscriptInput, TranscriptInput];

const PLAYER_COLORS = [0x4fc3f7, 0xef5350]; // blue, red
const WALL_COLOR = 0xff0000;

// ── Terrain tileset constants ──────────────────────────────────────────────
const TERRAIN_COLS = 22; // tiles per row in terrain spritesheet
const GRASS_TERRAIN = { col: 6, row: 0 }; // green grass 9-slice: TL=(6,0) T=(7,0) TR=(8,0)
const THIN_PLATFORM = { col: 12, row: 0 }; // thin platform tiles: L=(12,0) M=(13,0) R=(14,0)

// ── Character sprite constants ───────────────────────────────────────────
const CHARACTER_SLUGS = ["ninja-frog", "mask-dude", "pink-man", "virtual-guy"] as const;
// Weapon sprite texture keys, indexed by WeaponType
const GUN_TEXTURES: Record<number, string> = {
  [WeaponType.Pistol]: "gun-pistol",
  [WeaponType.Shotgun]: "gun-shotgun",
  [WeaponType.Sniper]: "gun-sniper",
  [WeaponType.Rocket]: "gun-rocket",
  [WeaponType.SMG]: "gun-smg",
};

// Per-gun visual config: position offset, scale, muzzle (shot origin), bob
interface GunConfig {
  offsetX: number;   // from character center, before facing flip
  offsetY: number;
  scale: number;
  muzzleX: number;   // from gun center, before facing flip (scaled)
  muzzleY: number;
  bobAmplitude: number; // max pixels of vertical bob (synced to anim frames)
}

const GUN_CONFIG: Record<number, GunConfig> = {
  [WeaponType.Pistol]:  { offsetX: 14, offsetY: 6.5, scale: 0.5, muzzleX: 13.5, muzzleY: -5, bobAmplitude: 0.6 },
  [WeaponType.Shotgun]: { offsetX: 4.5, offsetY: 11.5, scale: 0.5, muzzleX: 29, muzzleY: -3, bobAmplitude: 0.9 },
  [WeaponType.Sniper]:  { offsetX: 7, offsetY: 8.5, scale: 0.5, muzzleX: 27, muzzleY: -2, bobAmplitude: 0.6 },
  [WeaponType.Rocket]:  { offsetX: 5, offsetY: 8, scale: 0.5, muzzleX: 23.5, muzzleY: 0, bobAmplitude: 1 },
  [WeaponType.SMG]:     { offsetX: 11.5, offsetY: 6.5, scale: 0.5, muzzleX: 14, muzzleY: -4.5, bobAmplitude: 1 },
};

const CHARACTER_ANIMS = [
  { key: "idle", frames: 11, repeat: -1, rate: 20 },
  { key: "run", frames: 12, repeat: -1, rate: 20 },
  { key: "jump", frames: 1, repeat: 0, rate: 20 },
  { key: "double-jump", frames: 6, repeat: 0, rate: 20 },
  { key: "fall", frames: 1, repeat: 0, rate: 20 },
  { key: "hit", frames: 7, repeat: 0, rate: 20 },
  { key: "wall-jump", frames: 5, repeat: -1, rate: 20 },
] as const;

// Per-character crouch/taunt sound, indexed by CHARACTER_SLUGS
const CROUCH_SOUNDS: Record<string, string> = {
  "ninja-frog": "frog-croak",
  "mask-dude": "ooga",
  "pink-man": "wub",
  "virtual-guy": "pop",
};

/** Compute the spritesheet frame index for a tile at (tx,ty) in a platform grid. */
function getTerrainFrame(tx: number, ty: number, tilesW: number, tilesH: number): number {
  let cx: number, cy: number;

  // Single-height platforms use dedicated thin platform tiles
  if (tilesH === 1) {
    const p = THIN_PLATFORM;
    cx = tx === 0 ? 0 : tx === tilesW - 1 ? 2 : 1;
    return p.row * TERRAIN_COLS + (p.col + cx);
  }
  // Multi-height platforms use green grass 9-slice
  const t = GRASS_TERRAIN;
  cx = tx === 0 ? 0 : tx === tilesW - 1 ? 2 : 1;
  cy = ty === 0 ? 0 : ty === tilesH - 1 ? 2 : 1;
  return (t.row + cy) * TERRAIN_COLS + (t.col + cx);
}

const WEAPON_PROJECTILE_COLORS: Record<number, number> = {
  [WeaponType.Pistol]: 0xffee58,
  [WeaponType.Shotgun]: 0xff9800,
  [WeaponType.Sniper]: 0x00e5ff,
  [WeaponType.Rocket]: 0xff1744,
  [WeaponType.SMG]: 0x76ff03,
};

const WEAPON_PICKUP_COLORS: Record<number, number> = {
  [WeaponType.Pistol]: 0xfdd835,
  [WeaponType.Shotgun]: 0xfb8c00,
  [WeaponType.Sniper]: 0x00b8d4,
  [WeaponType.Rocket]: 0xd50000,
  [WeaponType.SMG]: 0x64dd17,
};

const WEAPON_NAMES: Record<number, string> = {
  [WeaponType.Pistol]: "PISTOL",
  [WeaponType.Shotgun]: "SHOTGUN",
  [WeaponType.Sniper]: "SNIPER",
  [WeaponType.Rocket]: "ROCKET",
  [WeaponType.SMG]: "SMG",
};

const BG_KEYS = ["bg-blue", "bg-brown", "bg-gray", "bg-green", "bg-pink", "bg-purple", "bg-yellow"];
const PIXEL_FONT = '"Silkscreen", monospace';

const announceEl = document.getElementById("announce-text")!;
const announceOverlay = document.getElementById("announce-overlay")!;

function showAnnounce(text: string) {
  announceEl.textContent = text;
  announceOverlay.classList.add("visible");
}
function hideAnnounce() {
  announceOverlay.classList.remove("visible");
  announceEl.textContent = "";
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent smoothing: factor is the convergence rate at 60fps (16.667ms). */
function smoothLerp(a: number, b: number, factor: number, dt: number): number {
  return a + (b - a) * (1 - Math.pow(1 - factor, dt / 16.667));
}

export class GameScene extends Phaser.Scene {
  private prevState: GameState | null = null;
  private currState: GameState | null = null;
  private config!: MatchConfig;
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
  private weaponText!: Phaser.GameObjects.Text;
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

  // Smooth render positions (per-frame lerp absorbs prediction/reconciliation snaps)
  private localSmooth: { x: number; y: number; initialized: boolean } = { x: 0, y: 0, initialized: false };
  private remoteSmooth: { x: number; y: number; initialized: boolean } = { x: 0, y: 0, initialized: false };

  // Camera
  private currentZoom = 1.0;
  private cameraX = 480;
  private cameraY = 270;
  private hudCamera!: Phaser.Cameras.Scene2D.Camera;

  // Netcode: tick ordering
  private lastServerTick = 0;

  // Audio
  private _muted = false;
  private bgm: Phaser.Sound.BaseSound | null = null;
  private audioLoaded = false;
  private bgmVolume = 0.1;
  private sfxVolume = 0.8;
  private lastBgmTrack = 0;

  // Display settings
  private dynamicZoom = true;

  // Warmup mode (waiting room with jumping)
  private warmupMode = false;
  private warmupState: GameState | null = null;
  private warmupConfig: MatchConfig | null = null;
  private warmupPrevInputs: InputMap = new Map();
  private warmupAccum = 0;
  private warmupJoinCode = "";
  // Warmup overlay is DOM-based (see index.html #warmup-overlay)

  // Diamond transition
  private transitionActive = false;

  // Stomp alert texts (one per player, like nameTexts)
  private stompAlertTexts: Phaser.GameObjects.Text[] = [];

  // Button tracking for crouch animation (per player)
  private lastReceivedButtons: [number, number] = [0, 0];
  private prevFrameButtons: [number, number] = [0, 0];

  // Scene lifecycle — create() may not have run yet when network callbacks fire
  private sceneReady = false;
  private readyQueue: (() => void)[] = [];

  // Replay mode
  private replayMode = false;
  private replayTranscript: TickInputPair[] = [];
  private replayTick = 0;
  private replayPaused = false;
  private replaySpeed = 1;
  private replayAccum = 0;
  private replayPrevInputs: InputMap = new Map();
  private replayInfoText!: Phaser.GameObjects.Text;
  private roundText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: "GameScene" });
  }

  preload() {
    // Load BGM tracks (SFX use Web Audio synth fallback, no MP3s needed)
    try {
      for (let i = 1; i <= 5; i++) {
        this.load.audio(`bgm-${i}`, `/audio/bgm-${i}.mp3`);
      }
    } catch {
      // Audio files may not exist yet
    }
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
        this.load.spritesheet(
          `${slug}-${anim.key}`,
          `/sprites/characters/${slug}-${anim.key}.png`,
          { frameWidth: 32, frameHeight: 32 },
        );
      }
    }

    this.load.on("complete", () => {
      this.audioLoaded = true;
      // Try to start BGM now that audio is loaded (requires prior user gesture)
      this.startBGM();
    });

    // Load persisted settings
    const storedBGM = localStorage.getItem("chickenz-bgm-volume");
    if (storedBGM !== null) this.bgmVolume = parseInt(storedBGM, 10) / 100;
    const storedSFX = localStorage.getItem("chickenz-sfx-volume");
    if (storedSFX !== null) this.sfxVolume = parseInt(storedSFX, 10) / 100;
    const storedZoom = localStorage.getItem("chickenz-dynamic-zoom");
    if (storedZoom !== null) this.dynamicZoom = storedZoom !== "false";
  }

  create() {
    this.gfx = this.add.graphics();
    this.gfxOverlay = this.add.graphics();

    // Warm up font: create a hidden text to force Phaser to rasterize the font atlas
    const warmFont = this.add.text(-100, -100, "ABCabc123", {
      fontFamily: PIXEL_FONT, fontSize: "16px",
    }).setResolution(DPR).setVisible(false);
    this.time.delayedCall(100, () => warmFont.destroy());

    // JIT warmup: run ~300 silent sim ticks so V8 optimizes step() before any match
    {
      const warmCfg: MatchConfig = {
        seed: 1, map: ARENA, playerCount: 2, tickRate: TICK_RATE,
        initialLives: INITIAL_LIVES, matchDurationTicks: MATCH_DURATION_TICKS,
        suddenDeathStartTick: SUDDEN_DEATH_START_TICK,
      };
      let ws = createInitialState(warmCfg);
      let prevInputs: InputMap = new Map();
      const dummyInputs: InputMap = new Map([[0, NULL_INPUT], [1, NULL_INPUT]]);
      for (let t = 0; t < 300; t++) {
        ws = step(ws, dummyInputs, prevInputs, warmCfg);
        prevInputs = dummyInputs;
      }
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

    this.controlsText = this.add.text(10, VIEW_H - 25, "", {
      fontSize: "8px",
      color: "#888888",
      fontFamily: PIXEL_FONT,
    }).setResolution(DPR).setDepth(100);

    this.weaponText = this.add.text(VIEW_W / 2, VIEW_H - 20, "", {
      fontSize: "8px",
      color: "#ffffff",
      fontFamily: PIXEL_FONT,
      align: "center",
    }).setOrigin(0.5, 1).setResolution(DPR).setDepth(100);

    // Player name texts (rendered on main camera, move with players)
    for (let i = 0; i < 2; i++) {
      const text = this.add.text(0, 0, "", {
        fontSize: "10px",
        color: "#ffffff",
        fontFamily: PIXEL_FONT,
        align: "center",
      }).setOrigin(0.5, 1).setResolution(DPR).setDepth(50)
        .setShadow(1, 1, "#000000", 0);
      this.nameTexts.push(text);
    }

    // Stomp alert texts (one per player, world-space below player)
    for (let i = 0; i < 2; i++) {
      const alertText = this.add.text(0, 0, "SHAKE HIM OFF!", {
        fontSize: "7px",
        color: "#ffffff",
        fontFamily: PIXEL_FONT,
        align: "center",
        stroke: "#000000",
        strokeThickness: 2,
      }).setOrigin(0.5, 0).setDepth(50).setResolution(DPR).setAlpha(0);
      this.stompAlertTexts.push(alertText);
    }

    // Round indicator (top-left)
    this.roundText = this.add.text(10, 10, "", {
      fontSize: "8px",
      color: "#ffffff",
      fontFamily: PIXEL_FONT,
    }).setResolution(DPR).setDepth(100);

    // Replay info text
    this.replayInfoText = this.add.text(VIEW_W / 2, VIEW_H - 10, "", {
      fontSize: "8px",
      color: "#ffee58",
      fontFamily: PIXEL_FONT,
      align: "center",
    }).setOrigin(0.5, 1).setResolution(DPR).setDepth(100).setVisible(false);

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
    this.hudCamera = this.cameras.add(0, 0, Math.round(VIEW_W * DPR), Math.round(VIEW_H * DPR));
    this.hudCamera.setScroll(0, 0);
    this.hudCamera.setZoom(DPR);

    // Collect HUD elements (rendered only on hudCamera)
    const hudElements = [this.timerText, this.suddenDeathText, this.controlsText, this.weaponText, this.roundText, this.replayInfoText];
    // stompAlertTexts are world-space (not HUD) — HUD camera should ignore them
    for (const at of this.stompAlertTexts) this.hudCamera.ignore(at);

    // Main camera ignores HUD texts
    for (const el of hudElements) {
      this.cameras.main.ignore(el);
    }

    // HUD camera ignores game graphics and name texts
    this.hudCamera.ignore(this.gfx);
    this.hudCamera.ignore(this.gfxOverlay);
    for (const nt of this.nameTexts) {
      this.hudCamera.ignore(nt);
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
      const sprite = this.add.sprite(0, 0, `${slug}-idle`)
        .setDepth(20)
        .setVisible(false);
      this.hudCamera.ignore(sprite);
      this.playerSprites.push(sprite);

      // Gun sprite (rendered on top of character, scale set per-weapon in drawPlayers)
      const gun = this.add.image(0, 0, "gun-pistol")
        .setDepth(21)
        .setVisible(false);
      this.hudCamera.ignore(gun);
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
    this.hudCamera.ignore(this.dustEmitter);

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
    this.hudCamera.ignore(this.dustGroundEmitL);

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
    this.hudCamera.ignore(this.dustGroundEmitR);

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
    this.hudCamera.ignore(this.pickupGlowEmitter);

    // Disable Phaser's default audio pause-on-blur (abrupt stop/start).
    // We handle it manually with a fade below.
    this.sound.pauseOnBlur = false;

    // Fade BGM out/in on window/tab focus change instead of abrupt pause
    const fadeOut = () => {
      if (!this.bgm || !this.bgm.isPlaying) return;
      this.fadeVolume(this.bgm as Phaser.Sound.WebAudioSound, (this.bgm as Phaser.Sound.WebAudioSound).volume, 0, 400);
    };
    const fadeIn = () => {
      if (!this.bgm) return;
      const ctx = (this.sound as Phaser.Sound.WebAudioSoundManager).context;
      if (ctx.state === "suspended") ctx.resume();
      this.fadeVolume(this.bgm as Phaser.Sound.WebAudioSound, 0, this.bgmVolume, 400);
    };
    // visibilitychange fires on tab switch; blur/focus fires on window switch
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) fadeOut(); else fadeIn();
    });
    window.addEventListener("blur", fadeOut);
    window.addEventListener("focus", fadeIn);

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
      console.log(`[startWarmup] deferred — scene not ready yet`);
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
    this.warmupPrevInputs = new Map();

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
    this.warmupState = createInitialState(this.warmupConfig);
    // Banish player 2 off-screen so they don't absorb bullets or affect camera
    this.banishWarmupPlayer2(this.warmupState);
    this.currState = this.warmupState;
    this.prevState = this.warmupState;
    this.config = this.warmupConfig;
    this.localPlayerId = 0;
    this.playing = false; // not a real match
    this.prediction = null;
    hideAnnounce();
    document.getElementById("sudden-death-overlay")?.classList.remove("visible");
    this.currentZoom = 1.0;
    this.cameraX = 480;
    this.cameraY = 270;
    this.localSmooth = { x: 0, y: 0, initialized: false };
    this.remoteSmooth = { x: 0, y: 0, initialized: false };
    this.explosions = [];

    const warmupEl = document.getElementById("warmup-overlay");
    const codeEl = document.getElementById("warmup-code");
    if (codeEl) codeEl.textContent = joinCode;
    warmupEl?.classList.add("visible");
    this.roundText?.setVisible(false);
    this.replayInfoText?.setVisible(false);
  }

  get isWarmup(): boolean {
    return this.warmupMode;
  }

  get isPlaying(): boolean {
    return this.playing && !this.warmupMode;
  }

  /** Move player 2 far off-screen so they can't absorb bullets or affect camera. */
  private banishWarmupPlayer2(state: GameState) {
    const p1 = state.players[1] as { x: number; y: number; vx: number; vy: number } | undefined;
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
    document.getElementById("warmup-overlay")?.classList.remove("visible");
  }

  startOnlineMatch(playerId: number, seed: number, usernames?: [string, string], mapIndex: number = 0, totalRounds: number = 3, characters?: [number, number]) {
    if (!this.sceneReady) {
      console.log(`[startOnlineMatch] deferred — scene not ready yet`);
      this.onReady(() => this.startOnlineMatch(playerId, seed, usernames, mapIndex, totalRounds, characters));
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

    // Diamond transition covers screen, THEN swap map at midpoint (fully black)
    // Keep warmupMode alive during grow-in so camera stays stable (P2 is at -9999)
    this.playing = false;
    this.playTransition(() => {
      this.warmupMode = false;
      this.warmupState = null;
      document.getElementById("warmup-overlay")?.classList.remove("visible");
      this.initRound(seed, mapIndex);
      this.showCountdown(() => {
        this.predictionAccum = 0;
        this.playing = true;
        this.showRoundPopup(1);
        this.playSound("match-start");
      });
    });

    this.startBGM();
  }

  /** Start a new round with the given seed and map. */
  startNewRound(seed: number, mapIndex: number, round: number) {
    this.currentRound = round;
    this.roundTransition = false;

    // Transition covers screen, swap map at midpoint (fully black), then reveal
    this.playTransition(() => {
      this.initRound(seed, mapIndex);
      this.showRoundPopup(round + 1);
      this.playSound("match-start");
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
  private playTransition(onMidpoint: () => void) {
    if (this.transitionActive) { onMidpoint(); return; }
    this.transitionActive = true;

    const overlay = document.getElementById("transition-overlay");
    if (!overlay) { onMidpoint(); this.transitionActive = false; return; }
    const cells = overlay.querySelectorAll<HTMLElement>(".t-cell");

    const { TRANS_COLS: cols, TRANS_WAVE_DELAY: WAVE_DELAY,
            TRANS_GROW_MS: GROW_MS, TRANS_HOLD_MS: HOLD_MS, TRANS_SHRINK_MS: SHRINK_MS } = GameScene;

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

  private initRound(seed: number, mapIndex: number) {
    const map = MAP_POOL[mapIndex] ?? MAP_POOL[0] ?? ARENA;
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
    const initial = createInitialState(this.config);
    this.prevState = initial;
    this.currState = initial;
    this.playing = true;
    hideAnnounce();
    document.getElementById("sudden-death-overlay")?.classList.remove("visible");
    this.explosions = [];
    this.prediction = new PredictionManager(initial, this.config, this.localPlayerId);
    this.predictionAccum = 0;
    // Snap camera to midpoint between both players so they're visible immediately
    const p0 = initial.players[0];
    const p1 = initial.players[1];
    if (p0 && p1) {
      this.cameraX = (p0.x + p1.x) / 2 + PLAYER_WIDTH / 2;
      this.cameraY = (p0.y + p1.y) / 2 + PLAYER_HEIGHT / 2;
      // Start at correct zoom for narrow viewports
      const PAD = 80;
      const needW = Math.abs(p0.x - p1.x) + PLAYER_WIDTH + PAD * 2;
      const needH = Math.abs(p0.y - p1.y) + PLAYER_HEIGHT + PAD * 2;
      const fitZoom = Math.min(VIEW_W / needW, VIEW_H / needH);
      this.currentZoom = Math.min(1.0, fitZoom);
    } else if (p0) {
      this.cameraX = p0.x + PLAYER_WIDTH / 2;
      this.cameraY = p0.y + PLAYER_HEIGHT / 2;
      this.currentZoom = 1.0;
    } else {
      this.cameraX = 480;
      this.cameraY = 270;
      this.currentZoom = 1.0;
    }
    this.localSmooth = { x: 0, y: 0, initialized: false };
    this.remoteSmooth = { x: 0, y: 0, initialized: false };
    this.lastServerTick = 0;
  }

  /** Create tile sprites for all platforms in the map using 9-slice terrain tiles. */
  private createMapTiles(map: GameMap, seed: number) {
    if (!this.hudCamera) console.warn(`[createMapTiles] hudCamera not set — tiles will render on both cameras!`);
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
    const angle = ((h >>> 8) & 0xffff) / 0xffff * Math.PI * 2;
    this.bgScrollX = Math.cos(angle) * 0.3;
    this.bgScrollY = Math.sin(angle) * 0.3;

    // Create/update background tileSprite clipped to arena bounds
    if (this.bgTile) this.bgTile.destroy();
    this.bgTile = this.add.tileSprite(
      map.width / 2, map.height / 2,
      map.width, map.height,
      bgKey,
    ).setDepth(-100);
    this.hudCamera?.ignore(this.bgTile);

    for (const plat of map.platforms) {
      const tilesW = Math.max(1, Math.round(plat.width / 16));
      const tilesH = Math.max(1, Math.round(plat.height / 16));
      for (let ty = 0; ty < tilesH; ty++) {
        for (let tx = 0; tx < tilesW; tx++) {
          const frame = getTerrainFrame(tx, ty, tilesW, tilesH);
          const img = this.add.image(
            plat.x + tx * 16 + 8, // center of tile
            plat.y + ty * 16 + 8,
            "terrain",
            frame,
          ).setDepth(0);
          this.hudCamera?.ignore(img);
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
        if (plat.y > sp.y && plat.y < platformTop &&
            sp.x >= plat.x && sp.x <= plat.x + plat.width) {
          platformTop = plat.y;
        }
      }
      // Place tile so visual (top 3px of frame) rests on platform: center = platformTop + 5
      const tileY = platformTop + 5;
      for (let i = 0; i < 3; i++) {
        const img = this.add.image(
          sp.x + (i - 1) * 16,
          tileY,
          "terrain",
          PEDESTAL_FRAMES[i]!,
        ).setDepth(0);
        this.hudCamera?.ignore(img);
        this.platformTiles.push(img);
      }
    }

    // Border tiles around arena using dark stone 9-slice (cols 0-2, rows 0-2)
    const TC = TERRAIN_COLS; // 22 tiles per row
    const B_TL = 3, B_T = 2 * TC + 1, B_TR = 4;
    const B_ML = TC + 2, B_MR = TC;
    const B_BL = TC + 3, B_B = 1, B_BR = TC + 4;
    const mw = map.width, mh = map.height;
    const tilesX = Math.ceil(mw / 16);
    const tilesY = Math.ceil(mh / 16);

    const addBorder = (x: number, y: number, frame: number) => {
      const img = this.add.image(x, y, "terrain", frame).setDepth(1);
      this.hudCamera?.ignore(img);
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

  startReplay(transcript: TickInputPair[], seed: number) {
    if (!this.sceneReady) {
      this.onReady(() => this.startReplay(transcript, seed));
      return;
    }
    this.assignCharacters();
    this.replayMode = true;
    this.replayTranscript = transcript;
    this.replayTick = 0;
    this.replayPaused = false;
    this.replaySpeed = 1;
    this.replayAccum = 0;
    this.replayPrevInputs = new Map();
    this.localPlayerId = 0;
    this.playerUsernames = ["P1", "P2"];
    this.prediction = null;

    this.createMapTiles(ARENA, seed);
    this.config = {
      seed,
      map: ARENA,
      playerCount: 2,
      tickRate: TICK_RATE,
      initialLives: INITIAL_LIVES,
      matchDurationTicks: MATCH_DURATION_TICKS,
      suddenDeathStartTick: SUDDEN_DEATH_START_TICK,
    };
    const initial = createInitialState(this.config);
    this.prevState = initial;
    this.currState = initial;
    this.playing = true;
    hideAnnounce();
    document.getElementById("sudden-death-overlay")?.classList.remove("visible");
    this.explosions = [];
    this.currentZoom = 1.0;
    this.cameraX = 480;
    this.cameraY = 270;
    this.localSmooth = { x: 0, y: 0, initialized: false };
    this.remoteSmooth = { x: 0, y: 0, initialized: false };
    this.replayInfoText.setVisible(true);

    // Remove previous replay listeners to prevent stacking
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

  private exitReplay() {
    this.replayMode = false;
    this.playing = false;
    this.replayInfoText.setVisible(false);
    hideAnnounce();
    this.input.keyboard?.removeAllListeners();
    // Return to lobby (dispatch event to main.ts)
    window.dispatchEvent(new CustomEvent("replayEnded"));
  }

  receiveState(state: GameState, lastButtons?: [number, number]) {
    // Drop out-of-order packets — prevents old states from overwriting newer ones
    if (state.tick <= this.lastServerTick) return;
    this.lastServerTick = state.tick;

    // Track button state for crouch animation
    if (lastButtons) {
      this.lastReceivedButtons = [...lastButtons] as [number, number];
    }

    // Detect events for audio
    if (this.currState) {
      this.detectAudioEvents(this.currState, state);
    }

    this.prevState = this.currState;
    this.currState = state;

    // Feed server state to prediction manager for reconciliation
    if (this.prediction) {
      this.prediction.applyServerState(state, state.tick, lastButtons);
    }
  }

  endOnlineMatch(winner: number) {
    this.playing = false;
    document.getElementById("sudden-death-overlay")?.classList.remove("visible");
    if (winner === -1) {
      showAnnounce("DRAW!");
    } else {
      const name = this.playerUsernames[winner]?.toUpperCase();
      showAnnounce(name ? `${name} wins!` : `Player ${winner + 1} wins!`);
    }
    this.playSound("match-end");
    // Music keeps playing between matches — no stopBGM()
  }

  setMuted(muted: boolean) {
    this._muted = muted;
    if (muted) {
      if (this.bgm?.isPlaying) this.bgm.pause();
    } else {
      if (this.bgm && !this.bgm.isPlaying) {
        this.bgm.resume();
      } else if (!this.bgm || !this.bgm.isPlaying) {
        this.startBGM();
      }
    }
  }

  setBGMVolume(vol: number) {
    this.bgmVolume = vol;
    if (this.bgm && "volume" in this.bgm) {
      (this.bgm as Phaser.Sound.WebAudioSound).volume = vol;
    }
  }

  setSFXVolume(vol: number) {
    this.sfxVolume = vol;
  }

  setDynamicZoom(enabled: boolean) {
    this.dynamicZoom = enabled;
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
    this.weaponText.setPosition(VIEW_W / 2, VIEW_H - 20).setResolution(DPR);
    this.roundText.setResolution(DPR);
    this.replayInfoText.setPosition(VIEW_W / 2, VIEW_H - 10).setResolution(DPR);
    // Update main camera bounds and zoom
    const mapW = this.config?.map?.width ?? 960;
    const mapH = this.config?.map?.height ?? 540;
    const padX = VIEW_W / 2;
    const padY = VIEW_H / 2;
    this.cameras.main.setBounds(-padX, -padY, mapW + padX * 2, mapH + padY * 2);
    this.cameras.main.setZoom(this.currentZoom * DPR);

    // Update HUD camera viewport and zoom
    if (this.hudCamera) {
      this.hudCamera.setSize(Math.round(VIEW_W * DPR), Math.round(VIEW_H * DPR));
      this.hudCamera.setZoom(DPR);
    }

    // bgTile is arena-sized (clipped to border), no resize needed
  }

  update(_time: number, delta: number) {
    if (!this.currState) return;
    // Cap delta to prevent burst of ticks after scene transitions
    if (delta > 100) delta = TICK_DT_MS;

    // Warmup mode — step local sim with player 0 input
    if (this.warmupMode && this.warmupState && this.warmupConfig) {
      this.warmupAccum += delta;
      const maxTicks = 3;
      let ticksRun = 0;
      while (this.warmupAccum >= TICK_DT_MS && ticksRun < maxTicks) {
        this.warmupAccum -= TICK_DT_MS;
        ticksRun++;
        if (this.warmupState.matchOver) break;
        const p0 = this.warmupState.players[0];
        const input = p0 ? this.inputManager.getPlayer1Input(
          p0.x + PLAYER_WIDTH / 2,
          p0.y + PLAYER_HEIGHT / 2,
        ) : NULL_INPUT;
        const inputs: InputMap = new Map([
          [0, input],
          [1, NULL_INPUT],
        ]);
        const prevWarmup = this.warmupState;
        this.warmupState = step(this.warmupState, inputs, this.warmupPrevInputs, this.warmupConfig);
        this.detectAudioEvents(prevWarmup, this.warmupState);
        this.banishWarmupPlayer2(this.warmupState);
        this.warmupPrevInputs = inputs;
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
        if (this.replayTick < this.replayTranscript.length && !this.currState!.matchOver) {
          const tickInputs = this.replayTranscript[this.replayTick]!;
          const p0 = tickInputs[0];
          const p1 = tickInputs[1];
          const inputs: InputMap = new Map([
            [0, { buttons: p0.buttons, aimX: p0.aim_x ?? p0.aimX ?? 0, aimY: p0.aim_y ?? p0.aimY ?? 0 }],
            [1, { buttons: p1.buttons, aimX: p1.aim_x ?? p1.aimX ?? 0, aimY: p1.aim_y ?? p1.aimY ?? 0 }],
          ]);
          this.prevState = this.currState;
          this.currState = step(this.currState!, inputs, this.replayPrevInputs, this.config);
          this.replayPrevInputs = inputs;
          this.replayTick++;
        } else if (this.currState!.matchOver) {
          const w = this.currState!.winner;
          showAnnounce(w === -1 ? "DRAW!" : `Player ${w + 1} wins!`);
          this.playing = false;
        }
      }
    }

    if (this.playing && this.prediction && !this.replayMode) {
      // Run prediction at fixed 60Hz rate
      this.predictionAccum += delta;
      const maxTicks = 3;
      let ticksRun = 0;

      while (this.predictionAccum >= TICK_DT_MS && ticksRun < maxTicks) {
        this.predictionAccum -= TICK_DT_MS;
        ticksRun++;

        const player = this.prediction.predictedState.players[this.localPlayerId];
        if (player) {
          const input = this.inputManager.getPlayer1Input(
            player.x + PLAYER_WIDTH / 2,
            player.y + PLAYER_HEIGHT / 2,
          );
          const nextTick = this.prediction.currentTick + 1;
          this.onLocalInput?.(input, nextTick);
          this.prediction.predictTick(input);
        }
      }

      // Clamp accumulator to prevent runaway
      if (this.predictionAccum > TICK_DT_MS * 2) {
        this.predictionAccum = 0;
      }

      // Maintain prediction lead over server: ensures serverTick < predictedTick
      // so reconciliation always has a replay window for jump edge detection.
      // Without this, server states overwrite prediction (jump snap-back).
      const PRED_LEAD = 6; // ~100ms lead at 60Hz
      if (this.lastServerTick > 0) {
        const targetTick = this.lastServerTick + PRED_LEAD;
        let extraTicks = 0;
        while (this.prediction.currentTick < targetTick && extraTicks < 8) {
          const player = this.prediction.predictedState.players[this.localPlayerId];
          if (!player) break;
          const input = this.inputManager.getPlayer1Input(
            player.x + PLAYER_WIDTH / 2,
            player.y + PLAYER_HEIGHT / 2,
          );
          const nextTick = this.prediction.currentTick + 1;
          this.onLocalInput?.(input, nextTick);
          this.prediction.predictTick(input);
          extraTicks++;
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

    const predicted = this.replayMode ? null : this.prediction?.predictedState;
    const displayState = predicted ?? curr;

    // Detect rocket explosions from predicted/display state (instant, no server delay)
    const currentRocketIds = new Set<number>();
    for (const proj of displayState.projectiles) {
      if (proj.weapon === WeaponType.Rocket) currentRocketIds.add(proj.id);
    }
    for (const [id, pos] of this.prevRockets) {
      if (!currentRocketIds.has(id)) {
        this.explosions.push({ x: pos.x, y: pos.y, timer: 15 });
        this.playSound("explosion");
      }
    }
    this.prevRockets.clear();
    for (const proj of displayState.projectiles) {
      if (proj.weapon === WeaponType.Rocket) {
        const rcfg = GUN_CONFIG[WeaponType.Rocket];
        const ryOff = rcfg ? rcfg.offsetY + rcfg.muzzleY * rcfg.scale : 0;
        this.prevRockets.set(proj.id, { x: proj.x, y: proj.y + ryOff });
      }
    }

    this.updateCamera(curr, predicted, delta);
    this.drawArena(g, displayState);
    this.drawPickups(g, displayState);
    this.drawPlayers(g, curr, predicted, delta);
    this.drawProjectiles(g, curr, predicted, delta);
    this.drawExplosions(g);
    this.drawHUD(curr, displayState, predicted);
  }

  private drawArena(g: Phaser.GameObjects.Graphics, displayState: GameState) {
    const map = this.config?.map ?? ARENA;
    // Platforms are rendered by tile sprites (createMapTiles), not Graphics.
    // Only draw sudden death walls here.
    if (displayState.arenaLeft > 0) {
      g.fillStyle(WALL_COLOR, 0.5);
      g.fillRect(0, 0, displayState.arenaLeft, map.height);
      g.fillRect(displayState.arenaRight, 0, map.width - displayState.arenaRight, map.height);
    }
  }

  private drawPickups(_g: Phaser.GameObjects.Graphics, displayState: GameState) {
    const tick = displayState.tick;
    const activeIds = new Set<number>();

    for (const pickup of displayState.weaponPickups) {
      activeIds.add(pickup.id);
      const wasActive = this.prevPickupActive.get(pickup.id) ?? (pickup.respawnTimer <= 0);

      if (pickup.respawnTimer > 0) {
        // Respawning — hide sprite, show faint outline via graphics
        this.getPickupSprite(pickup.id)?.setVisible(false);
        this.prevPickupActive.set(pickup.id, false);

        // Detect collection: was active, now respawning → play collection animation
        if (wasActive) {
          const fx = this.add.sprite(pickup.x, pickup.y + 20, "collected")
            .setDepth(25)
            .setScale(1);
          this.hudCamera.ignore(fx);
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
        sprite = this.add.image(pickup.x, py, tex ?? "gun-pistol")
          .setDepth(15)
          .setScale(0.6);
        this.hudCamera.ignore(sprite);
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
    curr: GameState,
    predicted: GameState | null | undefined,
    delta?: number,
  ) {
    // First pass: compute draw positions for all players
    const drawPositions: { x: number; y: number }[] = [];
    const playerStates: (PlayerState | null)[] = [];

    for (let i = 0; i < curr.players.length; i++) {
      if (this.warmupMode && i === 1) {
        drawPositions.push({ x: 0, y: 0 });
        playerStates.push(null);
        continue;
      }
      const isLocal = i === this.localPlayerId && !this.replayMode;
      const raw = curr.players[i]!;
      let cp: PlayerState;
      let drawX: number, drawY: number;

      if (this.replayMode) {
        cp = raw;
        drawX = cp.x;
        drawY = cp.y;
      } else if (isLocal) {
        // Use predicted position for responsiveness, but server-authoritative combat fields
        // (health, lives, deaths) to avoid desync artifacts like "healing" when server disagrees
        const pred = predicted?.players[i];
        cp = pred ? { ...pred, health: raw.health, lives: raw.lives, alive: raw.alive, stateFlags: raw.stateFlags, stompedBy: raw.stompedBy, stompingOn: raw.stompingOn, stompShakeProgress: raw.stompShakeProgress } : raw;
        const smooth = this.localSmooth;
        if (!smooth.initialized) { smooth.x = cp.x; smooth.y = cp.y; smooth.initialized = true; }
        const teleported = Math.abs(smooth.x - cp.x) > 60 || Math.abs(smooth.y - cp.y) > 60;
        if (teleported) { smooth.x = cp.x; smooth.y = cp.y; }
        else {
          const prevSmoothY = smooth.y;
          smooth.x = smoothLerp(smooth.x, cp.x, 0.85, delta ?? 16.667);
          smooth.y = smoothLerp(smooth.y, cp.y, 0.95, delta ?? 16.667);
          if (cp.vy < 0 && smooth.y > prevSmoothY) smooth.y = prevSmoothY;
        }
        drawX = smooth.x;
        drawY = smooth.y;
      } else {
        // Remote player: always use server state (no predicted combat overlay)
        cp = raw;
        const smooth = this.remoteSmooth;
        if (!smooth.initialized) { smooth.x = cp.x; smooth.y = cp.y; smooth.initialized = true; }
        const teleported = Math.abs(smooth.x - cp.x) > 80 || Math.abs(smooth.y - cp.y) > 80;
        if (teleported) { smooth.x = cp.x; smooth.y = cp.y; }
        else {
          smooth.x = smoothLerp(smooth.x, cp.x, 0.5, delta ?? 16.667);
          smooth.y = cp.grounded ? cp.y : smoothLerp(smooth.y, cp.y, 0.5, delta ?? 16.667);
        }
        drawX = smooth.x;
        drawY = smooth.y;
      }
      drawPositions.push({ x: drawX, y: drawY });
      playerStates.push(cp);
    }

    // Snap riders to victim draw positions so they match exactly
    for (let i = 0; i < playerStates.length; i++) {
      const cp = playerStates[i];
      if (!cp || cp.stompingOn === null) continue;
      const victimIdx = curr.players.findIndex(p => p.id === cp.stompingOn);
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
        sprite?.setVisible(false);
        this.gunSprites[i]?.setVisible(false);
        this.stompAlertTexts[i]?.setAlpha(0);
        if (cp.lives > 0) {
          const currentMap = this.config?.map ?? ARENA;
          const spawn = currentMap.spawnPoints[cp.id % currentMap.spawnPoints.length]!;
          const displayTick = predicted?.tick ?? curr.tick;
          const pulse = Math.sin(displayTick * 0.15) * 0.3 + 0.5;
          const color = PLAYER_COLORS[cp.id] ?? 0xffffff;
          g.fillStyle(color, pulse);
          g.fillRect(spawn.x, spawn.y, PLAYER_WIDTH, PLAYER_HEIGHT);
        }
        this.nameTexts[i]?.setVisible(false);
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
        const hasGun = cp.weapon !== null;
        // Determine crouch button state for edge detection
        // Local player: read inputManager directly (no round-trip delay)
        const isLocal = (i === this.localPlayerId && !this.replayMode) || (this.warmupMode && i === 0);
        const playerBtns = isLocal
          ? this.inputManager.getPlayer1Input(cp.x, cp.y).buttons
          : this.lastReceivedButtons[i];
        const tauntNow = !!(playerBtns & Button.Taunt);
        const tauntPrev = !!(this.prevFrameButtons[i] & Button.Taunt);
        const tauntEdge = tauntNow && !tauntPrev && cp.grounded;
        const tauntPlaying = sprite.anims.currentAnim?.key === `${slug}-crouch` && sprite.anims.isPlaying;
        if (tauntEdge) {
          // Restart animation + sound immediately (interrupts previous)
          sprite.play(`${slug}-crouch`);
          const soundKey = CROUCH_SOUNDS[slug];
          if (soundKey) this.playSoundInterrupt(soundKey);
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
        sprite.setPosition(drawX + PLAYER_WIDTH / 2, drawY + PLAYER_HEIGHT / 2);
        sprite.setFlipX(cp.facing === Facing.Left);
        sprite.setVisible(true);
        sprite.setAlpha(invincible ? 0.6 : 1);
        // Rider renders behind victim; victim on top so their bars are visible
        if (cp.stompingOn !== null) {
          sprite.setDepth(18);
        } else if (cp.stompedBy !== null) {
          sprite.setDepth(22);
        } else {
          sprite.setDepth(20);
        }
      }

      // Gun sprite — position at character's hand, bob synced to animation frame
      const gunSprite = this.gunSprites[i];
      if (gunSprite) {
        if (cp.weapon !== null && alive) {
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
          const bobY = gcfg && totalFrames > 1
            ? Math.sin((frameIdx / totalFrames) * Math.PI * 2) * gcfg.bobAmplitude
            : 0;
          const gunOffX = gunFacing * (gcfg?.offsetX ?? 10);
          const gunOffY = (gcfg?.offsetY ?? 4) + bobY;
          gunSprite.setPosition(
            drawX + PLAYER_WIDTH / 2 + gunOffX,
            drawY + PLAYER_HEIGHT / 2 + gunOffY,
          );
          gunSprite.setScale(gcfg?.scale ?? 0.5);
          gunSprite.setFlipX(gunFacing === -1);
          gunSprite.setVisible(true);
          gunSprite.setAlpha(invincible ? 0.6 : 1);
          // Match sprite depth for stomp layering
          gunSprite.setDepth(cp.stompingOn !== null ? 19 : cp.stompedBy !== null ? 23 : 21);
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
            this.dustEmitter.emitParticleAt(
              feetX + (Math.random() - 0.5) * 24,
              feetY - 4,
              1,
            );
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
      const isLocal = (i === this.localPlayerId && !this.replayMode) || (this.warmupMode && i === 0);
      const btns = isLocal
        ? this.inputManager.getPlayer1Input(cp.x, cp.y).buttons
        : this.lastReceivedButtons[i];
      this.prevFrameButtons[i] = btns;
    }
  }

  private drawPlayerOverlays(
    g: Phaser.GameObjects.Graphics,
    cp: PlayerState,
    drawX: number,
    drawY: number,
    index: number,
    predicted: GameState | null | undefined,
    curr: GameState,
  ) {
    // Stomped victims draw bars on high-depth overlay so they render above rider sprite
    const barGfx = cp.stompedBy !== null ? this.gfxOverlay : g;

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
    if (cp.stompedBy !== null && cp.stompShakeProgress > 0) {
      const shakePct = cp.stompShakeProgress / 100;
      barGfx.fillStyle(0x000000);
      barGfx.fillRect(drawX - 1, shakeBarBelow - 1, PLAYER_WIDTH + 2, 5);
      barGfx.fillStyle(0x444444);
      barGfx.fillRect(drawX, shakeBarBelow, PLAYER_WIDTH, 3);
      barGfx.fillStyle(0xffee58);
      barGfx.fillRect(drawX, shakeBarBelow, PLAYER_WIDTH * shakePct, 3);
    }
    if (alertText) {
      const alertY = (cp.stompedBy !== null && cp.stompShakeProgress > 0)
        ? shakeBarBelow + 6
        : drawY + PLAYER_HEIGHT + 2;
      alertText.setPosition(drawX + PLAYER_WIDTH / 2, alertY);
      if (cp.stompedBy !== null) {
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
    curr: GameState,
    predicted: GameState | null | undefined,
    _delta: number,
  ) {
    const displayState = predicted ?? curr;
    const projectiles = displayState.projectiles;
    for (const p of projectiles) {
      let px = p.x;
      const gcfg = GUN_CONFIG[p.weapon];
      // Consistent Y offset: shift to gun height on every frame (avoids vertical jump)
      const yOff = gcfg ? gcfg.offsetY + gcfg.muzzleY * gcfg.scale : 0;

      // First frame only: snap X to muzzle position (forward motion masks the transition)
      const maxLife = WEAPON_STATS[p.weapon as WeaponType]?.lifetime ?? 90;
      if (p.lifetime >= maxLife - 1 && gcfg) {
        const owner = displayState.players.find(pl => pl.id === p.ownerId);
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
        case WeaponType.Pistol:  bw = 3; bh = 2; break;
        case WeaponType.SMG:     bw = 3; bh = 2; break;
        case WeaponType.Shotgun: bw = 4; bh = 2; break;
        case WeaponType.Sniper:  bw = 6; bh = 2; break;
        case WeaponType.Rocket:  bw = 6; bh = 4; break;
        default:                 bw = 3; bh = 2; break;
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

  private drawHUD(curr: GameState, displayState: GameState, predicted: GameState | null | undefined) {
    // Warmup mode — hide all game HUD
    if (this.warmupMode) {
      this.timerText.setText("");
      document.getElementById("sudden-death-overlay")?.classList.remove("visible");
      this.roundText.setVisible(false);
      this.weaponText.setText("");
      return;
    }

    // Timer
    const ticksRemaining = (this.config?.matchDurationTicks ?? 1800) - displayState.tick;
    const secondsRemaining = Math.max(0, Math.ceil(ticksRemaining / TICK_RATE));
    this.timerText.setText(`${secondsRemaining}s`);

    // Sudden death countdown + text (DOM overlay for guaranteed visibility)
    const sdTick = this.config?.suddenDeathStartTick ?? 1200;
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
      this.roundText.setText(`R${this.currentRound + 1}/${this.totalRounds}  ${this.roundWins[0]}-${this.roundWins[1]}`);
      this.roundText.setVisible(true);
    } else {
      this.roundText.setVisible(false);
    }

    // Weapon + ammo
    if (!this.replayMode) {
      const localPlayer = (predicted ?? curr).players[this.localPlayerId];
      if (localPlayer && (localPlayer.stateFlags & PlayerStateFlag.Alive)) {
        if (localPlayer.weapon !== null) {
          const name = WEAPON_NAMES[localPlayer.weapon] ?? "???";
          this.weaponText.setText(`${name} [${localPlayer.ammo}]`);
          this.weaponText.setColor(`#${(WEAPON_PICKUP_COLORS[localPlayer.weapon] ?? 0xffffff).toString(16).padStart(6, "0")}`);
        } else {
          this.weaponText.setText("UNARMED");
          this.weaponText.setColor("#888888");
        }
      } else {
        this.weaponText.setText("");
      }
    } else {
      this.weaponText.setText("");
    }

    // Stomp alert alpha reset (drawPlayerOverlays sets alpha when active)

    // Replay controls
    if (this.replayMode) {
      const status = this.replayPaused ? "PAUSED" : "PLAYING";
      this.replayInfoText.setText(`REPLAY ${status} ${this.replaySpeed}x | Space: Pause | Up/Down: Speed | Esc: Exit`);
    }
  }

  private updateCamera(curr: GameState, predicted: GameState | null | undefined, delta: number) {
    const cam = this.cameras.main;

    // Fixed zoom mode: show whole arena, centered (with padding so edges aren't clipped)
    if (!this.dynamicZoom && !this.warmupMode) {
      const mapW = this.config?.map.width ?? 960;
      const mapH = this.config?.map.height ?? 540;
      const PAD = 40;
      const fitZoom = Math.min(VIEW_W / (mapW + PAD * 2), VIEW_H / (mapH + PAD * 2));
      this.currentZoom = smoothLerp(this.currentZoom, fitZoom, 0.1, delta);
      this.cameraX = smoothLerp(this.cameraX, mapW / 2, 0.15, delta);
      this.cameraY = smoothLerp(this.cameraY, mapH / 2, 0.15, delta);
      cam.setZoom(this.currentZoom * DPR);
      cam.centerOn(this.cameraX, this.cameraY);
      return;
    }

    // Local player from predicted state, remote from server state (curr)
    const localP = (predicted ?? curr).players[this.localPlayerId];
    const remoteP = curr.players[1 - this.localPlayerId];

    // Warmup or single-player
    if (!localP || !remoteP || this.warmupMode) {
      if (this.warmupMode && this.dynamicZoom && localP) {
        // Dynamic zoom in warmup: follow the player
        const aliveLocal = !!(localP.stateFlags & PlayerStateFlag.Alive);
        const targetX = aliveLocal ? localP.x + PLAYER_WIDTH / 2 : 480;
        const targetY = aliveLocal ? localP.y + PLAYER_HEIGHT / 2 : 270;
        this.currentZoom = smoothLerp(this.currentZoom, 1.3, 0.05, delta);
        this.cameraX = smoothLerp(this.cameraX, targetX, 0.15, delta);
        this.cameraY = smoothLerp(this.cameraY, targetY, 0.15, delta);
      } else {
        // Static zoom: show full arena
        const mapW = (this.warmupMode ? this.warmupConfig?.map.width : this.config?.map.width) ?? 960;
        const mapH = (this.warmupMode ? this.warmupConfig?.map.height : this.config?.map.height) ?? 540;
        const PAD = 40;
        const fitZoom = Math.min(VIEW_W / (mapW + PAD * 2), VIEW_H / (mapH + PAD * 2));
        this.currentZoom = smoothLerp(this.currentZoom, fitZoom, 0.05, delta);
        this.cameraX = smoothLerp(this.cameraX, mapW / 2, 0.15, delta);
        this.cameraY = smoothLerp(this.cameraY, mapH / 2, 0.15, delta);
      }
      cam.setZoom(this.currentZoom * DPR);
      cam.centerOn(this.cameraX, this.cameraY);
      return;
    }

    const aliveLocal = !!(localP.stateFlags & PlayerStateFlag.Alive);
    const aliveRemote = !!(remoteP.stateFlags & PlayerStateFlag.Alive);

    let targetZoom: number;
    let targetX: number;
    let targetY: number;

    // During round transition, stay zoomed on the winner
    const killZoom = this.roundTransition || (predicted ?? curr).deathLingerTimer > 0;

    if (aliveLocal && aliveRemote) {
      const dist = Math.hypot(localP.x - remoteP.x, localP.y - remoteP.y);
      targetZoom = dist < 250 ? 1.3 : dist > 500 ? 1.0 : lerp(1.3, 1.0, (dist - 250) / 250);
      targetX = (localP.x + remoteP.x) / 2 + PLAYER_WIDTH / 2;
      targetY = (localP.y + remoteP.y) / 2 + PLAYER_HEIGHT / 2;

      // Ensure both players fit in viewport (critical for narrow windows)
      const PAD = 80; // pixels of padding around players
      const needW = Math.abs(localP.x - remoteP.x) + PLAYER_WIDTH + PAD * 2;
      const needH = Math.abs(localP.y - remoteP.y) + PLAYER_HEIGHT + PAD * 2;
      const fitZoom = Math.min(VIEW_W / needW, VIEW_H / needH);
      if (fitZoom < targetZoom) targetZoom = fitZoom;
    } else if (aliveLocal) {
      targetZoom = killZoom ? 1.5 : 1.0;
      targetX = localP.x + PLAYER_WIDTH / 2;
      targetY = localP.y + PLAYER_HEIGHT / 2;
    } else if (aliveRemote) {
      targetZoom = killZoom ? 1.5 : 1.0;
      targetX = remoteP.x + PLAYER_WIDTH / 2;
      targetY = remoteP.y + PLAYER_HEIGHT / 2;
    } else {
      targetZoom = killZoom ? 1.5 : 1.0;
      targetX = 480;
      targetY = 270;
    }

    this.currentZoom = smoothLerp(this.currentZoom, targetZoom, 0.05, delta);
    this.cameraX = smoothLerp(this.cameraX, targetX, 0.15, delta);
    this.cameraY = smoothLerp(this.cameraY, targetY, 0.15, delta);
    cam.setZoom(this.currentZoom * DPR);
    cam.centerOn(this.cameraX, this.cameraY);
  }

  // ── Audio ──────────────────────────────────────────────────────────────────

  private playSound(key: string) {
    if (this._muted || this.sfxVolume === 0) return;
    // Try Phaser audio first (check asset cache, not sound manager), fall back to Web Audio synth
    if (this.audioLoaded && this.cache.audio.exists(key)) {
      try {
        this.sound.play(key, { volume: this.sfxVolume });
        return;
      } catch { /* fall through */ }
    }
    playSFX(key, this.sfxVolume);
  }

  /** Play a sound, stopping any previous instance first (for spammable SFX like taunt). */
  private playSoundInterrupt(key: string) {
    if (this._muted || this.sfxVolume === 0) return;
    if (this.audioLoaded && this.cache.audio.exists(key)) {
      try {
        // Stop all existing instances of this sound
        this.sound.stopByKey(key);
        this.sound.play(key, { volume: this.sfxVolume });
        return;
      } catch { /* fall through */ }
    }
    playSFX(key, this.sfxVolume);
  }

  /** Smoothly fade a WebAudio track's volume from `from` to `to` over `ms` milliseconds. */
  private fadeVolume(track: Phaser.Sound.WebAudioSound, from: number, to: number, ms: number) {
    const steps = 20;
    const interval = ms / steps;
    let step = 0;
    const timer = setInterval(() => {
      step++;
      track.volume = from + (to - from) * (step / steps);
      if (step >= steps) clearInterval(timer);
    }, interval);
  }

  private pickBgmTrack(): string {
    let track: number;
    do {
      track = 1 + Math.floor(Math.random() * 5);
    } while (track === this.lastBgmTrack && 5 > 1);
    this.lastBgmTrack = track;
    return `bgm-${track}`;
  }

  /** Start BGM if not already playing. Idempotent — safe to call multiple times. */
  startBGM() {
    if (this.bgmVolume === 0 || !this.audioLoaded || this._muted) return;
    if (this.bgm?.isPlaying) return; // already playing, don't restart
    this.playNextTrack();
  }

  private playNextTrack() {
    if (this.bgmVolume === 0 || !this.audioLoaded) return;
    try {
      const key = this.pickBgmTrack();
      const newTrack = this.sound.add(key, { loop: false, volume: this.bgmVolume }) as Phaser.Sound.WebAudioSound;
      // Crossfade: fade out old track over 1s, then destroy it
      if (this.bgm?.isPlaying && "volume" in this.bgm) {
        const oldTrack = this.bgm as Phaser.Sound.WebAudioSound;
        this.fadeVolume(oldTrack, oldTrack.volume, 0, 1000);
        setTimeout(() => { oldTrack.stop(); oldTrack.destroy(); }, 1050);
      } else if (this.bgm) {
        this.bgm.destroy();
      }
      this.bgm = newTrack;
      newTrack.on("complete", () => this.playNextTrack());
      newTrack.play();
    } catch {
      // BGM not available
    }
  }

  private detectAudioEvents(prev: GameState, curr: GameState) {
    // New projectiles → shoot sound (weapon-specific for rapid-fire)
    if (curr.projectiles.length > prev.projectiles.length) {
      const newProj = curr.projectiles[curr.projectiles.length - 1];
      if (newProj && newProj.weapon === WeaponType.SMG) {
        this.playSound("shoot-smg");
      } else {
        this.playSoundInterrupt("shoot");
      }
    }

    // Per-player events
    for (let i = 0; i < curr.players.length; i++) {
      const pp = prev.players[i];
      const cp = curr.players[i];
      if (pp && cp) {
        if (cp.health < pp.health && cp.health > 0) {
          this.playSound("hit");
        }
        if ((pp.stateFlags & PlayerStateFlag.Alive) && !(cp.stateFlags & PlayerStateFlag.Alive)) {
          this.playSound("death");
        }
        if (cp.weapon !== null && cp.weapon !== pp.weapon) {
          this.playSound("pickup");
        }
        // Jump: jumpsLeft decreased while alive
        if (cp.jumpsLeft < pp.jumpsLeft && (cp.stateFlags & PlayerStateFlag.Alive)) {
          this.playSound("jump");
        }
      }
    }
  }
}
