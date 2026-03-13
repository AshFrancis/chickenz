import type { PlayerInput } from "@chickenz/sim";
import type {
  ServerMessage,
  StateMessage,
  SpectateStateMessage,
  RoomInfo,
  GameMode,
  BracketMatch,
  TournamentBracket,
  TournamentConfig,
  TournamentParticipant,
  TournamentLobbyMessage,
  TournamentMatchStartMessage,
  TournamentMatchEndMessage,
  TournamentEndMessage,
  BracketType,
  MatchFormat,
} from "../../../../services/server/src/protocol";

export type {
  RoomInfo,
  GameMode,
  BracketMatch,
  TournamentBracket,
  TournamentConfig,
  TournamentParticipant,
  TournamentLobbyMessage,
  BracketType,
  MatchFormat,
};

export interface NetworkCallbacks {
  onWaiting: (roomId: string, roomName: string, joinCode: string) => void;
  onMatched: (
    playerId: number,
    seed: number,
    roomId: string,
    usernames: [string, string],
    mapIndex: number,
    totalRounds: number,
    mode: GameMode,
    characters: [number, number],
  ) => void;
  onState: (state: StateMessage, lastButtons?: [number, number]) => void;
  onRoundEnd: (round: number, winner: number, roundWins: [number, number]) => void;
  onRoundStart: (round: number, seed: number, mapIndex: number) => void;
  onEnded: (
    winner: number,
    scores: [number, number],
    roundWins: [number, number],
    roomId: string,
    mode: GameMode,
  ) => void;
  onLobby: (rooms: RoomInfo[]) => void;
  onError: (message: string) => void;
  onDisconnect: () => void;
  onReconnect?: () => void;
  // Tournament callbacks
  onTournamentLobby?: (msg: TournamentLobbyMessage) => void;
  onTournamentMatchStart?: (
    matchLabel: string,
    matchIndex: number,
    role: "fighter" | "spectator",
    playerId: number | undefined,
    seed: number,
    usernames: [string, string],
    mapIndex: number,
    totalRounds: number,
    characters: [number, number],
    bracket: TournamentBracket,
  ) => void;
  onSpectateState?: (state: SpectateStateMessage, lastButtons?: [number, number]) => void;
  onSpectateRoundEnd?: (round: number, winner: number, roundWins: [number, number]) => void;
  onSpectateRoundStart?: (round: number, seed: number, mapIndex: number) => void;
  onTournamentMatchEnd?: (
    matchIndex: number,
    matchLabel: string,
    winnerName: string,
    bracket: TournamentBracket,
  ) => void;
  onTournamentEnd?: (standings: { place: number; name: string }[], bracket: TournamentBracket) => void;
}

export class NetworkManager {
  private ws: WebSocket | null = null;
  private callbacks: NetworkCallbacks;
  private serverOrigin = "";
  private lastSentButtons = -1;
  private lastSentAimX = -999;
  private lastSentAimY = -999;
  private _url = "";
  private _reconnectAttempts = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _intentionalClose = false;
  private rttMs = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(callbacks: NetworkCallbacks) {
    this.callbacks = callbacks;
  }

  connect(url: string) {
    this._intentionalClose = true; // suppress reconnect for the old socket
    this.disconnect();
    this._url = url;
    this._reconnectAttempts = 0;
    this._intentionalClose = false;
    this.serverOrigin = url.replace(/^ws/, "http").replace(/\/ws$/, "");
    this._doConnect(url);
  }

  private _doConnect(url: string) {
    this.ws = new WebSocket(url);

    this.ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }

