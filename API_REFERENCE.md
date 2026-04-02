# Chickenz API Reference

## HTTP Endpoints

All API responses include CORS headers. `OPTIONS` requests on any path return `204`.

### Rate Limiting

Endpoints under `/api/` are rate-limited per IP: **120 requests per 60-second window**. Exceeding this returns `429 Too Many Requests`.

### Public Endpoints

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| GET | `/api/ping` | Latency measurement (region ping) | `"ok"` (text) |
| GET | `/api/status` | Server status | `{ name, region, activeRooms, lobbyClients }` |
| GET | `/api/leaderboard` | Ranked ELO leaderboard | Array of leaderboard entries |
| GET | `/api/matches` | Recent match history (proof artifacts stripped) | Array of match records |
| GET | `/api/matches/:id/status` | Proof status for a match | `{ id, proofStatus }` |
| GET | `/api/matches/:id/proof` | Proof artifacts (seal, journal, imageId) | `{ seal, journal, imageId }` or `404` if not ready |
| GET | `/api/matches/:id/detail` | Full match detail + contract addresses | Match record + `contractAddress`, `verifierAddress`, `gameHubAddress` |
| GET | `/api/resolve-code/:code` | Check if a 5-letter join code exists on this server | `{ found: bool, type?: "room"\|"tournament" }` |
| GET | `/rooms` | List visible (non-private, non-ended) rooms | Array of `RoomInfo` |
| GET | `/transcript/:roomId` | Match transcript (replay data) | Transcript JSON, or `400` if in progress, or `404` |

### Wallet Verification

| Method | Path | Description | Request Body | Response |
|--------|------|-------------|-------------|----------|
| POST | `/api/wallet/register` | Verify wallet ownership via passkey assertion | `{ address, credentialId, publicKey?, assertion? }` | `{ verified: true, token }` or error |
| POST | `/api/wallet/revalidate` | Re-verify with a previously issued token (no passkey prompt) | `{ address, token }` | `{ verified: true\|false }` |

`address` must match `C[A-Z2-7]{55}`. The server derives the expected address from `credentialId` and rejects mismatches. Tokens expire after 24 hours.

### Match Settlement

| Method | Path | Description | Request Body | Response |
|--------|------|-------------|-------------|----------|
| POST | `/api/matches/:id/settle` | Notify server that a match was settled on-chain | `{ txHash }` (64 hex chars) | `{ ok: true, proofStatus: "settled" }` |

Only works when match `proofStatus` is `"verified"`. The server verifies the transaction on-chain before accepting.

### Relayer Proxy

| Method | Path | Description |
|--------|------|-------------|
| * | `/relayer/*` | Proxies to `channels.openzeppelin.com/*` with server-side `RELAYER_API_KEY` |

Used for passkey wallet creation. Origin-checked when `CORS_ORIGIN` is set. Returns `503` if `RELAYER_API_KEY` is not configured.

### Worker API (Bearer token auth)

All `/api/worker/*` endpoints require `Authorization: Bearer <WORKER_API_KEY>`.

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| GET | `/api/worker/poll` | Claim next pending proof job (also serves as heartbeat) | `{ matchId }` or `{ matchId: null }` |
| GET | `/api/worker/input/:matchId` | Download prover transcript for a claimed job | Transcript JSON |
| POST | `/api/worker/result/:matchId` | Submit proof result | `{ ok: true }` |
| GET | `/api/worker/status` | Check if worker is online (recent heartbeat) | `{ online: bool }` |

Worker result body: `{ seal, journal, imageId, boundlessRequestId?, boundlessTxHash? }`. Seal must be 512 or 520 hex chars, imageId 64 hex chars, journal 152 hex chars.

### Admin API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/admin/reprove/:matchId` | `X-Api-Key: <WORKER_API_KEY>` | Re-prove a stuck match from its stored transcript |

### Static Files

Any path not matching an API route serves from `services/server/public/`. Unknown paths fall back to `index.html` (SPA routing).

Raw IP access is redirected (301) to `CANONICAL_HOST` if configured.

---

## WebSocket Protocol

**Endpoint:** `ws(s)://<host>/ws`

All messages are JSON with a `type` field. Rate limit: **180 messages/second** per connection. Max message size: **4096 bytes**.

On connect, the server automatically sends a `lobby` message with the current room list.

### Client -> Server

#### Connection / Identity

