import type { ServerWebSocket } from "bun";
import { GameRoom, type SocketData } from "./GameRoom";
import { TournamentRoom } from "./TournamentRoom";
import type { ClientMessage, RoomInfo, GameMode } from "./protocol";
import { startMatchOnChain, settleMatchOnChain, verifySignature } from "./stellar";
import { proveMatch, claimNextJob, getJobTranscript, submitJobResult, getJob, workerHeartbeat, isWorkerOnline, type ProofArtifacts } from "./prover";
import { updateElo, getLeaderboard, insertMatch, updateProofStatus, getRecentMatches, getMatchById, generateMatchId, updateStartTxHash, updateSettleTxHash, updateProofTimestamps, updateMatchStartTime, updateWalletVerified, saveTranscript, getTranscriptByRoomId, updateTranscriptCid, updateBoundlessRequestId, type MatchRecord } from "./db";
import { normalize, resolve } from "path";

const PORT = Number(process.env.PORT) || 3000;
const BOT_JOIN_DELAY_MS = 16_000; // delay before bot auto-joins casual room

// ── Startup env validation ─────────────────────────────────
{
  const features: string[] = [];
  const warnings: string[] = [];

  if (process.env.STELLAR_ADMIN_SECRET) {
    features.push("on-chain settlement (start_match + auto-settle)");
  } else {
    warnings.push("STELLAR_ADMIN_SECRET not set — on-chain features disabled");
  }

  if (process.env.WORKER_API_KEY) {
    features.push("remote proof worker API");
  } else {
    warnings.push("WORKER_API_KEY not set — remote proof worker disabled");
  }

  if (process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== "*") {
    features.push(`CORS restricted to ${process.env.CORS_ORIGIN}`);
  }

  if (warnings.length > 0) {
    console.warn("[env] Warnings:");
    for (const w of warnings) console.warn(`  - ${w}`);
  }
  if (features.length > 0) {
    console.log("[env] Enabled features:");
    for (const f of features) console.log(`  + ${f}`);
  }
}

// ── State ──────────────────────────────────────────────────

const rooms = new Map<string, GameRoom>();
const tournaments = new Map<string, TournamentRoom>();
const lobbySockets = new Set<ServerWebSocket<SocketData>>();

function generateRoomId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function getVisibleRooms(): RoomInfo[] {
  const list: RoomInfo[] = [];
  for (const room of rooms.values()) {
    if (!room.isEnded() && !room.isPrivate) {
      list.push(room.toInfo());
    }
  }
  return list;
}

function broadcastLobby() {
  const msg = JSON.stringify({ type: "lobby", rooms: getVisibleRooms() });
  for (const ws of lobbySockets) {
    try {
      ws.send(msg);
    } catch {
      lobbySockets.delete(ws);
    }
  }
}

function sendLobby(ws: ServerWebSocket<SocketData>) {
  try {
    ws.send(JSON.stringify({ type: "lobby", rooms: getVisibleRooms() }));
  } catch {
    // socket closed
  }
}

/** Auto-settle a match on-chain after proof is verified. */
function autoSettleMatch(matchId: string, sessionId: number, artifacts: ProofArtifacts) {
  if (!process.env.STELLAR_ADMIN_SECRET) return;
  const sealBytes = new Uint8Array(Buffer.from(artifacts.seal, "hex"));
  const journalBytes = new Uint8Array(Buffer.from(artifacts.journal, "hex"));
  settleMatchOnChain(sessionId, sealBytes, journalBytes)
    .then((hash) => {
      updateProofStatus(matchId, "settled");
      if (hash) updateSettleTxHash(matchId, hash);
    })
    .catch((err) => {
      console.error("Auto-settle failed:", err);
      updateProofStatus(matchId, "verified"); // revert to verified so manual settle can retry
    });
}

