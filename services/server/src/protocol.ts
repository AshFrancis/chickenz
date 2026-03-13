import type { PlayerInput } from "@chickenz/sim";

// ── Client → Server ────────────────────────────────────────

export type GameMode = "casual" | "ranked";
export type BracketType = "winners_only" | "partial_consolation" | "full_consolation";
export type MatchFormat = "bo3" | "bo5";

const VALID_BRACKET_TYPES: ReadonlySet<string> = new Set<BracketType>([
  "winners_only",
  "partial_consolation",
  "full_consolation",
]);
const VALID_MATCH_FORMATS: ReadonlySet<string> = new Set<MatchFormat>(["bo3", "bo5"]);

export function isValidBracketType(v: unknown): v is BracketType {
  return typeof v === "string" && VALID_BRACKET_TYPES.has(v);
}

export function isValidMatchFormat(v: unknown): v is MatchFormat {
  return typeof v === "string" && VALID_MATCH_FORMATS.has(v);
}

/** Validate and return a clean TournamentConfig, or undefined if nothing valid. */
export function validateTournamentConfig(raw: unknown): TournamentConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const bracketType = isValidBracketType(obj.bracketType) ? obj.bracketType : undefined;
  const matchFormat = isValidMatchFormat(obj.matchFormat) ? obj.matchFormat : undefined;
  if (!bracketType && !matchFormat) return undefined;
  return {
    bracketType: bracketType ?? "partial_consolation",
    matchFormat: matchFormat ?? "bo5",
  };
}

/** Validate a partial config update, returning only the valid fields. */
export function validatePartialTournamentConfig(raw: unknown): Partial<TournamentConfig> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const result: Partial<TournamentConfig> = {};
  if (isValidBracketType(obj.bracketType)) result.bracketType = obj.bracketType;
  if (isValidMatchFormat(obj.matchFormat)) result.matchFormat = obj.matchFormat;
  if (Object.keys(result).length === 0) return undefined;
  return result;
}

export interface TournamentConfig {
  bracketType: BracketType;
  matchFormat: MatchFormat;
}

export interface QuickplayMessage {
  type: "quickplay";
  mode?: GameMode;
  character?: number;
  awayCharacter?: number;
}

export interface CreateRoomMessage {
  type: "create";
  isPrivate?: boolean;
  mode?: GameMode;
  character?: number;
  awayCharacter?: number;
}

export interface SetWalletMessage {
  type: "set_wallet";
  address: string;
}

export interface JoinRoomMessage {
  type: "join_room";
  roomId: string;
  character?: number;
  awayCharacter?: number;
}

export interface JoinCodeMessage {
  type: "join_code";
  code: string;
  character?: number;
  awayCharacter?: number;
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

export interface CreateTournamentMessage {
  type: "create_tournament";
  config?: TournamentConfig;
}

export interface StartTournamentMessage {
  type: "start_tournament";
}

export interface ToggleRoleMessage {
  type: "toggle_role";
}

export interface UpdateTournamentConfigMessage {
  type: "update_tournament_config";
  config: Partial<TournamentConfig>;
}

export interface JoinTournamentCodeMessage {
  type: "join_tournament_code";
  code: string;
}

export interface LeaveMessage {
  type: "leave";
}

export interface AddBotMessage {
  type: "add_bot";
}

export interface PingMessage {
  type: "ping";
  t: number; // client timestamp (Date.now())
}

export type ClientMessage =
  | QuickplayMessage
  | CreateRoomMessage
  | JoinRoomMessage
  | JoinCodeMessage
  | InputMessage
  | ListRoomsMessage
  | SetUsernameMessage
  | SetWalletMessage
  | CreateTournamentMessage
  | StartTournamentMessage
  | ToggleRoleMessage
  | UpdateTournamentConfigMessage
  | JoinTournamentCodeMessage
  | LeaveMessage
  | AddBotMessage
  | PingMessage;

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
  playerNames?: string[];
}

export interface LobbyMessage {
  type: "lobby";
  rooms: RoomInfo[];
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

// ── Tournament messages ──────────────────────────────────

export type MatchSource =
  | { type: "seed"; seed: number }
  | { type: "winner"; matchIndex: number }
  | { type: "loser"; matchIndex: number }
  | { type: "bye" };

export interface BracketMatch {
  matchIndex: number;
  round: number;
  bracketSide: "winners" | "consolation" | "final" | "third_place";
  label: string;
  sourceA: MatchSource;
  sourceB: MatchSource;
  playerA?: { slot: number; name: string } | null;
  playerB?: { slot: number; name: string } | null;
  winner?: number; // slot of winner
  loser?: number; // slot of loser
  scores?: [number, number];
  status: "pending" | "ready" | "bye" | "playing" | "done";
}

export interface TournamentParticipant {
  slot: number;
  name: string;
  role: "player" | "spectator";
  connected: boolean;
}

export interface TournamentBracket {
  matches: BracketMatch[];
  playerNames: string[];
  config: TournamentConfig;
}

export interface TournamentLobbyMessage {
  type: "tournament_lobby";
  tournamentId: string;
  joinCode: string;
  participants: TournamentParticipant[];
  config: TournamentConfig;
  hostSlot: number;
  mySlot: number;
  status: "waiting" | "playing" | "ended";
  bracket?: TournamentBracket;
}

export interface TournamentMatchStartMessage {
  type: "tournament_match_start";
  matchLabel: string;
  matchIndex: number;
  role: "fighter" | "spectator";
  playerId?: number; // only for fighters (0 or 1)
  seed: number;
  usernames: [string, string];
  mapIndex: number;
  totalRounds: number;
  characters: [number, number];
  bracket: TournamentBracket;
}

export interface SpectateStateMessage {
  type: "spectate_state";
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
  lastButtons: [number, number];
}

export interface SpectateRoundEndMessage {
  type: "spectate_round_end";
  round: number;
  winner: number;
  roundWins: [number, number];
}

export interface SpectateRoundStartMessage {
  type: "spectate_round_start";
  round: number;
  seed: number;
  mapIndex: number;
}

export interface TournamentMatchEndMessage {
  type: "tournament_match_end";
  matchIndex: number;
  matchLabel: string;
  winnerName: string;
  bracket: TournamentBracket;
}

export interface TournamentEndMessage {
  type: "tournament_end";
  standings: { place: number; name: string }[];
  bracket: TournamentBracket;
}

export interface PongMessage {
  type: "pong";
  t: number; // echoed client timestamp
}

export type ServerMessage =
  | WaitingMessage
  | MatchedMessage
  | StateMessage
  | EndedMessage
  | RoundEndMessage
  | RoundStartMessage
  | LobbyMessage
  | ErrorMessage
  | PongMessage
  | TournamentLobbyMessage
  | TournamentMatchStartMessage
  | SpectateStateMessage
  | SpectateRoundEndMessage
  | SpectateRoundStartMessage
  | TournamentMatchEndMessage
  | TournamentEndMessage;

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
  stompCooldown: number;
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
  const buttons = (Number.isFinite(msg.buttons) ? msg.buttons : 0) & 0x1f;
  const aimX = msg.aimX === 1 ? 1 : msg.aimX === -1 ? -1 : 0;
  const aimY = msg.aimY === 1 ? 1 : msg.aimY === -1 ? -1 : 0;
  return { buttons, aimX, aimY };
}

const JOIN_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O to avoid confusion

export function generateJoinCode(): string {
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += JOIN_CODE_CHARS[Math.floor(Math.random() * JOIN_CODE_CHARS.length)];
  }
  return code;
}
