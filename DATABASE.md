# Database Schema Documentation

Source: `services/server/src/db.ts`

## Configuration

- **Engine**: SQLite via `bun:sqlite`
- **Journal mode**: WAL (`PRAGMA journal_mode=WAL`)
- **Data directory**: `services/server/data/` (created automatically)
- **File**: `services/server/data/chickenz.db`
- **Production path**: `/root/chickenz/services/server/data/chickenz.db`

## Tables

### `matches`

Stores all completed match records, proof artifacts, transcripts, and on-chain transaction references.

| Column | Type | Default | Description |
|---|---|---|---|
| `id` | TEXT | PK | Match ID (`match-<uuid>`) |
| `session_id` | INTEGER | | Server session counter |
| `room_name` | TEXT | | Human-readable room name |
| `player1` | TEXT | | Player 1 username |
| `player2` | TEXT | | Player 2 username |
| `wallet1` | TEXT | `''` | Player 1 Stellar wallet address |
| `wallet2` | TEXT | `''` | Player 2 Stellar wallet address |
| `winner` | INTEGER | | Winning player index (0 or 1) |
| `score1` | INTEGER | | Player 1 round wins |
| `score2` | INTEGER | | Player 2 round wins |
| `timestamp` | INTEGER | | Unix timestamp (ms) of match completion |
| `proof_status` | TEXT | `'none'` | ZK proof lifecycle: `none` / `pending` / `proving` / `verified` / `settled` |
| `proof_seal` | TEXT | | Groth16 seal (260 bytes hex) |
| `proof_journal` | TEXT | | ZK journal data (hex) |
| `proof_image_id` | TEXT | | RISC Zero guest image ID used for proof |
| `room_id` | TEXT | | Internal room identifier |
| `mode` | TEXT | `'casual'` | Game mode: `casual` or `ranked` |
| `match_start_time` | INTEGER | | Unix timestamp (ms) when match gameplay began |
| `proof_requested_at` | INTEGER | | Unix timestamp (ms) when proof was requested |
| `proof_completed_at` | INTEGER | | Unix timestamp (ms) when proof completed |
| `proof_source` | TEXT | | Where proof was generated (e.g. `local`, `boundless`, `worker`) |
| `start_tx_hash` | TEXT | | Soroban transaction hash for match start |
| `settle_tx_hash` | TEXT | | Soroban transaction hash for match settlement |
| `wallet1_verified` | INTEGER | `0` | Whether player 1 wallet was cryptographically verified (0/1) |
| `wallet2_verified` | INTEGER | `0` | Whether player 2 wallet was cryptographically verified (0/1) |
| `transcript_data` | TEXT | | Full match replay transcript (JSON string) |
| `transcript_cid` | TEXT | | IPFS CID of pinned transcript |
| `boundless_request_id` | TEXT | | Boundless marketplace proving request ID |
| `boundless_tx_hash` | TEXT | | Ethereum transaction hash from Boundless proof delivery |
| `bot_vs_bot` | INTEGER | `0` | Whether both players were bots (0/1) |
| `prover_transcript_data` | TEXT | | Prover-specific transcript data (JSON string) |

### `player_stats`

Ranked mode ELO ratings and win/loss records.

| Column | Type | Default | Description |
|---|---|---|---|
| `username` | TEXT | PK | Player username |
| `elo` | INTEGER | `1000` | Ranked ELO rating (K-factor = 32) |
| `wins` | INTEGER | `0` | Total ranked wins |
| `losses` | INTEGER | `0` | Total ranked losses |

### `casual_elo`

Casual mode ELO ratings (separate from ranked).

| Column | Type | Default | Description |
|---|---|---|---|
| `username` | TEXT | PK | Player username |
| `elo` | INTEGER | `800` | Casual ELO rating (K-factor = 24) |
| `games_played` | INTEGER | `0` | Total casual games played |
| `last_updated` | INTEGER | | Unix timestamp (ms) of last ELO update |

## Indexes

| Index | Table | Column(s) | Purpose |
|---|---|---|---|
| `idx_matches_room_id` | `matches` | `room_id` | Fast transcript lookup by room ID |

## Migrations

All migrations are idempotent (wrapped in try/catch for "column already exists"). They run on every server start.