| Type | Fields | Description |
|------|--------|-------------|
| `ping` | `t` (number, client timestamp) | RTT measurement |
| `set_username` | `username` (1-7 alphanumeric chars) | Set display name (validated, profanity-filtered) |
| `set_wallet` | `address` (Stellar address) | Associate wallet with connection (verified separately via HTTP) |
| `list_rooms` | _(none)_ | Request current room list |

#### Lobby / Matchmaking

| Type | Fields | Description |
|------|--------|-------------|
| `quickplay` | `mode?` ("casual"\|"ranked"), `character?`, `awayCharacter?` | Auto-match: join first waiting public room or create one |
| `create` | `isPrivate?`, `mode?`, `character?`, `awayCharacter?` | Create a new game room |
| `join_room` | `roomId`, `character?`, `awayCharacter?` | Join a room by ID |
| `join_code` | `code` (5-letter), `character?`, `awayCharacter?` | Join a room or tournament by join code |
| `add_bot` | _(none)_ | Add a bot opponent to your waiting room (casual only) |
| `leave` | _(none)_ | Leave current room or tournament |

Ranked mode requires a verified wallet (`/api/wallet/register` first). Character values: 0-3.

#### Game

| Type | Fields | Description |
|------|--------|-------------|
| `input` | `buttons` (bitmask 0-31), `aimX` (-1/0/1), `aimY` (-1/0/1), `tick?` | Player input each frame |

#### Tournament

| Type | Fields | Description |
|------|--------|-------------|
| `create_tournament` | `config?` (`{ bracketType, matchFormat }`) | Create a tournament lobby |
| `join_tournament_code` | `code` (5-letter) | Join a tournament by code |
| `start_tournament` | _(none)_ | Start the tournament (host only, 2-8 players required) |
| `toggle_role` | _(none)_ | Switch between player and spectator role |
| `update_tournament_config` | `config` (partial `{ bracketType?, matchFormat? }`) | Update tournament settings (host only) |

`bracketType`: `"winners_only"` | `"partial_consolation"` | `"full_consolation"`. `matchFormat`: `"bo3"` | `"bo5"`.

### Server -> Client

#### Connection

| Type | Fields | Description |
|------|--------|-------------|
| `pong` | `t` (echoed timestamp) | Response to `ping` |
| `error` | `message` | Error notification |
| `lobby` | `rooms` (array of `RoomInfo`) | Room list update (sent on connect and on changes) |

`RoomInfo`: `{ id, name, status, players, joinCode, isPrivate, mode, playerNames? }`

#### Game Lifecycle

| Type | Fields | When |
|------|--------|------|
| `waiting` | `roomId`, `roomName`, `joinCode` | Room created, waiting for opponent |
| `matched` | `playerId`, `seed`, `roomId`, `usernames`, `mapIndex`, `totalRounds`, `mode`, `characters` | Both players joined, game starting |
| `state` | `tick`, `players[]`, `projectiles[]`, `weaponPickups[]`, `scores`, `arenaLeft/Right`, `matchOver`, `winner`, `deathLingerTimer`, `rngState`, `nextProjectileId`, `lastButtons` | Authoritative state every tick during gameplay |
| `round_end` | `round`, `winner`, `roundWins` | A round finished |
| `round_start` | `round`, `seed`, `mapIndex` | New round beginning |
| `ended` | `winner`, `scores`, `roundWins`, `roomId`, `mode` | Match complete |

#### Tournament

| Type | Fields | When |
|------|--------|------|
| `tournament_lobby` | `tournamentId`, `joinCode`, `participants[]`, `config`, `hostSlot`, `mySlot`, `status`, `bracket?` | Tournament state update (lobby, in-progress, or ended) |
| `tournament_match_start` | `matchLabel`, `matchIndex`, `role`, `playerId?`, `seed`, `usernames`, `mapIndex`, `totalRounds`, `characters`, `bracket` | A bracket match is starting (sent to fighters and spectators) |
| `tournament_match_end` | `matchIndex`, `matchLabel`, `winnerName`, `bracket` | A bracket match finished |
| `tournament_end` | `standings[]`, `bracket` | Tournament complete with final placements |

#### Spectating (Tournament)

| Type | Fields | When |
|------|--------|------|
| `spectate_state` | _(same fields as `state`)_ | Tick state for spectators watching a tournament match |
| `spectate_round_end` | `round`, `winner`, `roundWins` | Round ended (spectator view) |
| `spectate_round_start` | `round`, `seed`, `mapIndex` | Round started (spectator view) |
