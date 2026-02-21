import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname, join } from "path";

// ── Types ─────────────────────────────────────────────────

export interface MatchRecord {
  id: string;
  sessionId: number;
  roomName: string;
  player1: string;
  player2: string;
  wallet1: string;
  wallet2: string;
  winner: number;
  scores: [number, number];
  timestamp: number;
  proofStatus: "none" | "pending" | "proving" | "verified" | "settled";
  roomId: string;
  mode: string;
  proofArtifacts?: { seal: string; journal: string; imageId: string };
  matchStartTime?: number;
  proofRequestedAt?: number;
  proofCompletedAt?: number;
  proofSource?: string;
  startTxHash?: string;
  settleTxHash?: string;
  wallet1Verified?: boolean;
  wallet2Verified?: boolean;
}

export interface LeaderboardEntry {
  name: string;
  elo: number;
  wins: number;
  losses: number;
}

export interface ProofArtifacts {
  seal: string;
  journal: string;
  imageId: string;
}

// ── Database init ─────────────────────────────────────────

const DATA_DIR = join(dirname(import.meta.dir), "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, "chickenz.db"));
db.exec("PRAGMA journal_mode=WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    session_id INTEGER,
    room_name TEXT,
    player1 TEXT,
    player2 TEXT,
    wallet1 TEXT DEFAULT '',
    wallet2 TEXT DEFAULT '',
    winner INTEGER,
    score1 INTEGER,
    score2 INTEGER,
    timestamp INTEGER,
    proof_status TEXT DEFAULT 'none',
    proof_seal TEXT,
    proof_journal TEXT,
    proof_image_id TEXT,
    room_id TEXT,
    mode TEXT DEFAULT 'casual'
  );

  CREATE TABLE IF NOT EXISTS player_stats (
    username TEXT PRIMARY KEY,
    elo INTEGER DEFAULT 1000,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0
  );
`);

// ── Schema migrations (idempotent) ───────────────────────
const migrations = [
  "ALTER TABLE matches ADD COLUMN match_start_time INTEGER",
  "ALTER TABLE matches ADD COLUMN proof_requested_at INTEGER",
  "ALTER TABLE matches ADD COLUMN proof_completed_at INTEGER",
  "ALTER TABLE matches ADD COLUMN proof_source TEXT",
  "ALTER TABLE matches ADD COLUMN start_tx_hash TEXT",
  "ALTER TABLE matches ADD COLUMN settle_tx_hash TEXT",
  "ALTER TABLE matches ADD COLUMN wallet1_verified INTEGER DEFAULT 0",
  "ALTER TABLE matches ADD COLUMN wallet2_verified INTEGER DEFAULT 0",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch { /* column already exists */ }
}

// ── Prepared statements ───────────────────────────────────

const stmtInsert = db.prepare(`
  INSERT INTO matches (id, session_id, room_name, player1, player2, wallet1, wallet2, winner, score1, score2, timestamp, proof_status, room_id, mode)
  VALUES ($id, $sessionId, $roomName, $player1, $player2, $wallet1, $wallet2, $winner, $score1, $score2, $timestamp, $proofStatus, $roomId, $mode)
`);

const stmtUpdateProof = db.prepare(`
  UPDATE matches SET proof_status = $status, proof_seal = $seal, proof_journal = $journal, proof_image_id = $imageId
  WHERE id = $id
`);

const stmtUpdateStatus = db.prepare(`
  UPDATE matches SET proof_status = $status WHERE id = $id
`);

const stmtGetRecent = db.prepare(`
  SELECT * FROM matches ORDER BY timestamp DESC LIMIT $limit
`);

const stmtGetById = db.prepare(`
  SELECT * FROM matches WHERE id = $id
`);

const stmtUpsertPlayer = db.prepare(`
  INSERT INTO player_stats (username, elo, wins, losses) VALUES ($username, $elo, $wins, $losses)
  ON CONFLICT(username) DO UPDATE SET elo = $elo, wins = $wins, losses = $losses
`);

const stmtGetPlayer = db.prepare(`
  SELECT * FROM player_stats WHERE username = $username
`);

const stmtLeaderboard = db.prepare(`
  SELECT * FROM player_stats ORDER BY elo DESC LIMIT $limit
`);

// ── Helpers ───────────────────────────────────────────────

function rowToMatch(row: any): MatchRecord {
  const record: MatchRecord = {
    id: row.id,
    sessionId: row.session_id,
    roomName: row.room_name,
    player1: row.player1,
    player2: row.player2,
    wallet1: row.wallet1 || "",
    wallet2: row.wallet2 || "",
    winner: row.winner,
    scores: [row.score1, row.score2],
    timestamp: row.timestamp,
    proofStatus: row.proof_status,
    roomId: row.room_id,
    mode: row.mode,
  };
  if (row.proof_seal) {
    record.proofArtifacts = {
      seal: row.proof_seal,
      journal: row.proof_journal,
      imageId: row.proof_image_id,
    };
  }
  if (row.match_start_time) record.matchStartTime = row.match_start_time;
  if (row.proof_requested_at) record.proofRequestedAt = row.proof_requested_at;
  if (row.proof_completed_at) record.proofCompletedAt = row.proof_completed_at;
  if (row.proof_source) record.proofSource = row.proof_source;
  if (row.start_tx_hash) record.startTxHash = row.start_tx_hash;
  if (row.settle_tx_hash) record.settleTxHash = row.settle_tx_hash;
  record.wallet1Verified = !!row.wallet1_verified;
  record.wallet2Verified = !!row.wallet2_verified;
  return record;
}

// ── Match CRUD ────────────────────────────────────────────

export function generateMatchId(): string {
  return `match-${crypto.randomUUID().slice(0, 8)}`;
}

export function insertMatch(record: MatchRecord): void {
  stmtInsert.run({
    $id: record.id,
    $sessionId: record.sessionId,
    $roomName: record.roomName,
    $player1: record.player1,
    $player2: record.player2,
    $wallet1: record.wallet1,
    $wallet2: record.wallet2,
    $winner: record.winner,
    $score1: record.scores[0],
    $score2: record.scores[1],
    $timestamp: record.timestamp,
    $proofStatus: record.proofStatus,
    $roomId: record.roomId,
    $mode: record.mode,
  });
}

export function updateProofStatus(matchId: string, status: string, artifacts?: ProofArtifacts): void {
  if (artifacts) {
    stmtUpdateProof.run({
      $id: matchId,
      $status: status,
      $seal: artifacts.seal,
      $journal: artifacts.journal,
      $imageId: artifacts.imageId,
    });
  } else {
    stmtUpdateStatus.run({ $id: matchId, $status: status });
  }
}

export function getRecentMatches(limit: number = 50): MatchRecord[] {
  const rows = stmtGetRecent.all({ $limit: limit }) as any[];
  return rows.map(rowToMatch);
}

export function getMatchById(id: string): MatchRecord | null {
  const row = stmtGetById.get({ $id: id }) as any;
  if (!row) return null;
  return rowToMatch(row);
}

// ── ELO ───────────────────────────────────────────────────

const K = 32;
const DEFAULT_ELO = 1000;

function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function getOrCreatePlayer(username: string): { elo: number; wins: number; losses: number } {
  const row = stmtGetPlayer.get({ $username: username }) as any;
  if (row) return { elo: row.elo, wins: row.wins, losses: row.losses };
  return { elo: DEFAULT_ELO, wins: 0, losses: 0 };
}

export function updateElo(winnerName: string, loserName: string): { winnerElo: number; loserElo: number } {
  const winner = getOrCreatePlayer(winnerName);
  const loser = getOrCreatePlayer(loserName);

  const expectedW = expectedScore(winner.elo, loser.elo);
  const expectedL = expectedScore(loser.elo, winner.elo);

  winner.elo = Math.round(winner.elo + K * (1 - expectedW));
  loser.elo = Math.round(loser.elo + K * (0 - expectedL));
  winner.wins++;
  loser.losses++;

  stmtUpsertPlayer.run({ $username: winnerName, $elo: winner.elo, $wins: winner.wins, $losses: winner.losses });
  stmtUpsertPlayer.run({ $username: loserName, $elo: loser.elo, $wins: loser.wins, $losses: loser.losses });

  return { winnerElo: winner.elo, loserElo: loser.elo };
}

export function getLeaderboard(limit: number = 20): LeaderboardEntry[] {
  const rows = stmtLeaderboard.all({ $limit: limit }) as any[];
  return rows.map((r) => ({ name: r.username, elo: r.elo, wins: r.wins, losses: r.losses }));
}

export function getPlayerStats(name: string): LeaderboardEntry | null {
  const row = stmtGetPlayer.get({ $username: name }) as any;
  if (!row) return null;
  return { name: row.username, elo: row.elo, wins: row.wins, losses: row.losses };
}

// ── Timeline update functions ────────────────────────────

const stmtUpdateStartTx = db.prepare(`UPDATE matches SET start_tx_hash = $hash WHERE id = $id`);
const stmtUpdateSettleTx = db.prepare(`UPDATE matches SET settle_tx_hash = $hash WHERE id = $id`);
const stmtUpdateProofTimestamps = db.prepare(`
  UPDATE matches SET proof_requested_at = $requestedAt, proof_completed_at = $completedAt, proof_source = $source
  WHERE id = $id
`);
const stmtUpdateMatchStartTime = db.prepare(`UPDATE matches SET match_start_time = $time WHERE id = $id`);
const stmtUpdateWalletVerified = db.prepare(`
  UPDATE matches SET wallet1_verified = $w1, wallet2_verified = $w2 WHERE id = $id
`);

export function updateStartTxHash(matchId: string, hash: string) {
  stmtUpdateStartTx.run({ $id: matchId, $hash: hash });
}

export function updateSettleTxHash(matchId: string, hash: string) {
  stmtUpdateSettleTx.run({ $id: matchId, $hash: hash });
}

export function updateProofTimestamps(matchId: string, requestedAt: number, completedAt: number, source: string) {
  stmtUpdateProofTimestamps.run({ $id: matchId, $requestedAt: requestedAt, $completedAt: completedAt, $source: source });
}

export function updateMatchStartTime(matchId: string, time: number) {
  stmtUpdateMatchStartTime.run({ $id: matchId, $time: time });
}

export function updateWalletVerified(matchId: string, w1: boolean, w2: boolean) {
  stmtUpdateWalletVerified.run({ $id: matchId, $w1: w1 ? 1 : 0, $w2: w2 ? 1 : 0 });
}
