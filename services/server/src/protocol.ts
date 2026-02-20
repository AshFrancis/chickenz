import type { PlayerInput } from "@chickenz/sim";

// ── Client → Server ────────────────────────────────────────

export type GameMode = "casual" | "ranked";

export interface QuickplayMessage {
  type: "quickplay";
  mode?: GameMode;
}

export interface CreateRoomMessage {
  type: "create";
  isPrivate?: boolean;
  mode?: GameMode;
}

export interface SetWalletMessage {
  type: "set_wallet";
  address: string;
}

export interface JoinRoomMessage {
  type: "join_room";
  roomId: string;
}

export interface JoinCodeMessage {
  type: "join_code";
  code: string;
}

export interface InputMessage {
  type: "input";
  tick?: number;
  buttons: number;
  aimX: number;
  aimY: number;
}

export interface ListRoomsMessage {
  type: "list_rooms";
}

export interface SetUsernameMessage {
  type: "set_username";
  username: string;
}

export type ClientMessage =
  | QuickplayMessage
  | CreateRoomMessage
  | JoinRoomMessage
  | JoinCodeMessage
  | InputMessage
  | ListRoomsMessage
  | SetUsernameMessage
  | SetWalletMessage;

// ── Server → Client ────────────────────────────────────────

export interface WaitingMessage {
  type: "waiting";
  roomId: string;
  roomName: string;
  joinCode: string;
}

export interface MatchedMessage {
  type: "matched";
  playerId: number;
  seed: number;
  roomId: string;
  usernames: [string, string];
  mapIndex: number;
  totalRounds: number;
  mode: GameMode;
  characters: [number, number];
}

export interface RoundEndMessage {
  type: "round_end";
  round: number;
  winner: number;
  roundWins: [number, number];
}

export interface RoundStartMessage {
  type: "round_start";
  round: number;
  seed: number;
  mapIndex: number;
}

export interface StateMessage {
  type: "state";
  tick: number;
  players: SerializedPlayer[];
  projectiles: SerializedProjectile[];
  weaponPickups: SerializedWeaponPickup[];
  scores: [number, number];
  arenaLeft: number;
  arenaRight: number;
  matchOver: boolean;
  winner: number;
  deathLingerTimer: number;
  rngState: number;
  nextProjectileId: number;
  /** Last input buttons the server used for each player this tick (for reconciliation edge detection) */
  lastButtons: [number, number];
}

export interface EndedMessage {
  type: "ended";
  winner: number;
  scores: [number, number];
  roundWins: [number, number];
  roomId: string;
  mode: GameMode;
}

export interface RoomInfo {
  id: string;
  name: string;
  status: "waiting" | "playing" | "ended";
  players: number;
  joinCode: string;
  isPrivate: boolean;
  mode: GameMode;
}

export interface LobbyMessage {
  type: "lobby";
  rooms: RoomInfo[];
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export type ServerMessage =
  | WaitingMessage
  | MatchedMessage
  | StateMessage
  | EndedMessage
  | RoundEndMessage
  | RoundStartMessage
  | LobbyMessage
  | ErrorMessage;

// ── Serialized state sub-types ─────────────────────────────

export interface SerializedPlayer {
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
  weapon: number | null;
  ammo: number;
  jumpsLeft: number;
  wallSliding: boolean;
  wallDir: number;
  stompedBy: number | null;
  stompingOn: number | null;
  stompShakeProgress: number;
}

export interface SerializedProjectile {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  lifetime: number;
  weapon: number;
}

export interface SerializedWeaponPickup {
  id: number;
  x: number;
  y: number;
  weapon: number;
  respawnTimer: number;
}

// ── Helpers ────────────────────────────────────────────────

export function inputFromMessage(msg: InputMessage): PlayerInput {
  return { buttons: msg.buttons, aimX: msg.aimX, aimY: msg.aimY };
}

const JOIN_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O to avoid confusion

export function generateJoinCode(): string {
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += JOIN_CODE_CHARS[Math.floor(Math.random() * JOIN_CODE_CHARS.length)];
  }
  return code;
}
