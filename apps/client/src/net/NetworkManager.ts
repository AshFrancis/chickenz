import type { PlayerInput } from "@chickenz/sim";

export type GameMode = "casual" | "ranked";

export interface RoomInfo {
  id: string;
  name: string;
  status: "waiting" | "playing" | "ended";
  players: number;
  joinCode: string;
  isPrivate: boolean;
  mode: GameMode;
}

// Wire types for JSON messages from the server
interface RawPlayerState {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  health: number;
  lives: number;
  shootCooldown: number;
  grounded: boolean;
  stateFlags: number;
  respawnTimer: number;
  weapon?: number | null;
  ammo?: number;
  jumpsLeft?: number;
  wallSliding?: boolean;
  wallDir?: number;
  stompedBy?: number | null;
  stompingOn?: number | null;
  stompShakeProgress?: number;
}

interface RawProjectile {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  lifetime: number;
  weapon?: number;
}

interface RawWeaponPickup {
  id: number;
  x: number;
  y: number;
  weapon: number;
  respawnTimer: number;
}

interface ServerMessage {
  type: string;
  rooms?: RoomInfo[];
  roomId?: string;
  roomName?: string;
  joinCode?: string;
  playerId?: number;
  seed?: number;
  usernames?: [string, string];
  winner?: number;
  scores?: [number, number];
  roundWins?: [number, number];
  message?: string;
  mapIndex?: number;
  totalRounds?: number;
  round?: number;
  mode?: GameMode;
  characters?: [number, number];
  // State fields (inlined when type === "state")
  tick?: number;
  players?: RawPlayerState[];
  projectiles?: RawProjectile[];
  weaponPickups?: RawWeaponPickup[];
  rngState?: number;
  nextProjectileId?: number;
  arenaLeft?: number;
  arenaRight?: number;
  matchOver?: boolean;
  deathLingerTimer?: number;
  lastButtons?: [number, number];
}

export interface TournamentBracket {
  matches: { matchIndex: number; matchLabel: string; winnerSlot: number; loserSlot: number }[];
  playerNames: string[];
}

export interface NetworkCallbacks {
  onWaiting: (roomId: string, roomName: string, joinCode: string) => void;
  onMatched: (playerId: number, seed: number, roomId: string, usernames: [string, string], mapIndex: number, totalRounds: number, mode: GameMode, characters: [number, number]) => void;
  onState: (state: any, lastButtons?: [number, number]) => void;
  onRoundEnd: (round: number, winner: number, roundWins: [number, number]) => void;
  onRoundStart: (round: number, seed: number, mapIndex: number) => void;
  onEnded: (winner: number, scores: [number, number], roundWins: [number, number], roomId: string, mode: GameMode) => void;
  onLobby: (rooms: RoomInfo[]) => void;
  onError: (message: string) => void;
  onDisconnect: () => void;
  // Tournament callbacks
  onTournamentLobby?: (tournamentId: string, joinCode: string, players: string[], status: string) => void;
  onTournamentMatchStart?: (matchLabel: string, matchIndex: number, role: "fighter" | "spectator", playerId: number | undefined, seed: number, usernames: [string, string], mapIndex: number, totalRounds: number, characters: [number, number]) => void;
  onSpectateState?: (state: any, lastButtons?: [number, number]) => void;
  onSpectateRoundEnd?: (round: number, winner: number, roundWins: [number, number]) => void;
  onSpectateRoundStart?: (round: number, seed: number, mapIndex: number) => void;
  onTournamentMatchEnd?: (matchIndex: number, matchLabel: string, winnerName: string, bracket: TournamentBracket) => void;
  onTournamentEnd?: (standings: string[], bracket: TournamentBracket) => void;
}

export class NetworkManager {
  private ws: WebSocket | null = null;
  private callbacks: NetworkCallbacks;
  private serverOrigin = "";
  private lastSentButtons = -1;
  private lastSentAimX = -999;
  private lastSentAimY = -999;

  constructor(callbacks: NetworkCallbacks) {
    this.callbacks = callbacks;
  }

  connect(url: string) {
    this.disconnect();
    this.serverOrigin = url.replace(/^ws/, "http").replace(/\/ws$/, "");
    this.ws = new WebSocket(url);

    this.ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }

