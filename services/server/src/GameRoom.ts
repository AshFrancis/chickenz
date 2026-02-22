import type { ServerWebSocket } from "bun";
import {
  MAP_POOL,
  TICK_RATE,
  NULL_INPUT,
} from "@chickenz/sim";
import type {
  GameMap,
  PlayerInput,
} from "@chickenz/sim";
import type { StateMessage, EndedMessage, RoomInfo, GameMode } from "./protocol";
import { inputFromMessage, generateJoinCode, type InputMessage } from "./protocol";
import { WasmState } from "./wasm";
import { randomBotName, createBotSocket, createBotState, botThink, type BotState } from "./BotAI";

export interface SocketData {
  roomId: string | null;
  playerId: number;
  username: string;
  walletAddress: string;
  character: number; // chosen character index (0-3)
  tournamentId: string | null;
  msgCount: number;
  msgResetTime: number;
}

type GameSocket = ServerWebSocket<SocketData>;

const STATE_BROADCAST_INTERVAL = 1; // send state every tick (60Hz) for minimal remote player delay
const TOTAL_ROUNDS = 3;
const WINS_NEEDED = 2;
const ROUND_TRANSITION_MS = 750; // brief pause between taunt end and next round

export class GameRoom {
  readonly id: string;
  readonly name: string;
  readonly joinCode: string;
  readonly isPrivate: boolean;
  readonly mode: GameMode;
  private sockets: GameSocket[] = [];
  spectatorSockets: GameSocket[] = [];
  private wasmState!: WasmState;
  private currentMap!: GameMap;
  private lastAppliedButtons: [number, number] = [0, 0];
  private rawInput: [PlayerInput, PlayerInput] = [NULL_INPUT, NULL_INPUT];
  private accInput: [PlayerInput, PlayerInput] = [NULL_INPUT, NULL_INPUT];
  private inputQueues: [Map<number, PlayerInput>, Map<number, PlayerInput>] = [new Map(), new Map()];
  private transcript: [PlayerInput, PlayerInput][] = [];
  private lastButtonState: [number, number] = [0, 0];
  private inputChanges: [number, number] = [0, 0];
  private timer: ReturnType<typeof setInterval> | null = null;
  private seed = 0;
  private loopStartTime = 0; // wall-clock time when game loop started
  private _status: "waiting" | "playing" | "ended" = "waiting";
  onEnded?: (sockets: GameSocket[], winner: number, roomId: string, roomName: string, scores: [number, number], mode: GameMode) => void;

  // Round system
  private currentRound = 0;
  private roundWins: [number, number] = [0, 0];
  private mapOrder: number[] = []; // indices into MAP_POOL
  private characterSlots: [number, number] = [0, 1]; // character indices for each player
  private roundTranscripts: { seed: number; mapIndex: number; transcript: object[] }[] = [];
  private matchOverTick = -1; // tick when match_over first detected (-1 = not yet)
  private _matchStartTime = 0; // wall-clock ms when match started
  private botState: BotState | null = null;
  private _isBotMatch = false;

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

  /** Current seed used by the game sim (set after startMatch/startRound). */
  get currentSeed() {
    return this.seed;
  }

  /** Wall-clock time when the match started. */
  get matchStartTime() {
    return this._matchStartTime;
  }

  /** Map index used for the current round. */
  get currentMapIndex() {
    return this.mapOrder[this.currentRound % this.mapOrder.length] ?? 0;
  }

  /** Character slots assigned to each player. */
  get characters(): [number, number] {
    return this.characterSlots;
  }

  get isBotMatch(): boolean {
    return this._isBotMatch;
  }