| Migration | Column Added | Type | Default |
|---|---|---|---|
| 1 | `match_start_time` | INTEGER | |
| 2 | `proof_requested_at` | INTEGER | |
| 3 | `proof_completed_at` | INTEGER | |
| 4 | `proof_source` | TEXT | |
| 5 | `start_tx_hash` | TEXT | |
| 6 | `settle_tx_hash` | TEXT | |
| 7 | `wallet1_verified` | INTEGER | `0` |
| 8 | `wallet2_verified` | INTEGER | `0` |
| 9 | `transcript_data` | TEXT | |
| 10 | `transcript_cid` | TEXT | |
| 11 | `boundless_request_id` | TEXT | |
| 12 | `boundless_tx_hash` | TEXT | |
| 13 | `bot_vs_bot` | INTEGER | `0` |
| 14 | `prover_transcript_data` | TEXT | |

## Key Queries

### Match Operations

| Function | Query | Description |
|---|---|---|
| `insertMatch` | `INSERT INTO matches (...)` | Insert a completed match record |
| `getMatchById` | `SELECT * FROM matches WHERE id = $id` | Fetch single match by ID |
| `getRecentMatches` | `SELECT * FROM matches ORDER BY timestamp DESC LIMIT $limit` | Fetch N most recent matches (default 50) |
| `updateProofStatus` | `UPDATE matches SET proof_status = ...` | Update proof lifecycle status, optionally with seal/journal/imageId |

### Proof Timeline

| Function | Query | Description |
|---|---|---|
| `updateStartTxHash` | `UPDATE matches SET start_tx_hash = $hash WHERE id = $id` | Record Soroban start transaction |
| `updateSettleTxHash` | `UPDATE matches SET settle_tx_hash = $hash WHERE id = $id` | Record Soroban settle transaction |
| `updateProofTimestamps` | `UPDATE matches SET proof_requested_at, proof_completed_at, proof_source ...` | Record proof timing and source |
| `updateMatchStartTime` | `UPDATE matches SET match_start_time = $time WHERE id = $id` | Record when gameplay started |
| `updateWalletVerified` | `UPDATE matches SET wallet1_verified, wallet2_verified ...` | Record wallet verification status |

### Transcript Storage

| Function | Query | Description |
|---|---|---|
| `saveTranscript` | `UPDATE matches SET transcript_data = $data WHERE id = $id` | Save JSON replay transcript |
| `getTranscriptByMatchId` | `SELECT transcript_data FROM matches WHERE id = $id` | Fetch transcript by match ID |
| `getTranscriptByRoomId` | `SELECT transcript_data FROM matches WHERE room_id = $roomId ORDER BY timestamp DESC LIMIT 1` | Fetch most recent transcript for a room |
| `saveProverTranscript` | `UPDATE matches SET prover_transcript_data = $data WHERE id = $id` | Save prover-specific transcript |
| `getProverTranscript` | `SELECT prover_transcript_data FROM matches WHERE id = $id` | Fetch prover transcript |
| `updateTranscriptCid` | `UPDATE matches SET transcript_cid = $cid WHERE id = $id` | Record IPFS CID after pinning |

### Boundless Proving

| Function | Query | Description |
|---|---|---|
| `updateBoundlessRequestId` | `UPDATE matches SET boundless_request_id = $rid WHERE id = $id` | Record Boundless marketplace request ID |
| `updateBoundlessTxHash` | `UPDATE matches SET boundless_tx_hash = $hash WHERE id = $id` | Record Boundless proof delivery transaction |

### ELO (Ranked)

| Function | Query | Description |
|---|---|---|
| `updateElo` | Upsert `player_stats` for both players | Standard ELO calculation (K=32, default 1000, floor 0) |
| `getLeaderboard` | `SELECT * FROM player_stats ORDER BY elo DESC LIMIT $limit` | Top N players by ranked ELO (default 20) |
| `getPlayerStats` | `SELECT * FROM player_stats WHERE username = $username` | Single player's ranked stats |

### ELO (Casual)

| Function | Query | Description |
|---|---|---|
| `getCasualElo` | `SELECT elo FROM casual_elo WHERE username = $username` | Get casual ELO (default 800) |
| `updateCasualElo` | Upsert `casual_elo` | Casual ELO calculation (K=24, default 800, floor 0) |

## Data Retention

### Bot Transcript Pruning

`pruneBotVsBotTranscripts()` nullifies `transcript_data` for bot-vs-bot matches, keeping only the 100 most recent. This prevents unbounded storage growth from automated bot matches.

```sql
UPDATE matches SET transcript_data = NULL
WHERE bot_vs_bot = 1 AND transcript_data IS NOT NULL
AND id NOT IN (
  SELECT id FROM matches WHERE bot_vs_bot = 1 AND transcript_data IS NOT NULL
  ORDER BY timestamp DESC LIMIT 100
)
```

`markBotVsBot(matchId)` flags a match as bot-vs-bot (sets `bot_vs_bot = 1`).