/** Pin transcript JSON to IPFS via Pinata and store the CID. */
async function pinTranscriptToIPFS(matchId: string, transcript: object) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) return;
  try {
    const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        pinataContent: transcript,
        pinataMetadata: { name: `chickenz-transcript-${matchId}` },
      }),
    });
    if (!res.ok) {
      console.error(`[ipfs] Pinata pin failed for ${matchId}: ${res.status}`);
      return;
    }
    const data = await res.json() as { IpfsHash: string };
    const cid = data.IpfsHash;
    updateTranscriptCid(matchId, cid);
    console.log(`[ipfs] Transcript pinned for ${matchId}: ${cid}`);
  } catch (err) {
    console.error(`[ipfs] Failed to pin transcript for ${matchId}:`, err);
  }
}

function returnToLobby(sockets: ServerWebSocket<SocketData>[], winner: number, roomId: string, roomName: string, scores: [number, number], mode: GameMode) {
  const room = rooms.get(roomId);

  // Only update ELO for ranked matches with sufficient input activity (never bots)
  if (mode === "ranked" && !room?.isBotMatch && sockets.length === 2 && winner >= 0 && winner <= 1) {
    const winnerName = sockets[winner]?.data.username;
    const loserName = sockets[1 - winner]?.data.username;
    if (winnerName && loserName) {
      const activity = room?.getInputActivity() ?? [0, 0];
      // Minimum button-state changes required from each player before ELO updates.
      // Prevents farming via AFK alts. Set to 0 to disable (useful for testing).
      // A real match typically produces 100+ changes; 30 is a safe production threshold.
      const MIN_INPUT_CHANGES = 30;
      if (activity[0] >= MIN_INPUT_CHANGES && activity[1] >= MIN_INPUT_CHANGES) {
        updateElo(winnerName, loserName);
      }
    }
  }

  // Record match history
  if (sockets.length === 2) {
    const matchId = generateMatchId();
    const sessionId = room?.sessionId || (Date.now() >>> 0);
    const record: MatchRecord = {
      id: matchId,
      sessionId,
      roomName,
      player1: sockets[0]?.data.username || "Player 1",
      player2: (room?.isBotMatch ? "[BOT] " : "") + (sockets[1]?.data.username || "Player 2"),
      wallet1: sockets[0]?.data.walletAddress || "",
      wallet2: sockets[1]?.data.walletAddress || "",
      winner,
      scores,
      timestamp: Date.now(),
      proofStatus: mode === "ranked" ? "pending" : "none",
      roomId,
      mode,
    };

    // Set match start time from room
    if (room) {
      record.matchStartTime = room.matchStartTime;
    }

    // Store wallet verification status
    record.wallet1Verified = !!sockets[0]?.data.walletVerified;
    record.wallet2Verified = !!sockets[1]?.data.walletVerified;

    // Trigger proving for ranked matches (never bots)
    if (mode === "ranked" && !room?.isBotMatch && room) {
      record.proofStatus = "proving";
      const transcript = room.getTranscript();
      const proofRequestedAt = Date.now();
      const onProofResult = (artifacts: ProofArtifacts | null, source?: string) => {
        if (artifacts) {
          updateProofTimestamps(matchId, proofRequestedAt, Date.now(), source || "unknown");
          updateProofStatus(matchId, "verified", artifacts);
          if (artifacts.boundlessRequestId) {
            updateBoundlessRequestId(matchId, artifacts.boundlessRequestId);
          }
          autoSettleMatch(matchId, sessionId, artifacts);
        } else {
          updateProofStatus(matchId, "pending");
        }
      };
      proveMatch(matchId, transcript, onProofResult);
    }

    insertMatch(record);

    // Apply startTxHash after insert so the UPDATE finds the row
    if (room?.startTxHash) {
      updateStartTxHash(matchId, room.startTxHash);
    }

    // Save full transcript for replays (persists beyond room cleanup)
    if (room) {
      const fullTranscript = room.getFullTranscript();
      saveTranscript(matchId, fullTranscript);
      // Pin to IPFS for immutable data availability (async, non-blocking)
      pinTranscriptToIPFS(matchId, fullTranscript);
    }

    // Store timeline fields that insertMatch doesn't cover
    if (record.matchStartTime) updateMatchStartTime(matchId, record.matchStartTime);
    if (record.wallet1Verified || record.wallet2Verified) {
      updateWalletVerified(matchId, !!record.wallet1Verified, !!record.wallet2Verified);
    }
  }

  for (const ws of sockets) {
    lobbySockets.add(ws);
    sendLobby(ws);
  }

  // Schedule room cleanup (keeps transcript accessible for 2 minutes)
  cleanupRoom(roomId);
  broadcastLobby();
}

