import type { ServerWebSocket } from "bun";
import {
  createInitialState,
  step,
  MAP_POOL,
  TICK_RATE,
  INITIAL_LIVES,
  MATCH_DURATION_TICKS,
  SUDDEN_DEATH_START_TICK,
  NULL_INPUT,
} from "@chickenz/sim";
import type {
  GameState,
  GameMap,
  MatchConfig,
  InputMap,
  PlayerInput,
} from "@chickenz/sim";
import type { StateMessage, EndedMessage, RoomInfo, GameMode } from "./protocol";
import { inputFromMessage, generateJoinCode, type InputMessage } from "./protocol";

export interface SocketData {
  roomId: string | null;
  playerId: number;
  username: string;
  walletAddress: string;
}

type GameSocket = ServerWebSocket<SocketData>;

const STATE_BROADCAST_INTERVAL = 2; // send state every 2nd tick (30Hz)
const TOTAL_ROUNDS = 3;
const WINS_NEEDED = 2;
const ROUND_TRANSITION_MS = 1500; // 1.5s pause between rounds

export class GameRoom {
  readonly id: string;
  readonly name: string;
  readonly joinCode: string;
  readonly isPrivate: boolean;
  readonly mode: GameMode;
  private sockets: GameSocket[] = [];
  private state!: GameState;
  private config!: MatchConfig;
  private prevInputs: InputMap = new Map();
  private rawInput: [PlayerInput, PlayerInput] = [NULL_INPUT, NULL_INPUT];
  private accInput: [PlayerInput, PlayerInput] = [NULL_INPUT, NULL_INPUT];
  private transcript: [PlayerInput, PlayerInput][] = [];
  private lastButtonState: [number, number] = [0, 0];
  private inputChanges: [number, number] = [0, 0];
  private timer: ReturnType<typeof setInterval> | null = null;
  private seed = 0;
  private _status: "waiting" | "playing" | "ended" = "waiting";
  onEnded?: (sockets: GameSocket[], winner: number, roomId: string, roomName: string, scores: [number, number], mode: GameMode) => void;

  // Round system
  private currentRound = 0;
  private roundWins: [number, number] = [0, 0];
  private mapOrder: number[] = []; // indices into MAP_POOL

  constructor(id: string, name: string, creator: GameSocket, isPrivate: boolean = false, mode: GameMode = "casual") {
    this.id = id;
    this.name = name;
    this.joinCode = generateJoinCode();
    this.isPrivate = isPrivate;
    this.mode = mode;

    creator.data.roomId = id;
    creator.data.playerId = 0;
    this.sockets.push(creator);

    this.send(creator, {
      type: "waiting",
      roomId: id,
      roomName: name,
      joinCode: this.joinCode,
    });
  }

  get status() {
    return this._status;
  }

  get playerCount() {
    return this.sockets.length;
  }

  /** Second player joins — start the match. */
  addPlayer(ws: GameSocket) {
    if (this._status !== "waiting") return false;

    ws.data.roomId = this.id;
    ws.data.playerId = 1;
    this.sockets.push(ws);

    this.startMatch();
    return true;
  }

  handleInput(playerId: number, msg: InputMessage) {
    if (this._status !== "playing") return;
    if (playerId !== 0 && playerId !== 1) return;
    const incoming = inputFromMessage(msg);
    this.rawInput[playerId] = incoming;
    // Track button state changes for activity detection
    if (incoming.buttons !== this.lastButtonState[playerId]) {
      this.inputChanges[playerId]++;
      this.lastButtonState[playerId] = incoming.buttons;
    }
    // OR button bits together between ticks so brief presses aren't lost
    this.accInput[playerId] = {
      buttons: this.accInput[playerId].buttons | incoming.buttons,
      aimX: incoming.aimX,
      aimY: incoming.aimY,
    };
  }

  handleDisconnect(playerId: number) {
    if (this._status === "waiting") {
      this._status = "ended";
      return;
    }
    if (this._status === "playing") {
      const winnerId = playerId === 0 ? 1 : 0;
      this.endMatch(winnerId);
    }
  }

