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
  PlayerStateFlag,
  WeaponType,
  Facing,
  createInitialState,
  step,
  NULL_INPUT,
} from "@chickenz/sim";
import type { GameState, GameMap, MatchConfig, PlayerInput, PlayerState, Projectile, WeaponPickup, InputMap } from "@chickenz/sim";
import { InputManager } from "../input/InputManager";
import { PredictionManager } from "../net/PredictionManager";
import { DPR, VIEW_W, VIEW_H } from "../game";

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
  private snapshotTime = 0;
  private config!: MatchConfig;
  private inputManager = new InputManager();
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
  private timerText!: Phaser.GameObjects.Text;
  private suddenDeathText!: Phaser.GameObjects.Text;
  // winText + roundPopupText are DOM-based (see #announce-overlay)
  private controlsText!: Phaser.GameObjects.Text;
  private weaponText!: Phaser.GameObjects.Text;
  private nameTexts: Phaser.GameObjects.Text[] = [];

  // Rocket explosion effects
  private explosions: { x: number; y: number; timer: number }[] = [];

  // Tile-based platform sprites + background
  private platformTiles: Phaser.GameObjects.Image[] = [];
  private bgTile: Phaser.GameObjects.TileSprite | null = null;

  // Character sprites (animated)
  private playerSprites: Phaser.GameObjects.Sprite[] = [];
  private gunSprites: Phaser.GameObjects.Image[] = [];
  private characterSlots: [number, number] = [0, 1]; // indices into CHARACTER_SLUGS

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

  // Warmup mode (waiting room with jumping)
  private warmupMode = false;
  private warmupState: GameState | null = null;
  private warmupConfig: MatchConfig | null = null;
  private warmupPrevInputs: InputMap = new Map();
  private warmupAccum = 0;
  private warmupJoinCode = "";
  // Warmup overlay is DOM-based (see index.html #warmup-overlay)

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
    // Try to load audio assets — silently fail if not found
    try {
      this.load.audio("bgm", "/audio/bgm.mp3");
      this.load.audio("shoot", "/audio/shoot.mp3");
      this.load.audio("hit", "/audio/hit.mp3");
      this.load.audio("death", "/audio/death.mp3");
      this.load.audio("pickup", "/audio/pickup.mp3");
      this.load.audio("match-start", "/audio/match-start.mp3");
      this.load.audio("match-end", "/audio/match-end.mp3");
    } catch {
      // Audio files may not exist yet
    }
    // Terrain spritesheet (16×16 tiles, 22 cols × 11 rows)
    this.load.spritesheet("terrain", "/sprites/terrain.png", { frameWidth: 16, frameHeight: 16 });
    this.load.image("bg-tile", "/sprites/bg-green.png");
    this.load.image("dust", "/sprites/dust.png");

    // Gun sprites
    for (const [, tex] of Object.entries(GUN_TEXTURES)) {
      this.load.image(tex, `/sprites/${tex}.png`);
    }

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
    });
  }

  create() {
    this.gfx = this.add.graphics();

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
      })
      .setOrigin(0.5, 0)
      .setResolution(DPR)
      .setVisible(false)
      .setDepth(100);
    this.inputManager.init(this.game.canvas);

    this.controlsText = this.add.text(10, VIEW_H - 25, "WASD + Space to play", {
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
      }).setOrigin(0.5, 1).setResolution(DPR).setDepth(50);
      this.nameTexts.push(text);
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
    const padX = VIEW_W / 2;
    const padY = VIEW_H / 2;
    this.cameras.main.setBounds(-padX, -padY, 960 + padX * 2, 540 + padY * 2);
    this.cameras.main.setZoom(DPR);

    // HUD camera: fixed zoom at DPR, covers full canvas viewport
    this.hudCamera = this.cameras.add(0, 0, Math.round(VIEW_W * DPR), Math.round(VIEW_H * DPR));
    this.hudCamera.setScroll(0, 0);
    this.hudCamera.setZoom(DPR);

    // Collect HUD elements (rendered only on hudCamera)
    const hudElements = [this.timerText, this.suddenDeathText, this.controlsText, this.weaponText, this.roundText, this.replayInfoText];

    // Main camera ignores HUD texts
    for (const el of hudElements) {
      this.cameras.main.ignore(el);
    }

    // HUD camera ignores game graphics and name texts
    this.hudCamera.ignore(this.gfx);
    for (const nt of this.nameTexts) {
      this.hudCamera.ignore(nt);
    }

    // Tiling background — covers the camera bounds area
    this.bgTile = this.add.tileSprite(480, 270, 960 + VIEW_W, 540 + VIEW_H, "bg-tile")
      .setDepth(-100);
    this.cameras.main.ignore([]); // main camera sees bg
    this.hudCamera.ignore(this.bgTile);

    // Graphics layer above platform tiles
    this.gfx.setDepth(10);

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
  }

  // ── Warmup Mode ──────────────────────────────────────────────────────────

  private assignCharacters() {
    const p1 = Math.floor(Math.random() * CHARACTER_SLUGS.length);
    let p2 = Math.floor(Math.random() * (CHARACTER_SLUGS.length - 1));
    if (p2 >= p1) p2++;
    this.characterSlots = [p1, p2];
  }

  startWarmup(joinCode: string, username?: string) {
    this.assignCharacters();
    this.warmupMode = true;
    this.warmupJoinCode = joinCode;
    this.playerUsernames = [username || "", ""];
    this.warmupAccum = 0;
    this.warmupPrevInputs = new Map();

    const map = ARENA;
    this.createMapTiles(map);
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
    this.suddenDeathText?.setVisible(false);
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

    this.warmupMode = false;
    document.getElementById("warmup-overlay")?.classList.remove("visible");

    this.initRound(seed, mapIndex);

    // Countdown: 3..2..1..GO before accepting input
    this.playing = false; // block input during countdown
    this.showCountdown(() => {
      // Reset accumulator so first frame after GO doesn't run burst of ticks
      this.predictionAccum = 0;
      this.playing = true;
      this.showRoundPopup(1);
      this.playSound("match-start");
    });

    this.startBGM();
  }

  /** Start a new round with the given seed and map. */
  startNewRound(seed: number, mapIndex: number, round: number) {
    this.currentRound = round;
    this.roundTransition = false;
    this.initRound(seed, mapIndex);
    this.showRoundPopup(round + 1);
    this.playSound("match-start");
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

  /** Handle round end — show result, let players keep moving. */
  handleRoundEnd(round: number, winner: number, roundWins: [number, number]) {
    this.roundWins = roundWins;
    this.roundTransition = true;
    const winnerName = (this.playerUsernames[winner] || `Player ${winner + 1}`).toUpperCase();
    showAnnounce(`Round ${round + 1} - ${winnerName} wins!\n${roundWins[0]} - ${roundWins[1]}`);
  }

  private initRound(seed: number, mapIndex: number) {
    const map = MAP_POOL[mapIndex] ?? MAP_POOL[0] ?? ARENA;
    this.createMapTiles(map);
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
    this.snapshotTime = performance.now();
    this.playing = true;
    hideAnnounce();
    this.suddenDeathText.setVisible(false);
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
  private createMapTiles(map: GameMap) {
    // Destroy previous round's tiles
    for (const t of this.platformTiles) t.destroy();
    this.platformTiles = [];

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
  }

  startReplay(transcript: TickInputPair[], seed: number) {
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

    this.createMapTiles(ARENA);
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
    this.snapshotTime = performance.now();
    this.playing = true;
    hideAnnounce();
    this.suddenDeathText.setVisible(false);
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

  receiveState(state: GameState) {
    // Drop out-of-order packets — prevents old states from overwriting newer ones
    if (state.tick <= this.lastServerTick) return;
    this.lastServerTick = state.tick;

    // Detect rocket explosions
    if (this.currState) {
      for (const prev of this.currState.projectiles) {
        if (prev.weapon === WeaponType.Rocket) {
          const stillExists = state.projectiles.some((p) => p.id === prev.id);
          if (!stillExists && prev.lifetime > 1) {
            this.explosions.push({ x: prev.x, y: prev.y, timer: 15 });
          }
        }
      }
    }

    // Detect events for audio
    if (this.currState) {
      this.detectAudioEvents(this.currState, state);
    }

    this.prevState = this.currState;
    this.currState = state;
    this.snapshotTime = performance.now();

    // Feed server state to prediction manager for reconciliation
    if (this.prediction) {
      this.prediction.applyServerState(state, state.tick);
    }
  }

  endOnlineMatch(winner: number) {
    this.playing = false;
    if (winner === -1) {
      showAnnounce("DRAW!");
    } else {
      const name = this.playerUsernames[winner]?.toUpperCase();
      showAnnounce(name ? `${name} wins!` : `Player ${winner + 1} wins!`);
    }
    this.playSound("match-end");
    this.stopBGM();
  }

  setMuted(muted: boolean) {
    this._muted = muted;
    if (muted && this.bgm?.isPlaying) {
      this.bgm.pause();
    } else if (!muted && this.bgm && !this.bgm.isPlaying && this.playing) {
      this.bgm.resume();
    }
  }

  /** Handle browser window resize — let Phaser FIT mode rescale the canvas. */
  handleResize() {
    this.scale.refresh();
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
        this.warmupState = step(this.warmupState, inputs, this.warmupPrevInputs, this.warmupConfig);
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
    }

    this.render(delta);
  }

  private render(delta: number) {
    const g = this.gfx;
    g.clear();

    const curr = this.currState;
    if (!curr) return;

    const predicted = this.replayMode ? null : this.prediction?.predictedState;
    const displayState = predicted ?? curr;

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

  private drawPickups(g: Phaser.GameObjects.Graphics, displayState: GameState) {
    const tick = displayState.tick;
    for (const pickup of displayState.weaponPickups) {
      if (pickup.respawnTimer > 0) {
        // Respawning: faint outline
        const color = WEAPON_PICKUP_COLORS[pickup.weapon] ?? 0x888888;
        g.lineStyle(1, color, 0.4);
        g.strokeCircle(pickup.x, pickup.y, 10);
        continue;
      }
      const color = WEAPON_PICKUP_COLORS[pickup.weapon] ?? 0xffffff;
      const bob = Math.sin(tick * 0.08) * 3;
      const py = pickup.y + bob;

      // Glow circle (brighter)
      const glowAlpha = 0.25 + Math.sin(tick * 0.06) * 0.1;
      g.fillStyle(color, glowAlpha);
      g.fillCircle(pickup.x, py, 20);

      // Diamond using fillTriangle (more reliable than fillPath)
      g.fillStyle(color, 0.9);
      g.fillTriangle(
        pickup.x, py - 14,
        pickup.x + 10, py,
        pickup.x, py + 14,
      );
      g.fillTriangle(
        pickup.x, py - 14,
        pickup.x - 10, py,
        pickup.x, py + 14,
      );

      // White outline
      g.lineStyle(2, 0xffffff, 1);
      g.strokeCircle(pickup.x, py, 14);
    }
  }

  private drawPlayers(
    g: Phaser.GameObjects.Graphics,
    curr: GameState,
    predicted: GameState | null | undefined,
    delta?: number,
  ) {
    for (let i = 0; i < curr.players.length; i++) {
      // Hide player 1 during warmup
      if (this.warmupMode && i === 1) {
        this.playerSprites[i]?.setVisible(false);
        this.gunSprites[i]?.setVisible(false);
        this.nameTexts[i]?.setVisible(false);
        continue;
      }
      const isLocal = i === this.localPlayerId && !this.replayMode;
      const raw = curr.players[i]!;

      // Build cp: for local player use predicted state, for remote use
      // interpolated stateFlags/facing so alive/invincible checks match
      // the rendered position (not the latest server state which is ahead).
      let cp: PlayerState;
      let drawX: number, drawY: number;

      if (this.replayMode) {
        cp = raw;
        drawX = cp.x;
        drawY = cp.y;
      } else if (isLocal) {
        cp = predicted ? predicted.players[i]! : raw;
        // Smooth lerp absorbs prediction rollback snaps
        const smooth = this.localSmooth;
        if (!smooth.initialized) {
          smooth.x = cp.x;
          smooth.y = cp.y;
          smooth.initialized = true;
        }
        const teleported = Math.abs(smooth.x - cp.x) > 60
          || Math.abs(smooth.y - cp.y) > 60;
        if (teleported) {
          smooth.x = cp.x;
          smooth.y = cp.y;
        } else {
          smooth.x = smoothLerp(smooth.x, cp.x, 0.85, delta ?? 16.667);
          // Snap Y on landing so character doesn't float above platform
          smooth.y = cp.grounded ? cp.y : smoothLerp(smooth.y, cp.y, 0.85, delta ?? 16.667);
        }
        drawX = smooth.x;
        drawY = smooth.y;
      } else {
        // Remote: use server state (raw) — prediction runs NULL_INPUT for
        // remote so predicted position diverges and causes teleporting
        cp = raw;
        const smooth = this.remoteSmooth;
        if (!smooth.initialized) {
          smooth.x = cp.x;
          smooth.y = cp.y;
          smooth.initialized = true;
        }
        const teleported = Math.abs(smooth.x - cp.x) > 80
          || Math.abs(smooth.y - cp.y) > 80;
        if (teleported) {
          smooth.x = cp.x;
          smooth.y = cp.y;
        } else {
          smooth.x = smoothLerp(smooth.x, cp.x, 0.5, delta ?? 16.667);
          smooth.y = cp.grounded ? cp.y : smoothLerp(smooth.y, cp.y, 0.5, delta ?? 16.667);
        }
        drawX = smooth.x;
        drawY = smooth.y;
      }

      const sprite = this.playerSprites[i];
      const alive = !!(cp.stateFlags & PlayerStateFlag.Alive);

      if (!alive) {
        sprite?.setVisible(false);
        this.gunSprites[i]?.setVisible(false);
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
        if (cp.wallSliding) {
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
        if (sprite.anims.currentAnim?.key !== animKey) {
          sprite.play(animKey);
        }
        sprite.setPosition(drawX + PLAYER_WIDTH / 2, drawY + PLAYER_HEIGHT / 2);
        sprite.setFlipX(cp.facing === Facing.Left);
        sprite.setVisible(true);
        sprite.setAlpha(invincible ? 0.6 : 1);
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
          const facingDir = cp.facing as number;
          // Bob derived from current animation frame — steps at 20fps, in sync with the sprite
          const frameIdx = sprite?.anims?.currentFrame?.index ?? 0;
          const totalFrames = sprite?.anims?.currentAnim?.frames?.length ?? 1;
          const bobY = gcfg && totalFrames > 1
            ? Math.sin((frameIdx / totalFrames) * Math.PI * 2) * gcfg.bobAmplitude
            : 0;
          const gunOffX = facingDir * (gcfg?.offsetX ?? 10);
          const gunOffY = (gcfg?.offsetY ?? 4) + bobY;
          gunSprite.setPosition(
            drawX + PLAYER_WIDTH / 2 + gunOffX,
            drawY + PLAYER_HEIGHT / 2 + gunOffY,
          );
          gunSprite.setScale(gcfg?.scale ?? 0.5);
          gunSprite.setFlipX(cp.facing === Facing.Left);
          gunSprite.setVisible(true);
          gunSprite.setAlpha(invincible ? 0.6 : 1);
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
    // Health bar
    const barY = drawY - 8;
    const healthPct = cp.health / 100;
    g.fillStyle(0x333333);
    g.fillRect(drawX, barY, PLAYER_WIDTH, 4);
    g.fillStyle(healthPct > 0.5 ? 0x66bb6a : healthPct > 0.25 ? 0xffa726 : 0xef5350);
    g.fillRect(drawX, barY, PLAYER_WIDTH * healthPct, 4);

    // Weapon color indicator (thin line under gun sprite)
    if (cp.weapon !== null) {
      g.fillStyle(WEAPON_PICKUP_COLORS[cp.weapon] ?? 0xffffff);
      g.fillRect(drawX, drawY + PLAYER_HEIGHT, PLAYER_WIDTH, 1);
    }

    // Username above player
    const nameText = this.nameTexts[index];
    if (!nameText) return;
    const uname = this.playerUsernames[index];
    if (uname) {
      nameText.setText(uname);
      nameText.setPosition(drawX + PLAYER_WIDTH / 2, drawY - 12);
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
      let py = p.y;

      // Offset freshly spawned projectiles to the gun muzzle position
      const maxLife = WEAPON_STATS[p.weapon as WeaponType]?.lifetime ?? 90;
      if (p.lifetime >= maxLife - 1) {
        const owner = displayState.players.find(pl => pl.id === p.ownerId);
        const gcfg = GUN_CONFIG[p.weapon];
        if (owner && gcfg) {
          const fdir = owner.facing as number;
          px = owner.x + PLAYER_WIDTH / 2 + fdir * (gcfg.offsetX + gcfg.muzzleX * gcfg.scale);
          py = owner.y + PLAYER_HEIGHT / 2 + gcfg.offsetY + gcfg.muzzleY * gcfg.scale;
        }
      }

      g.fillStyle(WEAPON_PROJECTILE_COLORS[p.weapon] ?? 0xffee58);
      g.fillCircle(px, py, p.weapon === WeaponType.Rocket ? 6 : PROJECTILE_RADIUS);
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
      this.suddenDeathText.setVisible(false);
      this.roundText.setVisible(false);
      this.weaponText.setText("");
      return;
    }

    // Timer
    const ticksRemaining = (this.config?.matchDurationTicks ?? 1800) - displayState.tick;
    const secondsRemaining = Math.max(0, Math.ceil(ticksRemaining / TICK_RATE));
    this.timerText.setText(`${secondsRemaining}s`);

    // Sudden death
    const inSuddenDeath = displayState.tick >= (this.config?.suddenDeathStartTick ?? 1200);
    this.suddenDeathText.setVisible(inSuddenDeath);
    if (inSuddenDeath) this.suddenDeathText.setY(55);

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

    // Replay controls
    if (this.replayMode) {
      const status = this.replayPaused ? "PAUSED" : "PLAYING";
      this.replayInfoText.setText(`REPLAY ${status} ${this.replaySpeed}x | Space: Pause | Up/Down: Speed | Esc: Exit`);
    }
  }

  private updateCamera(curr: GameState, predicted: GameState | null | undefined, delta: number) {
    const cam = this.cameras.main;

    // Local player from predicted state, remote from server state (curr)
    const localP = (predicted ?? curr).players[this.localPlayerId];
    const remoteP = curr.players[1 - this.localPlayerId];

    // Warmup or single-player: follow local player only
    if (!localP || !remoteP || this.warmupMode) {
      if (localP) {
        const aliveLocal = !!(localP.stateFlags & PlayerStateFlag.Alive);
        const targetX = aliveLocal ? localP.x + PLAYER_WIDTH / 2 : 480;
        const targetY = aliveLocal ? localP.y + PLAYER_HEIGHT / 2 : 270;
        this.currentZoom = smoothLerp(this.currentZoom, 1.0, 0.05, delta);
        this.cameraX = smoothLerp(this.cameraX, targetX, 0.15, delta);
        this.cameraY = smoothLerp(this.cameraY, targetY, 0.15, delta);
        cam.setZoom(this.currentZoom * DPR);
        cam.centerOn(this.cameraX, this.cameraY);
      }
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
    if (this._muted || !this.audioLoaded) return;
    try {
      this.sound.play(key, { volume: 0.5 });
    } catch {
      // Sound not loaded
    }
  }

  private startBGM() {
    if (this._muted || !this.audioLoaded) return;
    try {
      if (!this.bgm) {
        this.bgm = this.sound.add("bgm", { loop: true, volume: 0.3 });
      }
      if (!this.bgm.isPlaying) {
        this.bgm.play();
      }
    } catch {
      // BGM not available
    }
  }

  private stopBGM() {
    if (this.bgm?.isPlaying) {
      this.bgm.stop();
    }
  }

  private detectAudioEvents(prev: GameState, curr: GameState) {
    // New projectiles → shoot
    if (curr.projectiles.length > prev.projectiles.length) {
      this.playSound("shoot");
    }

    // Health decreased → hit
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
        if (cp.weapon !== null && pp.weapon === null) {
          this.playSound("pickup");
        }
      }
    }
  }
}