/** Register match on-chain when gameplay starts (before any rounds). */
function onMatchStarted(room: GameRoom) {
  if (room.mode !== "ranked" || room.isBotMatch) return;
  const [w1, w2] = room.walletAddresses;
  if (!w1 || !w2 || !process.env.STELLAR_ADMIN_SECRET) return;
  const seedBytes = new Uint8Array(4);
  new DataView(seedBytes.buffer).setUint32(0, room.currentSeed, true);
  const seedCommit = new Uint8Array(new Bun.CryptoHasher("sha256").update(seedBytes).digest());
  startMatchOnChain(room.sessionId, w1, w2, seedCommit)
    .then((hash) => { if (hash) room.startTxHash = hash; })
    .catch(() => {});
}

function cleanupRoom(roomId: string) {
  const room = rooms.get(roomId);
  if (room?.isEnded()) {
    broadcastLobby();
    // Keep transcript accessible for 2 minutes, then delete
    setTimeout(() => rooms.delete(roomId), 2 * 60 * 1000);
  }
}

function findRoomByJoinCode(code: string): GameRoom | undefined {
  const upperCode = code.toUpperCase();
  for (const room of rooms.values()) {
    if (room.joinCode === upperCode && room.isWaiting()) {
      return room;
    }
  }
  return undefined;
}

// ── Username validation ───────────────────────────────────

const PROFANITY_LIST = new Set([
  "fuck", "shit", "ass", "bitch", "dick", "cock", "pussy", "cunt",
  "fag", "nigger", "nigga", "retard", "whore", "slut",
  "damn", "piss", "twat", "wanker", "arse", "bollock",
  "bugger", "chink", "coon", "dyke", "feck", "homo",
  "jizz", "kike", "knob", "muff", "nig", "prick",
  "spic", "tit", "turd", "anal", "anus", "balls",
  "boob", "dildo", "douche", "erect", "felch", "fudge",
  "gtfo", "handjob", "horny", "jackoff", "jerkoff", "milf",
  "nazi", "nude", "nutsack", "orgasm", "penis", "porn",
  "pube", "rape", "scrotum", "semen", "sex", "skank",
  "spunk", "stfu", "testicle", "vagina", "vulva",
]);

function normalizeLeetSpeak(s: string): string {
  return s.toLowerCase()
    .replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e")
    .replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t")
    .replace(/@/g, "a").replace(/\$/g, "s").replace(/!/g, "i");
}

function isValidUsername(name: string): boolean {
  if (name.length < 1 || name.length > 7) return false;
  if (!/^[a-zA-Z0-9_]+$/.test(name)) return false;
  const lower = name.toLowerCase();
  const normalized = normalizeLeetSpeak(name);
  for (const word of PROFANITY_LIST) {
    if (lower.includes(word) || normalized.includes(word)) return false;
  }
  return true;
}

// ── Server ─────────────────────────────────────────────────