      switch (msg.type) {
        case "lobby":
          this.callbacks.onLobby(msg.rooms!);
          break;
        case "waiting":
          this.callbacks.onWaiting(msg.roomId!, msg.roomName!, msg.joinCode ?? "");
          break;
        case "matched":
          this.callbacks.onMatched(
            msg.playerId!, msg.seed!, msg.roomId!,
            msg.usernames ?? ["", ""],
            msg.mapIndex ?? 0,
            msg.totalRounds ?? 3,
            msg.mode ?? "casual",
            msg.characters ?? [0, 1],
          );
          break;
        case "state":
          this.callbacks.onState(msg, msg.lastButtons);
          break;
        case "round_end":
          this.callbacks.onRoundEnd(msg.round!, msg.winner!, msg.roundWins ?? [0, 0]);
          break;
        case "round_start":
          this.callbacks.onRoundStart(msg.round!, msg.seed!, msg.mapIndex ?? 0);
          break;
        case "ended":
          this.callbacks.onEnded(msg.winner!, msg.scores!, msg.roundWins ?? [0, 0], msg.roomId!, msg.mode ?? "casual");
          break;
        case "error":
          this.callbacks.onError(msg.message!);
          break;
        case "tournament_lobby":
          this.callbacks.onTournamentLobby?.(
            (msg as any).tournamentId, (msg as any).joinCode,
            (msg as any).players, (msg as any).status,
          );
          break;
        case "tournament_match_start":
          this.callbacks.onTournamentMatchStart?.(
            (msg as any).matchLabel, (msg as any).matchIndex,
            (msg as any).role, (msg as any).playerId,
            (msg as any).seed, (msg as any).usernames ?? ["", ""],
            (msg as any).mapIndex ?? 0, (msg as any).totalRounds ?? 3,
            (msg as any).characters ?? [0, 1],
          );
          break;
        case "spectate_state":
          this.callbacks.onSpectateState?.(msg, msg.lastButtons);
          break;
        case "spectate_round_end":
          this.callbacks.onSpectateRoundEnd?.(msg.round!, msg.winner!, msg.roundWins ?? [0, 0]);
          break;
        case "spectate_round_start":
          this.callbacks.onSpectateRoundStart?.(msg.round!, msg.seed!, msg.mapIndex ?? 0);
          break;
        case "tournament_match_end":
          this.callbacks.onTournamentMatchEnd?.(
            (msg as any).matchIndex, (msg as any).matchLabel,
            (msg as any).winnerName, (msg as any).bracket,
          );
          break;
        case "tournament_end":
          this.callbacks.onTournamentEnd?.((msg as any).standings, (msg as any).bracket);
          break;
      }
    };

    this.ws.onclose = () => {
      this.callbacks.onDisconnect();
    };

    this.ws.onerror = () => {
      // Error is followed by close event, handled there
    };
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get httpOrigin() {
    return this.serverOrigin;
  }

  sendSetUsername(username: string) {
    this.send({ type: "set_username", username });
  }

  sendQuickplay(mode: GameMode = "casual", character?: number) {
    this.send({ type: "quickplay", mode, character });
  }

  sendCreate(isPrivate: boolean = false, mode: GameMode = "casual", character?: number) {
    this.send({ type: "create", isPrivate, mode, character });
  }

  sendSetWallet(address: string) {
    this.send({ type: "set_wallet", address });
  }

  sendJoinRoom(roomId: string, character?: number) {
    this.send({ type: "join_room", roomId, character });
  }

  sendJoinByCode(code: string, character?: number) {
    this.send({ type: "join_code", code, character });
  }

  /** Reset throttle state so next input sends immediately. Call on round/match start. */
  resetThrottle() {
    this.lastSentButtons = -1;
    this.lastSentAimX = -999;
    this.lastSentAimY = -999;
  }

  sendInput(input: PlayerInput, tick?: number) {
    const inputChanged =
      input.buttons !== this.lastSentButtons ||
      input.aimX !== this.lastSentAimX ||
      input.aimY !== this.lastSentAimY;
    if (!inputChanged) return;

    this.lastSentButtons = input.buttons;
    this.lastSentAimX = input.aimX;
    this.lastSentAimY = input.aimY;
    this.send({
      type: "input",
      tick,
      buttons: input.buttons,
      aimX: input.aimX,
      aimY: input.aimY,
    });
  }

  sendListRooms() {
    this.send({ type: "list_rooms" });
  }

  sendCreateTournament() {
    this.send({ type: "create_tournament" });
  }

  sendJoinTournamentByCode(code: string) {
    this.send({ type: "join_tournament_code", code });
  }

  disconnect() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}

