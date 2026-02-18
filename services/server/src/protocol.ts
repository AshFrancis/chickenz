import type { PlayerInput } from "@chickenz/sim";

// ── Client → Server ────────────────────────────────────────

export interface QuickplayMessage {
  type: "quickplay";
}

export interface CreateRoomMessage {
  type: "create";
  isPrivate?: boolean;
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
  | SetUsernameMessage;

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
}

export interface EndedMessage {
  type: "ended";
  winner: number;
  scores: [number, number];
  roundWins: [number, number];
  roomId: string;
}

export interface RoomInfo {
  id: string;
  name: string;
  status: "waiting" | "playing" | "ended";
  players: number;
  joinCode: string;
  isPrivate: boolean;
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