const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || "*";
const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const server = Bun.serve<SocketData>({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Redirect raw IP access to domain
    const host = req.headers.get("host") || "";
    if (host.startsWith("178.156.244.26")) {
      return new Response(null, {
        status: 301,
        headers: {
          "Location": `https://chickenz.io${url.pathname}${url.search}`,
          "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
        },
      });
    }

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, {
        data: { roomId: null, playerId: -1, username: "", walletAddress: "", character: 0, awayCharacter: 1, tournamentId: null, msgCount: 0, msgResetTime: Date.now() },
      });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", {
          status: 400,
          headers: corsHeaders,
        });
      }
      return undefined;
    }

    // Room list (HTTP)
    if (url.pathname === "/rooms") {
      return Response.json(getVisibleRooms(), { headers: corsHeaders });
    }

    // Transcript endpoint
    const transcriptMatch = url.pathname.match(/^\/transcript\/(.+)$/);
    if (transcriptMatch) {
      const roomId = transcriptMatch[1]!;
      // Try in-memory room first (still active or recently ended)
      const room = rooms.get(roomId);
      if (room) {
        if (!room.isEnded()) {
          return Response.json({ error: "Match still in progress" }, { status: 400, headers: corsHeaders });
        }
        return Response.json(room.getFullTranscript(), { headers: corsHeaders });
      }
      // Fall back to DB (room already cleaned up)
      const saved = getTranscriptByRoomId(roomId);
      if (saved) {
        return Response.json(saved, { headers: corsHeaders });
      }
      return Response.json({ error: "Transcript not found" }, { status: 404, headers: corsHeaders });
    }

    // Leaderboard endpoint
    if (url.pathname === "/api/leaderboard") {
      return Response.json(getLeaderboard(), { headers: corsHeaders });
    }

    // Match history endpoints
    if (url.pathname === "/api/matches") {
      return Response.json(getRecentMatches(), { headers: corsHeaders });
    }
    const matchStatusMatch = url.pathname.match(/^\/api\/matches\/(.+)\/status$/);
    if (matchStatusMatch) {
      const matchId = matchStatusMatch[1]!;
      const record = getMatchById(matchId);
      if (!record) {
        return Response.json({ error: "Match not found" }, { status: 404, headers: corsHeaders });
      }
      return Response.json({ id: record.id, proofStatus: record.proofStatus }, { headers: corsHeaders });
    }
    const matchProofMatch = url.pathname.match(/^\/api\/matches\/(.+)\/proof$/);
    if (matchProofMatch) {
      const matchId = matchProofMatch[1]!;
      const record = getMatchById(matchId);
      if (!record) {
        return Response.json({ error: "Match not found" }, { status: 404, headers: corsHeaders });
      }
      if (!record.proofArtifacts) {
        return Response.json({ error: "Proof not yet available" }, { status: 404, headers: corsHeaders });
      }
      return Response.json(record.proofArtifacts, { headers: corsHeaders });
    }
    // ── Match detail endpoint ──────────────────────────────
    const matchDetailMatch = url.pathname.match(/^\/api\/matches\/(.+)\/detail$/);
    if (matchDetailMatch) {
      const matchId = matchDetailMatch[1]!;
      const record = getMatchById(matchId);
      if (!record) {
        return Response.json({ error: "Match not found" }, { status: 404, headers: corsHeaders });
      }
      return Response.json({
        ...record,
        contractAddress: "CDYU5GFNDBIFYWLW54QV3LPDNQTER6ID3SK4QCCBVUY7NU76ESBP7LZP",
        verifierAddress: "CDUDXCLMNE7Q4BZJLLB3KACFOS55SS55GSQW2UYHDUXTJKZUDDAJYCIH",
        gameHubAddress: "CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG",
      }, { headers: corsHeaders });
    }

    // ── Client-triggered settle notification ──────────────
    const matchSettleMatch = url.pathname.match(/^\/api\/matches\/(.+)\/settle$/);
    if (req.method === "POST" && matchSettleMatch) {
      const matchId = matchSettleMatch[1]!;
      const record = getMatchById(matchId);
      if (!record) {
        return Response.json({ error: "Match not found" }, { status: 404, headers: corsHeaders });
      }
      const body = await req.json().catch(() => ({} as any));
      const txHash = body?.txHash;
      if (!txHash || typeof txHash !== "string" || txHash.length < 10) {
        return Response.json({ error: "txHash required" }, { status: 400, headers: corsHeaders });
      }
      if (record.proofStatus === "verified") {
        updateProofStatus(matchId, "settled");
        updateSettleTxHash(matchId, txHash);
      }
      return Response.json({ ok: true, proofStatus: record.proofStatus }, { headers: corsHeaders });
    }

    // ── Wallet challenge/verify endpoints ─────────────────
    if (url.pathname === "/api/wallet/challenge") {
      const addr = url.searchParams.get("address") ?? "";
      if (!addr || !/^G[A-Z2-7]{55}$/.test(addr)) {
        return Response.json({ error: "Invalid address" }, { status: 400, headers: corsHeaders });
      }
      const challenge = `chickenz-auth:${crypto.randomUUID()}:${Date.now()}`;
      return Response.json({ challenge }, { headers: corsHeaders });
    }

    if (req.method === "POST" && url.pathname === "/api/wallet/verify") {
      try {
        const body = await req.json() as { address: string; challenge: string; signature: string };
        if (!body.address || !body.challenge || !body.signature) {
          return Response.json({ error: "Missing fields" }, { status: 400, headers: corsHeaders });
        }
        if (!/^G[A-Z2-7]{55}$/.test(body.address)) {
          return Response.json({ error: "Invalid address" }, { status: 400, headers: corsHeaders });
        }
        // Extract the original challenge token from the signed message
        const challengeMatch = body.challenge.match(/chickenz-auth:[^:\s]+:\d+/);
        if (!challengeMatch) {
          return Response.json({ error: "Invalid challenge" }, { status: 400, headers: corsHeaders });
        }
        const challengeToken = challengeMatch[0]!;
        // Validate challenge freshness (5 min window)
        const parts = challengeToken.split(":");
        const challengeTs = parseInt(parts[2] ?? "0", 10);
        if (isNaN(challengeTs) || Date.now() - challengeTs > 5 * 60 * 1000) {
          return Response.json({ error: "Challenge expired" }, { status: 400, headers: corsHeaders });
        }
        const verified = verifySignature(body.address, body.challenge, body.signature);
        // Mark matching WebSocket connections as verified server-side
        if (verified) {
          for (const ws of lobbySockets) {
            if (ws.data.walletAddress === body.address) {
              ws.data.walletVerified = true;
            }
          }
        }
        return Response.json({ verified }, { headers: corsHeaders });
      } catch {
        return Response.json({ error: "Invalid body" }, { status: 400, headers: corsHeaders });
      }
    }

    // ── Worker API (prover worker polls these) ──────────────

    // Worker API authentication (always required)
    if (url.pathname.startsWith("/api/worker/")) {
      const workerKey = process.env.WORKER_API_KEY;
      const auth = req.headers.get("Authorization");
      if (!workerKey || auth !== `Bearer ${workerKey}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
      }
    }

    // Worker polls this — also serves as heartbeat
    if (url.pathname === "/api/worker/poll") {
      const job = claimNextJob();
      if (job) {
        return Response.json({ matchId: job.matchId }, { headers: corsHeaders });
      }
      return Response.json({ matchId: null }, { headers: corsHeaders });
    }

    // Worker downloads transcript for a claimed job
    const workerInputMatch = url.pathname.match(/^\/api\/worker\/input\/(.+)$/);
    if (workerInputMatch) {
      const matchId = workerInputMatch[1]!;
      const transcript = getJobTranscript(matchId);
      if (!transcript) {
        return Response.json({ error: "Job not found" }, { status: 404, headers: corsHeaders });
      }
      return Response.json(transcript, { headers: corsHeaders });
    }

    // Worker submits proof result
    if (req.method === "POST" && url.pathname.match(/^\/api\/worker\/result\/(.+)$/)) {
      const matchId = url.pathname.match(/^\/api\/worker\/result\/(.+)$/)![1]!;
      try {
        const body = await req.json() as { seal: string; journal: string; imageId: string };
        // 1E: Validate proof artifacts are valid hex with correct lengths
        // Seal: 260 bytes (520 hex) with selector, or 256 bytes (512 hex) without
        if (typeof body.seal !== "string" || typeof body.journal !== "string" ||
            !/^[0-9a-fA-F]{512}([0-9a-fA-F]{8})?$/.test(body.seal) || !/^[0-9a-fA-F]{152}$/.test(body.journal)) {
          return Response.json({ error: "Invalid proof artifacts" }, { status: 400, headers: corsHeaders });
        }
        const job = submitJobResult(matchId, body);
        if (!job) {
          return Response.json({ error: "Job not found" }, { status: 404, headers: corsHeaders });
        }
        // The onResult callback on the job handles match record update + settlement
        return Response.json({ ok: true }, { headers: corsHeaders });
      } catch {
        return Response.json({ error: "Invalid body" }, { status: 400, headers: corsHeaders });
      }
    }

    // Worker status (for dashboard/debugging)
    if (url.pathname === "/api/worker/status") {
      return Response.json({ online: isWorkerOnline() }, { headers: corsHeaders });
    }

    // API status endpoint
    if (url.pathname === "/api/status") {
      return Response.json(
        {
          name: "chickenz-server",
          activeRooms: [...rooms.values()].filter((r) => !r.isEnded()).length,
          lobbyClients: lobbySockets.size,
        },
        { headers: corsHeaders },
      );
    }

    // Static file serving (production client build)
    const STATIC_DIR = new URL("../public", import.meta.url).pathname;
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const resolved = normalize(resolve(STATIC_DIR, "." + filePath));
    if (!resolved.startsWith(STATIC_DIR)) {
      return new Response("Not found", { status: 404, headers: corsHeaders });
    }
    const file = Bun.file(resolved);
    if (await file.exists()) {
      return new Response(file);
    }

    // SPA fallback
    const indexFile = Bun.file(STATIC_DIR + "/index.html");
    if (await indexFile.exists()) {
      return new Response(indexFile);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },

  websocket: {
    open(ws: ServerWebSocket<SocketData>) {
      lobbySockets.add(ws);
      sendLobby(ws);
    },

    message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
      // Rate limiting: 180 msgs/sec
      const now = Date.now();
      if (now - ws.data.msgResetTime > 1000) {
        ws.data.msgCount = 0;
        ws.data.msgResetTime = now;
      }
      if (++ws.data.msgCount > 180) return;

      let msg: ClientMessage;
      try {
        msg = JSON.parse(typeof message === "string" ? message : message.toString());
      } catch (err) {
        console.error("Failed to parse client message:", err);
        return;
      }

      // ── List rooms ───────────────────────────────────────
      if (msg.type === "list_rooms") {
        sendLobby(ws);
        return;
      }

      // ── Set username ───────────────────────────────────────
      if (msg.type === "set_username") {
        const name = (msg.username ?? "").trim();
        if (!isValidUsername(name)) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid username. Use 1-7 alphanumeric characters." }));
          return;
        }
        ws.data.username = name;
        return;
      }

      // ── Set wallet address ──────────────────────────────────
      if (msg.type === "set_wallet") {
        const addr = ((msg as any).address ?? "").trim();
        if (addr && /^G[A-Z2-7]{55}$/.test(addr)) {
          ws.data.walletAddress = addr;
          // Don't trust client-supplied verified flag; require server-side verification
          ws.data.walletVerified = false;
        }
        return;
      }

      // Store character choices from any room-related message
      if (typeof (msg as any).character === "number") {
        const ch = (msg as any).character;
        if (ch >= 0 && ch <= 3) ws.data.character = ch;
      }
      if (typeof (msg as any).awayCharacter === "number") {
        const ch = (msg as any).awayCharacter;
        if (ch >= 0 && ch <= 3) ws.data.awayCharacter = ch;
      }

      // ── Leave room / tournament ────────────────────────
      if (msg.type === "leave") {
        const roomId = ws.data.roomId;
        if (roomId) {
          const room = rooms.get(roomId);
          if (room?.handleLeave(ws.data.playerId)) {
            lobbySockets.add(ws);
            sendLobby(ws);
            if (room.isEnded()) rooms.delete(roomId);
            broadcastLobby();
          }
        }
        const tournamentId = ws.data.tournamentId;
        if (tournamentId) {
          const tournament = tournaments.get(tournamentId);
          if (tournament) {
            tournament.handleDisconnect(ws);
            ws.data.tournamentId = null;
            lobbySockets.add(ws);
            sendLobby(ws);
            if (tournament.playerCount === 0) tournaments.delete(tournamentId);
          }
        }
        return;
      }

      // ── Create room ─────────────────────────────────────
      if (msg.type === "create") {
        if (ws.data.roomId) {
          ws.send(JSON.stringify({ type: "error", message: "Already in a room" }));
          return;
        }

        const isPrivate = !!msg.isPrivate;
        const mode: GameMode = (msg as any).mode === "ranked" ? "ranked" : "casual";
        const name = isPrivate ? "Private Match" : "Public Match";
        const roomId = generateRoomId();
        const room = new GameRoom(roomId, name, ws, isPrivate, mode);
        room.onEnded = returnToLobby;
        room.onStarted = onMatchStarted;
        rooms.set(roomId, room);
        lobbySockets.delete(ws);
        broadcastLobby();
        return;
      }

      // ── Join by room ID ────────────────────────────────────
      if (msg.type === "join_room") {
        if (ws.data.roomId) {
          ws.send(JSON.stringify({ type: "error", message: "Already in a room" }));
          return;
        }

        const room = rooms.get(msg.roomId);
        if (!room) {
          ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
          return;
        }
        if (!room.isWaiting()) {
          ws.send(JSON.stringify({ type: "error", message: "Room is full or already started" }));
          return;
        }

        room.addPlayer(ws);
        lobbySockets.delete(ws);
        broadcastLobby();
        return;
      }

      // ── Join by code ───────────────────────────────────────
      if (msg.type === "join_code") {
        if (ws.data.roomId || ws.data.tournamentId) {
          ws.send(JSON.stringify({ type: "error", message: "Already in a room" }));
          return;
        }

        const code = (msg.code ?? "").trim().toUpperCase();
        if (code.length !== 5) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid join code" }));
          return;
        }

        const room = findRoomByJoinCode(code);
        if (!room) {
          // Fallback: check tournament codes
          let tournament: TournamentRoom | undefined;
          for (const t of tournaments.values()) {
            if (t.joinCode === code && t.status === "waiting") {
              tournament = t;
              break;
            }
          }
          if (tournament) {
            if (!tournament.addPlayer(ws)) {
              ws.send(JSON.stringify({ type: "error", message: "Tournament is full" }));
              return;
            }
            ws.data.tournamentId = tournament.id;
            lobbySockets.delete(ws);
            return;
          }
          ws.send(JSON.stringify({ type: "error", message: "No room found with that code" }));
          return;
        }

        room.addPlayer(ws);
        lobbySockets.delete(ws);
        broadcastLobby();
        return;
      }

      // ── Quickplay (auto-match) ───────────────────────────
      if (msg.type === "quickplay") {
        if (ws.data.roomId) {
          ws.send(JSON.stringify({ type: "error", message: "Already in a room" }));
          return;
        }

        const mode: GameMode = (msg as any).mode === "ranked" ? "ranked" : "casual";

        // Find first waiting PUBLIC room with matching mode
        let matched = false;
        for (const room of rooms.values()) {
          if (room.isWaiting() && !room.isPrivate && room.mode === mode) {
            room.addPlayer(ws);
            lobbySockets.delete(ws);
            broadcastLobby();
            matched = true;
            break;
          }
        }

        if (!matched) {
          const roomId = generateRoomId();
          const room = new GameRoom(roomId, "Quick Play", ws, false, mode);
          room.onEnded = returnToLobby;
          room.onStarted = onMatchStarted;
          rooms.set(roomId, room);
          lobbySockets.delete(ws);
          broadcastLobby();

          // Auto-add bot if no human joins (casual only)
          if (mode === "casual") {
            setTimeout(() => {
              if (room.isWaiting() && room.playerCount === 1) {
                room.addBot();
                broadcastLobby();
              }
            }, BOT_JOIN_DELAY_MS);
          }
        }
        return;
      }

      // ── Create tournament ──────────────────────────────────
      if (msg.type === "create_tournament") {
        if (ws.data.roomId || ws.data.tournamentId) {
          ws.send(JSON.stringify({ type: "error", message: "Already in a room or tournament" }));
          return;
        }
        const tournamentId = crypto.randomUUID().slice(0, 8);
        const tournament = new TournamentRoom(tournamentId, ws);
        ws.data.tournamentId = tournamentId;
        tournament.onEnded = (sockets) => {
          for (const s of sockets) {
            s.data.tournamentId = null;
            lobbySockets.add(s);
            sendLobby(s);
          }
          tournaments.delete(tournamentId);
          broadcastLobby();
        };
        tournaments.set(tournamentId, tournament);
        lobbySockets.delete(ws);
        return;
      }

      // ── Join tournament by code ─────────────────────────────
      if (msg.type === "join_tournament_code") {
        if (ws.data.roomId || ws.data.tournamentId) {
          ws.send(JSON.stringify({ type: "error", message: "Already in a room or tournament" }));
          return;
        }
        const code = ((msg as any).code ?? "").trim().toUpperCase();
        if (code.length !== 5) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid join code" }));
          return;
        }
        let found: TournamentRoom | undefined;
        for (const t of tournaments.values()) {
          if (t.joinCode === code && t.status === "waiting") {
            found = t;
            break;
          }
        }
        if (!found) {
          ws.send(JSON.stringify({ type: "error", message: "No tournament found with that code" }));
          return;
        }
        if (!found.addPlayer(ws)) {
          ws.send(JSON.stringify({ type: "error", message: "Tournament is full" }));
          return;
        }
        ws.data.tournamentId = found.id;
        lobbySockets.delete(ws);
        return;
      }

      // ── Game input ───────────────────────────────────────
      if (msg.type === "input") {
        // Tournament input: route through tournament's active game room
        const tournamentId = ws.data.tournamentId;
        if (tournamentId) {
          const tournament = tournaments.get(tournamentId);
          if (tournament) {
            tournament.handleInput(ws, msg as any);
          }
          return;
        }
        const roomId = ws.data.roomId;
        if (!roomId) return;
        if (typeof msg.buttons !== "number" || !Number.isInteger(msg.buttons) || msg.buttons < 0 || msg.buttons > 0x1F) return;
        if (!Number.isFinite(msg.aimX) || !Number.isFinite(msg.aimY)) return;
        // Clamp aim to valid integer range
        msg.aimX = Math.max(-1, Math.min(1, Math.round(msg.aimX)));
        msg.aimY = Math.max(-1, Math.min(1, Math.round(msg.aimY)));
        const room = rooms.get(roomId);
        if (!room) return;
        room.handleInput(ws.data.playerId, msg);
        return;
      }
    },

    close(ws: ServerWebSocket<SocketData>) {
      lobbySockets.delete(ws);

      // Clean up spectator references
      for (const room of rooms.values()) {
        room.removeSpectator(ws);
      }

      // Tournament disconnect
      const tournamentId = ws.data.tournamentId;
      if (tournamentId) {
        const tournament = tournaments.get(tournamentId);
        if (tournament) {
          tournament.handleDisconnect(ws);
          if (tournament.playerCount === 0) {
            tournaments.delete(tournamentId);
          }
        }
        ws.data.tournamentId = null;
      }

      const roomId = ws.data.roomId;
      if (roomId) {
        const room = rooms.get(roomId);
        if (room) {
          room.handleDisconnect(ws.data.playerId);
          cleanupRoom(roomId);
        }
      }
    },
  },
});

// Ping lobby sockets every 30s to detect dead connections
setInterval(() => {
  for (const ws of lobbySockets) {
    try {
      ws.ping();
    } catch {
      lobbySockets.delete(ws);
    }
  }
}, 30_000);

// Periodic sweep: clean up waiting rooms with no players.
// Ended rooms are cleaned by cleanupRoom()'s 2-minute timeout.
setInterval(() => {
  for (const [id, room] of rooms) {
    if (room.isWaiting() && room.playerCount === 0) {
      rooms.delete(id);
    }
  }
}, 60_000);

console.log(`Chickenz server running on http://localhost:${server.port}`);