  getInputActivity(): [number, number] {
    return [...this.inputChanges] as [number, number];
  }

  toInfo(): RoomInfo {
    return {
      id: this.id,
      name: this.name,
      status: this._status,
      players: this.sockets.length,
      joinCode: this.joinCode,
      isPrivate: this.isPrivate,
      mode: this.mode,
    };
  }

  isEnded() {
    return this._status === "ended";
  }

  isWaiting() {
    return this._status === "waiting";
  }

  /** Return transcript in ProverInput format. */
  getTranscript() {
    return {
      config: { seed: this.seed },
      transcript: this.transcript.map(([p0, p1]) => [
        { buttons: p0.buttons, aim_x: p0.aimX, aim_y: p0.aimY },
        { buttons: p1.buttons, aim_x: p1.aimX, aim_y: p1.aimY },
      ]),
    };
  }

  // ── Private ──────────────────────────────────────────────

  private startMatch() {
    this._status = "playing";
    this.currentRound = 0;
    this.roundWins = [0, 0];

    // Shuffle map order for this match (Fisher-Yates on indices)
    this.mapOrder = MAP_POOL.map((_, i) => i);
    for (let i = this.mapOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.mapOrder[i], this.mapOrder[j]] = [this.mapOrder[j], this.mapOrder[i]];
    }

    // Auto-generate guest names for players without usernames
    for (const ws of this.sockets) {
      if (!ws.data.username) {
        const a = String.fromCharCode(65 + Math.floor(Math.random() * 26));
        const b = String.fromCharCode(65 + Math.floor(Math.random() * 26));
        ws.data.username = `Chk${a}${b}`;
      }
    }

    // Notify both players with initial round info
    const usernames: [string, string] = [
      this.sockets[0]?.data.username || "",
      this.sockets[1]?.data.username || "",
    ];
    this.seed = Date.now() >>> 0;
    for (const ws of this.sockets) {
      this.send(ws, {
        type: "matched",
        playerId: ws.data.playerId,
        seed: this.seed,
        roomId: this.id,
        usernames,
        mapIndex: this.mapOrder[0],
        totalRounds: TOTAL_ROUNDS,
        mode: this.mode,
      });
    }

