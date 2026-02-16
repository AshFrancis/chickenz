import Phaser from "phaser";
import {
  createInitialState,
  step,
  ARENA,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  PROJECTILE_RADIUS,
  TICK_DT_MS,
  INITIAL_LIVES,
  MATCH_DURATION_TICKS,
  SUDDEN_DEATH_START_TICK,
  TICK_RATE,
  PlayerStateFlag,
} from "@chickenz/sim";
import type { GameState, MatchConfig, InputMap } from "@chickenz/sim";
import { InputManager } from "../input/InputManager";
import { TranscriptRecorder } from "../transcript";

const PLAYER_COLORS = [0x4fc3f7, 0xef5350]; // blue, red
const PLATFORM_COLOR = 0x666666;
const PROJECTILE_COLOR = 0xffee58;
const WALL_COLOR = 0xff0000;

export class GameScene extends Phaser.Scene {
  private state!: GameState;
  private config!: MatchConfig;
  private prevInputs: InputMap = new Map();
  private inputManager = new InputManager();
  private accumulator = 0;
  public transcript = new TranscriptRecorder();
  private playing = false;

  // Graphics objects
  private gfx!: Phaser.GameObjects.Graphics;
  private scoreText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private suddenDeathText!: Phaser.GameObjects.Text;
  private winText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: "GameScene" });
  }

  create() {
    this.gfx = this.add.graphics();
    this.scoreText = this.add.text(10, 10, "", {
      fontSize: "16px",
      color: "#ffffff",
      fontFamily: "monospace",
    });
    this.timerText = this.add
      .text(400, 10, "", {
        fontSize: "20px",
        color: "#ffffff",
        fontFamily: "monospace",
        align: "center",
      })
      .setOrigin(0.5, 0);
    this.suddenDeathText = this.add
      .text(400, 40, "SUDDEN DEATH", {
        fontSize: "24px",
        color: "#ff4444",
        fontFamily: "monospace",
        align: "center",
      })
      .setOrigin(0.5, 0)
      .setVisible(false);
    this.winText = this.add
      .text(400, 300, "", {
        fontSize: "32px",
        color: "#ffee58",
        fontFamily: "monospace",
        align: "center",
      })
      .setOrigin(0.5);

    this.inputManager.init(this.game.canvas);

    this.add.text(10, 575, "P1: WASD + Space  |  P2: Arrows + Shift", {
      fontSize: "11px",
      color: "#888888",
      fontFamily: "monospace",
    });

    // Start immediately with a random seed
    this.startMatch(Date.now() >>> 0);
  }

  /** Start (or restart) a match with the given seed. */
  startMatch(seed: number) {
    this.config = {
      seed,
      map: ARENA,
      playerCount: 2,
      tickRate: TICK_RATE,
      initialLives: INITIAL_LIVES,
      matchDurationTicks: MATCH_DURATION_TICKS,
      suddenDeathStartTick: SUDDEN_DEATH_START_TICK,
    };
    this.state = createInitialState(this.config);
    this.prevInputs = new Map();
    this.accumulator = 0;
    this.playing = true;
    this.winText.setText("");
    this.suddenDeathText.setVisible(false);
    this.transcript.start(seed);
  }

  update(_time: number, delta: number) {
    if (!this.playing || this.state.matchOver) {
      this.render();
      return;
    }

    this.accumulator += delta;

    while (this.accumulator >= TICK_DT_MS) {
      this.accumulator -= TICK_DT_MS;
      this.simTick();
    }

    this.render();
  }

  private simTick() {
    const p1 = this.state.players[0]!;
    const p2 = this.state.players[1]!;

    const p1Input = this.inputManager.getPlayer1Input(
      p1.x + PLAYER_WIDTH / 2,
      p1.y + PLAYER_HEIGHT / 2,
    );
    const p2Input = this.inputManager.getPlayer2Input(
      p2.x + PLAYER_WIDTH / 2,
      p2.y + PLAYER_HEIGHT / 2,
    );

    // Record inputs for transcript
    this.transcript.record(p1Input, p2Input);

    const inputs: InputMap = new Map([
      [0, p1Input],
      [1, p2Input],
    ]);

    this.state = step(this.state, inputs, this.prevInputs, this.config);
    this.prevInputs = inputs;

    if (this.state.matchOver) {
      this.playing = false;
      if (this.state.winner === -1) {
        this.winText.setText("DRAW!");
      } else {
        this.winText.setText(`Player ${this.state.winner + 1} wins!`);
      }
      // Notify the UI layer
      window.dispatchEvent(
        new CustomEvent("matchEnd", {
          detail: {
            winner: this.state.winner,
            scores: [this.state.score.get(0) ?? 0, this.state.score.get(1) ?? 0],
            ticks: this.state.tick,
            seed: this.config.seed,
          },
        }),
      );
    }
  }

  getMatchResult() {
    return {
      winner: this.state.winner,
      scores: [this.state.score.get(0) ?? 0, this.state.score.get(1) ?? 0],
      matchOver: this.state.matchOver,
      seed: this.config?.seed ?? 0,
    };
  }

  private render() {
    const g = this.gfx;
    g.clear();

    if (!this.state) return;

    // Draw platforms
    g.fillStyle(PLATFORM_COLOR);
    for (const plat of ARENA.platforms) {
      g.fillRect(plat.x, plat.y, plat.width, plat.height);
    }

    // Draw sudden death walls
    if (this.state.arenaLeft > 0) {
      g.fillStyle(WALL_COLOR, 0.5);
      g.fillRect(0, 0, this.state.arenaLeft, ARENA.height);
      g.fillRect(this.state.arenaRight, 0, ARENA.width - this.state.arenaRight, ARENA.height);
    }

    // Draw players
    for (const p of this.state.players) {
      const color = PLAYER_COLORS[p.id] ?? 0xffffff;
      const alive = !!(p.stateFlags & PlayerStateFlag.Alive);

      if (!alive) continue;

      const invincible = !!(p.stateFlags & PlayerStateFlag.Invincible);
      if (invincible && this.state.tick % 6 < 3) continue;

      g.fillStyle(color);
      g.fillRect(p.x, p.y, PLAYER_WIDTH, PLAYER_HEIGHT);

      // Health bar
      const barWidth = PLAYER_WIDTH;
      const barY = p.y - 8;
      const healthPct = p.health / 100;
      g.fillStyle(0x333333);
      g.fillRect(p.x, barY, barWidth, 4);
      g.fillStyle(healthPct > 0.5 ? 0x66bb6a : healthPct > 0.25 ? 0xffa726 : 0xef5350);
      g.fillRect(p.x, barY, barWidth * healthPct, 4);

      // Facing indicator
      const cx = p.x + PLAYER_WIDTH / 2;
      const cy = p.y + PLAYER_HEIGHT / 2;
      const fx = cx + p.facing * 14;
      g.fillStyle(0xffffff);
      g.fillTriangle(fx, cy - 3, fx, cy + 3, fx + p.facing * 6, cy);
    }

    // Draw projectiles
    g.fillStyle(PROJECTILE_COLOR);
    for (const proj of this.state.projectiles) {
      g.fillCircle(proj.x, proj.y, PROJECTILE_RADIUS);
    }

    // Timer
    const ticksRemaining = (this.config?.matchDurationTicks ?? 3600) - this.state.tick;
    const secondsRemaining = Math.max(0, Math.ceil(ticksRemaining / TICK_RATE));
    this.timerText.setText(`${secondsRemaining}s`);

    // Sudden death indicator
    const inSuddenDeath = this.state.tick >= (this.config?.suddenDeathStartTick ?? 3000);
    this.suddenDeathText.setVisible(inSuddenDeath);

    // Score + lives text
    const p1 = this.state.players[0]!;
    const p2 = this.state.players[1]!;
    const p1Score = this.state.score.get(0) ?? 0;
    const p2Score = this.state.score.get(1) ?? 0;
    this.scoreText.setText(
      `P1: ${p1.lives} lives (${p1Score} kills)  |  P2: ${p2.lives} lives (${p2Score} kills)`,
    );
  }
}