      switch (msg.type) {
        case "pong": {
          const sample = Date.now() - (msg as { t: number }).t;
          if (sample > 2000) break; // discard outliers (>2s = broken connection, not real RTT)
          // Asymmetric EWMA: recover quickly from spikes (alpha=0.5 up), slow follow for drops (0.2 down)
          const alpha = sample > this.rttMs ? 0.5 : 0.2;
          this.rttMs = this.rttMs === 0 ? sample : this.rttMs * (1 - alpha) + sample * alpha;
          break;
        }
        case "lobby":
          this.callbacks.onLobby(msg.rooms);
          break;
        case "waiting":
          this.callbacks.onWaiting(msg.roomId, msg.roomName, msg.joinCode);
          break;
        case "matched":
          this.callbacks.onMatched(
            msg.playerId,
            msg.seed,
            msg.roomId,
            msg.usernames,
            msg.mapIndex,
            msg.totalRounds,
            msg.mode,
            msg.characters,
          );
          break;
        case "state":
          this.callbacks.onState(msg, msg.lastButtons);
          break;
        case "round_end":
          this.callbacks.onRoundEnd(msg.round, msg.winner, msg.roundWins);
          break;
        case "round_start":
          this.callbacks.onRoundStart(msg.round, msg.seed, msg.mapIndex);
          break;
        case "ended":
          this.callbacks.onEnded(msg.winner, msg.scores, msg.roundWins, msg.roomId, msg.mode);
          break;
        case "error":
          this.callbacks.onError(msg.message);
          break;
        case "tournament_lobby": {
          const tl = msg as TournamentLobbyMessage;
          this.callbacks.onTournamentLobby?.(tl);
          break;
        }
        case "tournament_match_start": {
          const tms = msg as TournamentMatchStartMessage;
          this.callbacks.onTournamentMatchStart?.(
            tms.matchLabel,
            tms.matchIndex,
            tms.role,
            tms.playerId,
            tms.seed,
            tms.usernames,
            tms.mapIndex,
            tms.totalRounds,
            tms.characters,
            tms.bracket,
          );
          break;
        }
        case "spectate_state": {
          const ss = msg as SpectateStateMessage;
          this.callbacks.onSpectateState?.(ss, ss.lastButtons);
          break;
        }
        case "spectate_round_end":
          this.callbacks.onSpectateRoundEnd?.(msg.round, msg.winner, msg.roundWins);
          break;
        case "spectate_round_start":
          this.callbacks.onSpectateRoundStart?.(msg.round, msg.seed, msg.mapIndex);
          break;
        case "tournament_match_end": {
          const tme = msg as TournamentMatchEndMessage;
          this.callbacks.onTournamentMatchEnd?.(tme.matchIndex, tme.matchLabel, tme.winnerName, tme.bracket);
          break;
        }
        case "tournament_end": {
          const te = msg as TournamentEndMessage;
          this.callbacks.onTournamentEnd?.(te.standings, te.bracket);
          break;
        }
      }
    };

    this.ws.onopen = () => {
      const wasReconnect = this._reconnectAttempts > 0;
      this._reconnectAttempts = 0;
      // Start RTT measurement pings
      this.send({ type: "ping", t: Date.now() });
      this.pingInterval = setInterval(() => {
        this.send({ type: "ping", t: Date.now() });
      }, 2000);
      if (wasReconnect) this.callbacks.onReconnect?.();
    };

    this.ws.onclose = () => {
      if (this._intentionalClose) return;
      this.callbacks.onDisconnect();
      this._tryReconnect();
    };

    this.ws.onerror = () => {
      // Error is followed by close event, handled there
    };
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get rtt(): number {
    return this.rttMs;
  }

  get httpOrigin() {
    return this.serverOrigin;
  }

  get connectedUrl() {
    return this._url;
  }

  sendSetUsername(username: string) {
    this.send({ type: "set_username", username });
  }

  sendQuickplay(mode: GameMode = "casual", character?: number, awayCharacter?: number) {
    this.send({ type: "quickplay", mode, character, awayCharacter });
  }

  sendCreate(isPrivate: boolean = false, mode: GameMode = "casual", character?: number, awayCharacter?: number) {
    this.send({ type: "create", isPrivate, mode, character, awayCharacter });
  }

  sendSetWallet(address: string, verified?: boolean) {
    this.send({ type: "set_wallet", address, verified: !!verified });
  }

  sendJoinRoom(roomId: string, character?: number, awayCharacter?: number) {
    this.send({ type: "join_room", roomId, character, awayCharacter });
  }

  sendJoinByCode(code: string, character?: number, awayCharacter?: number) {
    this.send({ type: "join_code", code, character, awayCharacter });
  }

  /** Reset throttle state so next input sends immediately. Call on round/match start. */
  resetThrottle() {
    this.lastSentButtons = -1;
    this.lastSentAimX = -999;
    this.lastSentAimY = -999;
  }

  sendInput(input: PlayerInput, tick?: number) {
    const inputChanged =
      input.buttons !== this.lastSentButtons || input.aimX !== this.lastSentAimX || input.aimY !== this.lastSentAimY;
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

  sendLeave() {
    this.send({ type: "leave" });
  }

  sendCreateTournament(config?: TournamentConfig) {
    this.send({ type: "create_tournament", config });
  }

  sendStartTournament() {
    this.send({ type: "start_tournament" });
  }

  sendToggleRole() {
    this.send({ type: "toggle_role" });
  }

  sendUpdateTournamentConfig(config: Partial<TournamentConfig>) {
    this.send({ type: "update_tournament_config", config });
  }

  sendJoinTournamentByCode(code: string) {
    this.send({ type: "join_tournament_code", code });
  }

  disconnect() {
    this._intentionalClose = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.rttMs = 0;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  sendAddBot() {
    this.send({ type: "add_bot" });
  }

  private _tryReconnect() {
    const MAX_ATTEMPTS = 5;
    if (this._reconnectAttempts >= MAX_ATTEMPTS || !this._url) return;
    this._reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts - 1), 8000);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._intentionalClose) return;
      this._doConnect(this._url);
    }, delay);
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
