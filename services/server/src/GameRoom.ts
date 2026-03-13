import type { ServerWebSocket } from "bun";
import { MAP_POOL, TICK_RATE, NULL_INPUT } from "@chickenz/sim";
import type { GameMap, PlayerInput } from "@chickenz/sim";
import type { StateMessage, EndedMessage, RoomInfo, GameMode } from "./protocol";
import { inputFromMessage, generateJoinCode, type InputMessage } from "./protocol";
import { WasmState } from "./wasm";
import { randomBotName, createBotSocket, createBotState, botThink, type BotState } from "./BotAI";

const COUNTDOWN_TICKS = 90;

export interface SocketData {
  roomId: string | null;
  playerId: number;
  username: string;
  walletAddress: string;
  walletVerified?: boolean;
  character: number; // chosen character index (0-3)
  awayCharacter: number; // fallback character if home conflicts
  tournamentId: string | null;
  msgCount: number;
  msgResetTime: number;
}

type GameSocket = ServerWebSocket<SocketData>;

const STATE_BROADCAST_INTERVAL = 1; // send state every tick (60Hz) for minimal remote player delay
// Ranked: best-of-3 (ZK proof compatibility), Casual: best-of-5
const RANKED_TOTAL_ROUNDS = 3;
const RANKED_WINS_NEEDED = 2;
const CASUAL_TOTAL_ROUNDS = 5;
const CASUAL_WINS_NEEDED = 3;
const ROUND_TRANSITION_MS = 750; // brief pause between taunt end and next round

export class GameRoom {
  readonly id: string;
  readonly name: string;
  joinCode: string;
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
  onEnded?: (
    sockets: GameSocket[],
    winner: number,
    roomId: string,
    roomName: string,
    scores: [number, number],
    mode: GameMode,
  ) => void;
  onStarted?: (room: GameRoom) => void;

  // Round system
  private totalRounds: number;
  private winsNeeded: number;
  private _overrideGameParams?: { seed: number; mapIndex: number; characters: [number, number] };
  private currentRound = 0;
  private roundWins: [number, number] = [0, 0];
  private mapOrder: number[] = []; // indices into MAP_POOL
  private characterSlots: [number, number] = [0, 1]; // character indices for each player
  private roundTranscripts: { seed: number; mapIndex: number; winner: number; transcript: object[] }[] = [];
  private pendingTimeouts: ReturnType<typeof setTimeout>[] = [];
  private matchOverTick = -1; // tick when match_over first detected (-1 = not yet)
  private countdownTick = 0; // tracks tick calls (including countdown before sim steps)
  private _matchStartTime = 0; // wall-clock ms when match started
  private botState: BotState | null = null;
  private botState0: BotState | null = null; // bot AI for player 0 (bot-vs-bot only)
  private _isBotMatch = false;
  private _isBotVsBotMatch = false;
  private botDifficulty = 0.3;
  private mercyRound = -1; // which round gets difficulty reduction
  private mercyAmount = 0;
  private _sessionId = 0;
  private _startTxHash: string | null = null;
  /** DB match ID — set once match record is created, used for late async updates */
  matchRecordId: string | null = null;