    this.startRound();
  }

  private startRound() {
    this.seed = Date.now() >>> 0;
    const mapIndex = this.mapOrder[this.currentRound % this.mapOrder.length];
    const map = MAP_POOL[mapIndex] ?? MAP_POOL[0];

    this.config = {
      seed: this.seed,
      map,
      playerCount: 2,
      tickRate: TICK_RATE,
      initialLives: INITIAL_LIVES,
      matchDurationTicks: MATCH_DURATION_TICKS,
      suddenDeathStartTick: SUDDEN_DEATH_START_TICK,
    };

    this.state = createInitialState(this.config);
    this.prevInputs = new Map();
    this.rawInput = [NULL_INPUT, NULL_INPUT];
    this.accInput = [NULL_INPUT, NULL_INPUT];
    this.transcript = [];

    // Start game loop at 60Hz
    this.timer = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  // Netcode: "favor the victim" — the server runs the authoritative sim on
  // current state without rewinding for latency. A player can never be hit by
  // a bullet they already dodged on their screen. The attacker may miss shots
  // that look like hits on their screen due to latency.
  private tick() {
    if (this._status !== "playing") return;

    const inputs: InputMap = new Map([
      [0, this.accInput[0]],
      [1, this.accInput[1]],
    ]);

    // Record for transcript
    this.transcript.push([this.accInput[0], this.accInput[1]]);

    this.state = step(this.state, inputs, this.prevInputs, this.config);
    this.prevInputs = inputs;

    // Reset accumulated to last raw input (not NULL) so held keys persist
    this.accInput[0] = { ...this.rawInput[0] };
    this.accInput[1] = { ...this.rawInput[1] };

    // Broadcast state at 20Hz
    if (this.state.tick % STATE_BROADCAST_INTERVAL === 0) {
      this.broadcastState();
    }

    if (this.state.matchOver) {
      this.endRound(this.state.winner);
    }
  }

  private broadcastState() {
    // Broadcast authoritative sim state — positions come from the server sim
    // (smooth, consistent 30Hz updates) rather than relayed client reports
    // which arrive intermittently and cause interpolation stutter.
    const msg: StateMessage = {
      type: "state",
      tick: this.state.tick,
      players: this.state.players.map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        vx: p.vx,
        vy: p.vy,
        facing: p.facing as number,
        health: p.health,
        lives: p.lives,
        shootCooldown: p.shootCooldown,
        grounded: p.grounded,
        stateFlags: p.stateFlags,
        respawnTimer: p.respawnTimer,
        weapon: p.weapon,
        ammo: p.ammo,
      })),
      projectiles: this.state.projectiles.map((proj) => ({
        id: proj.id,
        ownerId: proj.ownerId,
        x: proj.x,
        y: proj.y,
        vx: proj.vx,
        vy: proj.vy,
        lifetime: proj.lifetime,
        weapon: proj.weapon,
      })),
      weaponPickups: this.state.weaponPickups.map((wp) => ({
        id: wp.id,
        x: wp.x,
        y: wp.y,
        weapon: wp.weapon,
        respawnTimer: wp.respawnTimer,
      })),
      scores: [
        this.state.score.get(0) ?? 0,
        this.state.score.get(1) ?? 0,
      ],
      arenaLeft: this.state.arenaLeft,
      arenaRight: this.state.arenaRight,
      matchOver: this.state.matchOver,
      winner: this.state.winner,
      deathLingerTimer: this.state.deathLingerTimer,
      rngState: this.state.rngState,
      nextProjectileId: this.state.nextProjectileId,
    };

    const json = JSON.stringify(msg);
    for (const ws of this.sockets) {
      try {
        ws.send(json);
      } catch {
        // socket already closed
      }
    }
  }

  private endRound(winner: number) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.roundWins[winner]++;

    // Send round_end to clients
    this.broadcast({
      type: "round_end",
      round: this.currentRound,
      winner,
      roundWins: [...this.roundWins] as [number, number],
    });

    // Check if match is won (best of 3 → first to 2)
    if (this.roundWins[0] >= WINS_NEEDED || this.roundWins[1] >= WINS_NEEDED) {
      const matchWinner = this.roundWins[0] >= WINS_NEEDED ? 0 : 1;
      setTimeout(() => this.endMatch(matchWinner), 2000);
    } else {
      // Start next round after delay
      this.currentRound++;
      const nextMapIndex = this.mapOrder[this.currentRound % this.mapOrder.length];
      setTimeout(() => {
        if (this._status !== "playing") return;
        this.seed = Date.now() >>> 0;
        this.broadcast({
          type: "round_start",
          round: this.currentRound,
          seed: this.seed,
          mapIndex: nextMapIndex,
        });
        this.startRound();
      }, ROUND_TRANSITION_MS);
    }
  }

  private endMatch(winner: number) {
    if (this._status === "ended") return;
    this._status = "ended";

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const scores: [number, number] = [
      this.state?.score.get(0) ?? 0,
      this.state?.score.get(1) ?? 0,
    ];

    const endMsg: EndedMessage = {
      type: "ended",
      winner,
      scores,
      roundWins: [...this.roundWins] as [number, number],
      roomId: this.id,
      mode: this.mode,
    };

    const json = JSON.stringify(endMsg);
    for (const ws of this.sockets) {
      try {
        ws.send(json);
      } catch {
        // socket already closed
      }
      // Clear room association so player can join a new game
      ws.data.roomId = null;
      ws.data.playerId = -1;
    }

    // Notify server to return sockets to lobby
    this.onEnded?.(this.sockets, winner, this.id, this.name, scores, this.mode);
  }

  private broadcast(msg: object) {
    const json = JSON.stringify(msg);
    for (const ws of this.sockets) {
      try {
        ws.send(json);
      } catch {
        // socket already closed
      }
    }
  }

  private send(ws: GameSocket, msg: object) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket already closed
    }
  }
}