  /** Add a bot opponent to this room. */
  addBot() {
    const name = randomBotName();
    const botSocket = createBotSocket(name);
    this._isBotMatch = true;
    this.botState = createBotState();
    this.addPlayer(botSocket);
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
    // Track button state changes for activity detection
    if (incoming.buttons !== this.lastButtonState[playerId]) {
      this.inputChanges[playerId]++;
      this.lastButtonState[playerId] = incoming.buttons;
    }
    const currentTick = this.wasmState.tick();
    if (msg.tick !== undefined && msg.tick > currentTick && msg.tick < currentTick + 120) {
      // Future tick — queue for exact tick alignment (prevents phantom edges)
      // Cap at 120 ticks ahead (~2s) to prevent memory abuse
      if (this.inputQueues[playerId].size < 120) {
        this.inputQueues[playerId].set(msg.tick, incoming);
      }
    } else {
      // Current/past tick or no tick tag — apply immediately
      this.rawInput[playerId] = incoming;
      this.accInput[playerId] = {
        buttons: incoming.buttons,
        aimX: incoming.aimX,
        aimY: incoming.aimY,
      };
    }
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

  /** Convert TS map (camelCase) to Rust ProverInput format (snake_case). */
  private static toProverMap(map: GameMap) {
    return {
      width: map.width,
      height: map.height,
      platforms: map.platforms,
      spawn_points: map.spawnPoints,
      weapon_spawn_points: map.weaponSpawnPoints,
    };
  }

  /** Return transcript for proving (last round only). */
  getTranscript() {
    return {
      config: {
        seed: this.seed,
        map: GameRoom.toProverMap(this.currentMap),
        player_count: 2,
        tick_rate: TICK_RATE,
        initial_lives: 1,
        match_duration_ticks: 1800,
        sudden_death_start_tick: 1200,
      },
      transcript: this.transcript.map(([p0, p1]) => [
        { buttons: p0.buttons, aim_x: p0.aimX, aim_y: p0.aimY },
        { buttons: p1.buttons, aim_x: p1.aimX, aim_y: p1.aimY },
      ]),
    };
  }

  /** Return all rounds' transcripts for replay. */
  getFullTranscript() {
    const usernames: [string, string] = [
      this.sockets[0]?.data.username || "P1",
      this.sockets[1]?.data.username || "P2",
    ];
    return {
      rounds: this.roundTranscripts,
      usernames,
      characters: this.characterSlots,
    };
  }

  // ── Private ──────────────────────────────────────────────

  private startMatch() {
    this._status = "playing";
    this._matchStartTime = Date.now();
    this.currentRound = 0;
    this.roundWins = [0, 0];

    // Shuffle map order for this match (Fisher-Yates on indices)
    this.mapOrder = MAP_POOL.map((_, i) => i);
    for (let i = this.mapOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.mapOrder[i]!, this.mapOrder[j]!] = [this.mapOrder[j]!, this.mapOrder[i]!];
    }

    // Auto-generate guest names for players without usernames
    for (const ws of this.sockets) {
      if (!ws.data.username) {
        const a = String.fromCharCode(65 + Math.floor(Math.random() * 26));
        const b = String.fromCharCode(65 + Math.floor(Math.random() * 26));
        ws.data.username = `Chk${a}${b}`;
      }
    }

    // P1 keeps their chosen character; P2 gets theirs if it doesn't conflict, else random
    const NUM_CHARACTERS = 4;
    const p1Char = this.sockets[0]?.data.character ?? Math.floor(Math.random() * NUM_CHARACTERS);
    let p2Char = this.sockets[1]?.data.character ?? -1;
    if (p2Char === p1Char || p2Char < 0 || p2Char >= NUM_CHARACTERS) {
      // Conflict or no choice — assign random from remaining pool
      p2Char = Math.floor(Math.random() * (NUM_CHARACTERS - 1));
      if (p2Char >= p1Char) p2Char++;
    }
    this.characterSlots = [p1Char, p2Char];

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
        characters: this.characterSlots,
      });
    }

    this.startRound();
  }

  private startRound() {
    // Round 0 seed is already set in startMatch() and sent to clients in "matched"
    // Only generate a new seed for rounds 1+
    if (this.currentRound > 0) {
      this.seed = Date.now() >>> 0;
    }
    const mapIndex = this.mapOrder[this.currentRound % this.mapOrder.length] ?? 0;
    const map = MAP_POOL[mapIndex] ?? MAP_POOL[0]!;
    this.currentMap = map;

    // Free previous WASM state if any
    if (this.wasmState) {
      try { this.wasmState.free(); } catch { /* already freed */ }
    }
    this.wasmState = new WasmState(this.seed, JSON.stringify(map));
    this.lastAppliedButtons = [0, 0];
    this.rawInput = [NULL_INPUT, NULL_INPUT];
    this.accInput = [NULL_INPUT, NULL_INPUT];
    this.inputQueues = [new Map(), new Map()];
    this.transcript = [];
    this.matchOverTick = -1;
    if (this.botState) this.botState = createBotState();

    // Start game loop — self-correcting to prevent drift
    this.loopStartTime = performance.now();
    this.timer = setInterval(() => this.gameLoop(), 1000 / TICK_RATE);
  }

  /** Self-correcting game loop: runs multiple ticks if behind, skips if ahead. */
  private gameLoop() {
    if (this._status !== "playing") return;

    const elapsed = performance.now() - this.loopStartTime;
    const targetTick = Math.floor(elapsed / (1000 / TICK_RATE));
    const currentTick = this.wasmState.tick();

    // Run ticks to catch up (max 4 per interval to avoid lag spikes)
    let ticked = 0;
    while (currentTick + ticked < targetTick && ticked < 4) {
      this.tick();
      ticked++;
    }
  }

  private tick() {
    if (this._status !== "playing") return;

    const nextTick = this.wasmState.tick() + 1;

    // Freeze players during countdown (~1.5s = 90 ticks)
    const COUNTDOWN_TICKS = 90;
    if (nextTick <= COUNTDOWN_TICKS) {
      this.wasmState.step(0, 0, 0, 0, 0, 0);
      if (nextTick % STATE_BROADCAST_INTERVAL === 0) this.broadcastState();
      return;
    }

    // Apply tick-tagged inputs — aligns edge detection with client prediction
    for (const id of [0, 1] as const) {
      const queued = this.inputQueues[id].get(nextTick);
      if (queued !== undefined) {
        this.accInput[id] = queued;
        this.rawInput[id] = queued;
      }
    }

    // Inject bot input before transcript recording
    if (this.botState !== null) {
      const exported = this.wasmState.export_state() as any;
      const input = botThink(1, exported, this.currentMap, this.botState);
      this.rawInput[1] = input;
      this.accInput[1] = { ...input };
    }

    // Record for transcript (strip Taunt bit — cosmetic only, not part of ZK proof)
    const TAUNT_MASK = ~16;
    this.transcript.push([
      { ...this.accInput[0], buttons: this.accInput[0].buttons & TAUNT_MASK },
      { ...this.accInput[1], buttons: this.accInput[1].buttons & TAUNT_MASK },
    ]);

    // Track last buttons for broadcast (WASM handles prev_buttons internally)
    this.lastAppliedButtons = [this.accInput[0].buttons, this.accInput[1].buttons];

    // Step WASM sim
    this.wasmState.step(
      this.accInput[0].buttons, this.accInput[0].aimX, this.accInput[0].aimY,
      this.accInput[1].buttons, this.accInput[1].aimX, this.accInput[1].aimY,
    );

    // Reset accumulated to last raw input so held keys persist
    this.accInput[0] = { ...this.rawInput[0] };
    this.accInput[1] = { ...this.rawInput[1] };

    // Prune consumed/stale queue entries
    for (const id of [0, 1] as const) {
      for (const [tick] of this.inputQueues[id]) {
        if (tick <= nextTick) this.inputQueues[id].delete(tick);
      }
    }

    // Broadcast state
    if (this.wasmState.tick() % STATE_BROADCAST_INTERVAL === 0) {
      this.broadcastState();
    }

    // Diagnostic: log drift every 2 seconds (120 ticks)
    const currentTick = this.wasmState.tick();
    if (currentTick > 0 && currentTick % 120 === 0) {
      const elapsed = performance.now() - this.loopStartTime;
      const expectedTick = Math.floor(elapsed / (1000 / TICK_RATE));
      const drift = expectedTick - currentTick;
      console.log(`[GameRoom ${this.id}] tick=${currentTick} elapsed=${elapsed.toFixed(0)}ms expected=${expectedTick} drift=${drift}`);
    }

    if (this.wasmState.match_over()) {
      if (this.matchOverTick < 0) {
        this.matchOverTick = currentTick;
        // Send round_end immediately so clients show the banner
        const winner = this.wasmState.winner();
        if (winner === 0 || winner === 1) this.roundWins[winner]++;
        const roundEndMsg = {
          round: this.currentRound,
          winner,
          roundWins: [...this.roundWins] as [number, number],
        };
        this.broadcast({ type: "round_end", ...roundEndMsg });
        this.broadcastSpectators({ type: "spectate_round_end", ...roundEndMsg });
      }
      // Keep broadcasting state for 120 extra ticks (2s) so clients see winner movement + bullet travel
      if (currentTick - this.matchOverTick >= 60) {
        this.endRound(this.wasmState.winner());
      }
    }
  }

  private broadcastState() {
    // Export WASM state (fp→f64, all fields camelCase)
    const exported = this.wasmState.export_state() as any;

    const msg: StateMessage = {
      type: "state",
      tick: exported.tick,
      lastButtons: this.lastAppliedButtons,
      players: exported.players,
      projectiles: exported.projectiles,
      weaponPickups: exported.weaponPickups,
      scores: exported.scores,
      arenaLeft: exported.arenaLeft,
      arenaRight: exported.arenaRight,
      matchOver: exported.matchOver,
      winner: exported.winner,
      deathLingerTimer: exported.deathLingerTimer,
      rngState: exported.rngState,
      nextProjectileId: exported.nextProjectileId,
    };

    const json = JSON.stringify(msg);
    for (const ws of this.sockets) {
      try {
        ws.send(json);
      } catch {
        // socket already closed
      }
    }

    // Relay to spectators with different message type
    if (this.spectatorSockets.length > 0) {
      const spectateJson = JSON.stringify({ ...msg, type: "spectate_state" });
      for (const ws of this.spectatorSockets) {
        try {
          ws.send(spectateJson);
        } catch {
          // socket already closed
        }
      }
    }
  }

  private endRound(winner: number) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Save this round's transcript before it resets
    const mapIndex = this.mapOrder[this.currentRound % this.mapOrder.length] ?? 0;
    this.roundTranscripts.push({
      seed: this.seed,
      mapIndex,
      transcript: this.transcript.map(([p0, p1]) => [
        { buttons: p0.buttons, aim_x: p0.aimX, aim_y: p0.aimY },
        { buttons: p1.buttons, aim_x: p1.aimX, aim_y: p1.aimY },
      ]),
    });

    // round_end message + roundWins already sent/incremented at matchOverTick detection

    // Check if match is won (best of 3 → first to 2)
    if (this.roundWins[0] >= WINS_NEEDED || this.roundWins[1] >= WINS_NEEDED) {
      const matchWinner = this.roundWins[0] >= WINS_NEEDED ? 0 : 1;
      setTimeout(() => this.endMatch(matchWinner), 100);
    } else {
      // Start next round after delay
      this.currentRound++;
      const nextMapIndex = this.mapOrder[this.currentRound % this.mapOrder.length];
      setTimeout(() => {
        if (this._status !== "playing") return;
        this.seed = Date.now() >>> 0;
        const roundStartMsg = {
          round: this.currentRound,
          seed: this.seed,
          mapIndex: nextMapIndex,
        };
        this.broadcast({ type: "round_start", ...roundStartMsg });
        this.broadcastSpectators({ type: "spectate_round_start", ...roundStartMsg });
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

    // Free WASM state
    if (this.wasmState) {
      try { this.wasmState.free(); } catch { /* already freed */ }
    }

    const scores: [number, number] = [...this.roundWins] as [number, number];

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

  private broadcastSpectators(msg: object) {
    if (this.spectatorSockets.length === 0) return;
    const json = JSON.stringify(msg);
    for (const ws of this.spectatorSockets) {
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