  constructor(
    id: string,
    name: string,
    creator: GameSocket,
    isPrivate: boolean = false,
    mode: GameMode = "casual",
    skipWaiting: boolean = false,
    overrideRounds?: { totalRounds: number; winsNeeded: number },
    overrideGameParams?: { seed: number; mapIndex: number; characters: [number, number] },
  ) {
    this.id = id;
    this.name = name;
    this.joinCode = generateJoinCode();
    this.isPrivate = isPrivate;
    this.mode = mode;
    this.totalRounds = overrideRounds?.totalRounds ?? (mode === "ranked" ? RANKED_TOTAL_ROUNDS : CASUAL_TOTAL_ROUNDS);
    this.winsNeeded = overrideRounds?.winsNeeded ?? (mode === "ranked" ? RANKED_WINS_NEEDED : CASUAL_WINS_NEEDED);
    this._overrideGameParams = overrideGameParams;

    creator.data.roomId = id;
    creator.data.playerId = 0;
    this.sockets.push(creator);

    if (!skipWaiting) {
      this.send(creator, {
        type: "waiting",
        roomId: id,
        roomName: name,
        joinCode: this.joinCode,
      });
    }
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

  get botName(): string | null {
    if (!this._isBotMatch || this.sockets.length < 2) return null;
    return this.sockets[1]?.data.username || null;
  }

  get currentBotDifficulty(): number {
    return this.botDifficulty;
  }

  get sessionId() {
    return this._sessionId;
  }

  get startTxHash() {
    return this._startTxHash;
  }
  set startTxHash(h: string | null) {
    this._startTxHash = h;
  }

  get roundWinsSnapshot(): [number, number] {
    return [...this.roundWins] as [number, number];
  }

  get walletAddresses(): [string, string] {
    return [this.sockets[0]?.data.walletAddress || "", this.sockets[1]?.data.walletAddress || ""];
  }

  /** Add a bot opponent to this room. Optionally pass a pre-generated name. */
  addBot(difficulty: number = 0.3, botName?: string) {
    const name = botName ?? randomBotName();
    const botSocket = createBotSocket(name);
    this._isBotMatch = true;
    this.botDifficulty = difficulty;
    this.botState = createBotState(difficulty);
    // Pre-plan mercy: one of first 2 rounds gets difficulty reduced
    this.mercyRound = Math.random() < 0.5 ? 0 : 1;
    this.mercyAmount = 0.2 + Math.random() * 0.15; // 0.2-0.35 reduction
    this.addPlayer(botSocket);
  }

  /** Make player 0 also a bot (for bot-vs-bot exhibition matches). */
  makeBotVsBot(difficulty0: number = 0.3) {
    this._isBotVsBotMatch = true;
    this.botState0 = createBotState(difficulty0);
    // No mercy for bot-vs-bot
    this.mercyRound = -1;
  }

  get isBotVsBotMatch() {
    return this._isBotVsBotMatch;
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

  /** Player voluntarily leaves while waiting. Returns the socket if removed. */
  handleLeave(playerId: number): GameSocket | null {
    if (this._status !== "waiting") return null;
    const idx = this.sockets.findIndex((ws) => ws.data.playerId === playerId);
    if (idx < 0) return null;
    const ws = this.sockets[idx]!;
    ws.data.roomId = null;
    ws.data.playerId = -1;
    this.sockets.splice(idx, 1);
    if (this.sockets.length === 0) {
      this._status = "ended";
    }
    return ws;
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
      playerNames: this.sockets.map((s) => s.data.username || ""),
    };
  }

  isEnded() {
    return this._status === "ended";
  }

  isWaiting() {
    return this._status === "waiting";
  }

  removeSpectator(ws: GameSocket) {
    const idx = this.spectatorSockets.indexOf(ws);
    if (idx >= 0) this.spectatorSockets.splice(idx, 1);
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

  /** Return transcript for proving (both winning rounds in multi-round format). */
  getTranscript() {
    // Determine the match winner
    const matchWinner = this.roundWins[0] >= this.winsNeeded ? 0 : 1;

    // Extract transcripts from rounds the match winner won
    const winningRounds = this.roundTranscripts.filter((r) => r.winner === matchWinner);

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
      rounds: winningRounds.map((r) => r.transcript),
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

    // Ranked: force arena map (only map the ZK prover supports)
    if (this.mode === "ranked") {
      this.mapOrder = [0, 0, 0];
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
      // Try away character before random
      const p2Away = this.sockets[1]?.data.awayCharacter ?? -1;
      if (p2Away >= 0 && p2Away < NUM_CHARACTERS && p2Away !== p1Char) {
        p2Char = p2Away;
      } else {
        p2Char = Math.floor(Math.random() * (NUM_CHARACTERS - 1));
        if (p2Char >= p1Char) p2Char++;
      }
    }
    this.characterSlots = [p1Char, p2Char];

    // Apply tournament overrides if provided
    if (this._overrideGameParams) {
      this.seed = this._overrideGameParams.seed;
      this.mapOrder = [this._overrideGameParams.mapIndex];
      this.characterSlots = this._overrideGameParams.characters;
      this._overrideGameParams = undefined; // consume once
    } else {
      this.seed = Date.now() >>> 0;
    }

    // Notify both players with initial round info
    const usernames: [string, string] = [this.sockets[0]?.data.username || "", this.sockets[1]?.data.username || ""];
    // Unique session ID: full 32 random bits for collision resistance
    this._sessionId = crypto.getRandomValues(new Uint32Array(1))[0]!;

    for (const ws of this.sockets) {
      this.send(ws, {
        type: "matched",
        playerId: ws.data.playerId,
        seed: this.seed,
        roomId: this.id,
        usernames,
        mapIndex: this.mapOrder[0] ?? 0,
        totalRounds: this.totalRounds,
        mode: this.mode,
        characters: this.characterSlots,
      });
    }

    // Notify server for on-chain registration before gameplay begins
    this.onStarted?.(this);

    this.startRound();
  }

  private startRound() {
    // Seed is set before this method: round 0 in startMatch(), rounds 1+ in endRound() timeout.
    const mapIndex = this.mapOrder[this.currentRound % this.mapOrder.length] ?? 0;
    const map = MAP_POOL[mapIndex] ?? MAP_POOL[0]!;
    this.currentMap = map;

    // Free previous WASM state if any
    if (this.wasmState) {
      try {
        this.wasmState.free();
      } catch {
        /* already freed */
      }
    }
    this.wasmState = new WasmState(this.seed, JSON.stringify(map));
    this.lastAppliedButtons = [0, 0];
    this.rawInput = [NULL_INPUT, NULL_INPUT];
    this.accInput = [NULL_INPUT, NULL_INPUT];
    this.inputQueues = [new Map(), new Map()];
    this.transcript = [];
    this.matchOverTick = -1;
    this.countdownTick = 0;
    if (this.botState !== null) {
      let roundDiff = this.botDifficulty;
      // Mercy round: reduce difficulty
      if (this.currentRound === this.mercyRound) {
        roundDiff = Math.max(0, roundDiff - this.mercyAmount);
      }
      // Dynamic adjustment based on scores (skip for bot-vs-bot)
      if (!this._isBotVsBotMatch) {
        if (this.roundWins[1] > this.roundWins[0]) {
          roundDiff = Math.max(0, roundDiff - 0.15);
        } else if (this.roundWins[0] > this.roundWins[1]) {
          roundDiff = Math.min(1.0, roundDiff + 0.05);
        }
      }
      this.botState = createBotState(roundDiff);
      this.botState.shouldTaunt = Math.random() < 0.5;
    }
    if (this.botState0 !== null) {
      this.botState0 = createBotState(this.botState0.difficulty);
      this.botState0.shouldTaunt = Math.random() < 0.5;
    }

    // Start game loop — self-correcting to prevent drift
    this.loopStartTime = performance.now();
    this.timer = setInterval(() => this.gameLoop(), 1000 / TICK_RATE);
  }

  /** Self-correcting game loop: runs multiple ticks if behind, skips if ahead. */
  private gameLoop() {
    if (this._status !== "playing") return;
    try {
      const elapsed = performance.now() - this.loopStartTime;
      const targetTick = Math.floor(elapsed / (1000 / TICK_RATE));

      // Run ticks to catch up (max 4 per interval to avoid lag spikes)
      // Use countdownTick (not WASM tick) since WASM doesn't advance during countdown
      let ticked = 0;
      while (this.countdownTick < targetTick && ticked < 4) {
        this.tick();
        ticked++;
      }
    } catch (err) {
      console.error(`[GameRoom ${this.id}] Unhandled error in gameLoop:`, err);
      this.endMatch(-1);
    }
  }

  private tick() {
    if (this._status !== "playing" || this.timer === null) return;

    this.countdownTick++;

    // Freeze sim during countdown (~1.5s = 90 ticks) — broadcast state but don't advance
    if (this.countdownTick <= COUNTDOWN_TICKS) {
      this.broadcastState();
      return;
    }

    // The WASM tick we're about to step into
    const nextWasmTick = this.wasmState.tick() + 1;

    // Apply tick-tagged inputs — aligns edge detection with client prediction
    for (const id of [0, 1] as const) {
      const queued = this.inputQueues[id].get(nextWasmTick);
      if (queued !== undefined) {
        this.accInput[id] = queued;
        this.rawInput[id] = queued;
      }
    }

    // Inject bot input before transcript recording
    if (this.botState !== null || this.botState0 !== null) {
      const exported = this.wasmState.export_state() as StateMessage;
      if (this.botState0 !== null) {
        const input0 = botThink(0, exported, this.currentMap, this.botState0);
        this.rawInput[0] = input0;
        this.accInput[0] = { ...input0 };
      }
      if (this.botState !== null) {
        const input = botThink(1, exported, this.currentMap, this.botState);
        this.rawInput[1] = input;
        this.accInput[1] = { ...input };
      }
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
    try {
      this.wasmState.step(
        this.accInput[0].buttons,
        this.accInput[0].aimX,
        this.accInput[0].aimY,
        this.accInput[1].buttons,
        this.accInput[1].aimX,
        this.accInput[1].aimY,
      );
    } catch (err) {
      console.error(`[GameRoom ${this.id}] WASM step() panic:`, err);
      this.endMatch(-1);
      return;
    }

    // Reset accumulated to last raw input so held keys persist
    this.accInput[0] = { ...this.rawInput[0] };
    this.accInput[1] = { ...this.rawInput[1] };

    // Prune consumed/stale queue entries
    for (const id of [0, 1] as const) {
      for (const [tick] of this.inputQueues[id]) {
        if (tick <= nextWasmTick) this.inputQueues[id].delete(tick);
      }
    }

    // Broadcast state
    if (this.wasmState.tick() % STATE_BROADCAST_INTERVAL === 0) {
      this.broadcastState();
    }

    if (this.wasmState.match_over()) {
      const currentTick = this.wasmState.tick();
      if (this.matchOverTick < 0) {
        this.matchOverTick = currentTick;
        // Send round_end immediately so clients show the banner
        const winner = this.wasmState.winner();
        if (winner === 0 || winner === 1) {
          this.roundWins[winner]++;
        } else {
          console.warn(
            `[Room ${this.id}] round ${this.currentRound} ended with unexpected winner=${winner}, forcing to 0`,
          );
          this.roundWins[0]++;
        }
        const safeWinner = winner === 0 || winner === 1 ? winner : 0;
        const roundEndMsg = {
          round: this.currentRound,
          winner: safeWinner,
          roundWins: [...this.roundWins] as [number, number],
        };
        this.broadcast({ type: "round_end", ...roundEndMsg });
        this.broadcastSpectators({ type: "spectate_round_end", ...roundEndMsg });
      }
      // Keep broadcasting state for 60 extra ticks (1s) so clients see winner movement + bullet travel
      if (currentTick - this.matchOverTick >= 60) {
        // AFK detection: if player barely moved, disable mercy
        if (this._isBotMatch && this.inputChanges[0] < 5) {
          this.mercyRound = -1;
        }
        this.endRound(this.wasmState.winner());
      }
    }
  }

  private broadcastState() {
    // Export WASM state (fp→f64, all fields camelCase)
    const exported = this.wasmState.export_state() as StateMessage;

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
      for (let i = this.spectatorSockets.length - 1; i >= 0; i--) {
        try {
          this.spectatorSockets[i]!.send(spectateJson);
        } catch {
          this.spectatorSockets.splice(i, 1);
        }
      }
    }
  }

  private endRound(winner: number) {
    if (this._status !== "playing") return; // guard against double-call from catch-up loop
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Save this round's transcript before it resets
    const mapIndex = this.mapOrder[this.currentRound % this.mapOrder.length] ?? 0;
    this.roundTranscripts.push({
      seed: this.seed,
      mapIndex,
      winner,
      transcript: this.transcript.map(([p0, p1]) => [
        { buttons: p0.buttons, aim_x: p0.aimX, aim_y: p0.aimY },
        { buttons: p1.buttons, aim_x: p1.aimX, aim_y: p1.aimY },
      ]),
    });

    // round_end message + roundWins already sent/incremented at matchOverTick detection

    // Check if match is won (casual: first to 3, ranked: first to 2), with safety cap
    if (
      this.roundWins[0] >= this.winsNeeded ||
      this.roundWins[1] >= this.winsNeeded ||
      this.currentRound >= this.totalRounds * 2
    ) {
      const matchWinner = this.roundWins[0] >= this.roundWins[1] ? 0 : 1;
      this.pendingTimeouts.push(setTimeout(() => this.endMatch(matchWinner), 100));
    } else {
      // Start next round after delay
      this.currentRound++;
      const nextMapIndex = this.mapOrder[this.currentRound % this.mapOrder.length] ?? 0;
      this.pendingTimeouts.push(
        setTimeout(() => {
          if (this._status !== "playing") return;
          // Ranked: keep same seed across rounds so on-chain seedCommit matches the proof
          if (this.mode !== "ranked") this.seed = Date.now() >>> 0;
          const roundStartMsg = {
            round: this.currentRound,
            seed: this.seed,
            mapIndex: nextMapIndex,
          };
          this.broadcast({ type: "round_start", ...roundStartMsg });
          this.broadcastSpectators({ type: "spectate_round_start", ...roundStartMsg });
          this.startRound();
        }, ROUND_TRANSITION_MS),
      );
    }
  }

  private endMatch(winner: number) {
    if (this._status === "ended") return;
    this._status = "ended";

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const t of this.pendingTimeouts) clearTimeout(t);
    this.pendingTimeouts.length = 0;

    // Free WASM state
    if (this.wasmState) {
      try {
        this.wasmState.free();
      } catch {
        /* already freed */
      }
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
    for (let i = this.spectatorSockets.length - 1; i >= 0; i--) {
      try {
        this.spectatorSockets[i]!.send(json);
      } catch {
        this.spectatorSockets.splice(i, 1);
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
