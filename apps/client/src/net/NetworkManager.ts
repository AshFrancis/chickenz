import type { GameState, PlayerInput, PlayerState, Projectile, WeaponPickup } from "@chickenz/sim";

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

export interface NetworkCallbacks {
  onWaiting: (roomId: string, roomName: string, joinCode: string) => void;
  onMatched: (playerId: number, seed: number, roomId: string, usernames: [string, string], mapIndex: number, totalRounds: number, mode: GameMode, characters: [number, number]) => void;
  onState: (state: GameState, lastButtons?: [number, number]) => void;
  onRoundEnd: (round: number, winner: number, roundWins: [number, number]) => void;
  onRoundStart: (round: number, seed: number, mapIndex: number) => void;
  onEnded: (winner: number, scores: [number, number], roundWins: [number, number], roomId: string, mode: GameMode) => void;
  onLobby: (rooms: RoomInfo[]) => void;
  onError: (message: string) => void;
  onDisconnect: () => void;
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
          this.callbacks.onState(deserializeState(msg), msg.lastButtons);
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

function deserializeState(msg: ServerMessage): GameState {
  const score = new Map<number, number>();
  score.set(0, (msg.scores ?? [0, 0])[0]);
  score.set(1, (msg.scores ?? [0, 0])[1]);

  return {
    tick: msg.tick!,
    players: msg.players!.map(
      (p: RawPlayerState): PlayerState => ({
        id: p.id,
        x: p.x,
        y: p.y,
        vx: p.vx,
        vy: p.vy,
        facing: p.facing as 1 | -1,
        health: p.health,
        lives: p.lives,
        shootCooldown: p.shootCooldown,
        grounded: p.grounded,
        stateFlags: p.stateFlags,
        respawnTimer: p.respawnTimer,
        weapon: p.weapon ?? null,
        ammo: p.ammo ?? 0,
        jumpsLeft: p.jumpsLeft ?? 2,
        wallSliding: p.wallSliding ?? false,
        wallDir: p.wallDir ?? 0,
        stompedBy: p.stompedBy ?? null,
        stompingOn: p.stompingOn ?? null,
        stompShakeProgress: p.stompShakeProgress ?? 0,
        stompLastShakeDir: 0,
        stompAutoRunDir: 1,
        stompAutoRunTimer: 0,
        stompCooldown: (p as any).stompCooldown ?? 0,
      }),
    ),
    projectiles: msg.projectiles!.map(
      (proj: RawProjectile): Projectile => ({
        id: proj.id,
        ownerId: proj.ownerId,
        x: proj.x,
        y: proj.y,
        vx: proj.vx,
        vy: proj.vy,
        lifetime: proj.lifetime,
        weapon: proj.weapon ?? 0,
      }),
    ),
    weaponPickups: (msg.weaponPickups ?? []).map(
      (wp: RawWeaponPickup): WeaponPickup => ({
        id: wp.id,
        x: wp.x,
        y: wp.y,
        weapon: wp.weapon,
        respawnTimer: wp.respawnTimer,
      }),
    ),
    rngState: msg.rngState ?? 0,
    score,
    nextProjectileId: msg.nextProjectileId ?? 0,
    arenaLeft: msg.arenaLeft!,
    arenaRight: msg.arenaRight!,
    matchOver: msg.matchOver!,
    winner: msg.winner!,
    deathLingerTimer: msg.deathLingerTimer ?? 0,
  };
}
