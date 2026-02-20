import type { ServerWebSocket } from "bun";
import { GameRoom, type SocketData } from "./GameRoom";
import type { ClientMessage, RoomInfo, GameMode } from "./protocol";
import { startMatchOnChain, settleMatchOnChain } from "./stellar";
import { proveMatch, claimNextJob, getJobTranscript, submitJobResult, getJob, workerHeartbeat, isWorkerOnline, type ProofArtifacts } from "./prover";
import { updateElo, getLeaderboard } from "./elo";

const PORT = Number(process.env.PORT) || 3000;

// ── State ──────────────────────────────────────────────────

const rooms = new Map<string, GameRoom>();
const lobbySockets = new Set<ServerWebSocket<SocketData>>();

// ── Match History ──────────────────────────────────────────

interface MatchRecord {
  id: string;
  roomName: string;
  player1: string;
  player2: string;
  winner: number;
  scores: [number, number];
  timestamp: number;
  proofStatus: "none" | "pending" | "proving" | "verified" | "settled";
  roomId: string;
  mode: GameMode;
  proofArtifacts?: { seal: string; journal: string; imageId: string };
}

const matchHistory: MatchRecord[] = [];
const MAX_MATCH_HISTORY = 50;
let nextMatchId = 1;

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

function returnToLobby(sockets: ServerWebSocket<SocketData>[], winner: number, roomId: string, roomName: string, scores: [number, number], mode: GameMode) {
  const room = rooms.get(roomId);

  // Only update ELO for ranked matches with sufficient input activity
  if (mode === "ranked" && sockets.length === 2 && winner >= 0 && winner <= 1) {
    const winnerName = sockets[winner]?.data.username;
    const loserName = sockets[1 - winner]?.data.username;
    if (winnerName && loserName) {
      const activity = room?.getInputActivity() ?? [0, 0];
      const MIN_INPUT_CHANGES = 30;
      if (activity[0] >= MIN_INPUT_CHANGES && activity[1] >= MIN_INPUT_CHANGES) {
        updateElo(winnerName, loserName);
      }
    }
  }

  // Record match history
  if (sockets.length === 2) {
    const record: MatchRecord = {
      id: `match-${nextMatchId++}`,
      roomName,
      player1: sockets[0]?.data.username || "Player 1",
      player2: sockets[1]?.data.username || "Player 2",
      winner,
      scores,
      timestamp: Date.now(),
      proofStatus: mode === "ranked" ? "pending" : "none",
      roomId,
      mode,
    };
    matchHistory.unshift(record);
    if (matchHistory.length > MAX_MATCH_HISTORY) {
      matchHistory.pop();
    }

    // Trigger proving for ranked matches
    if (mode === "ranked" && room) {
      record.proofStatus = "proving";
      const transcript = room.getTranscript();
      const onProofResult = (artifacts: ProofArtifacts | null) => {
        if (artifacts) {
          record.proofArtifacts = artifacts;
          record.proofStatus = "verified";
          // Auto-settle if admin key is configured
          if (process.env.STELLAR_ADMIN_SECRET) {
            const sealBytes = new Uint8Array(Buffer.from(artifacts.seal, "hex"));
            const journalBytes = new Uint8Array(Buffer.from(artifacts.journal, "hex"));
            const numericId = parseInt(record.id.replace("match-", ""), 10);
            settleMatchOnChain(numericId, sealBytes, journalBytes)
              .then(() => { record.proofStatus = "settled"; })
              .catch((err) => { console.error("Auto-settle failed:", err); });
          }
        } else {
          record.proofStatus = "pending";
        }
      };
      proveMatch(record.id, transcript, onProofResult);
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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const server = Bun.serve<SocketData>({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, {
        data: { roomId: null, playerId: -1, username: "", walletAddress: "", character: 0 },
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
      const room = rooms.get(roomId);
      if (!room) {
        return Response.json({ error: "Room not found" }, { status: 404, headers: corsHeaders });
      }
      if (!room.isEnded()) {
        return Response.json({ error: "Match still in progress" }, { status: 400, headers: corsHeaders });
      }
      return Response.json(room.getTranscript(), { headers: corsHeaders });
    }

    // Leaderboard endpoint
    if (url.pathname === "/api/leaderboard") {
      return Response.json(getLeaderboard(), { headers: corsHeaders });
    }

    // Match history endpoints
    if (url.pathname === "/api/matches") {
      return Response.json(matchHistory, { headers: corsHeaders });
    }
    const matchStatusMatch = url.pathname.match(/^\/api\/matches\/(.+)\/status$/);
    if (matchStatusMatch) {
      const matchId = matchStatusMatch[1]!;
      const record = matchHistory.find((m) => m.id === matchId);
      if (!record) {
        return Response.json({ error: "Match not found" }, { status: 404, headers: corsHeaders });
      }
      return Response.json({ id: record.id, proofStatus: record.proofStatus }, { headers: corsHeaders });
    }
    const matchProofMatch = url.pathname.match(/^\/api\/matches\/(.+)\/proof$/);
    if (matchProofMatch) {
      const matchId = matchProofMatch[1]!;
      const record = matchHistory.find((m) => m.id === matchId);
      if (!record) {
        return Response.json({ error: "Match not found" }, { status: 404, headers: corsHeaders });
      }
      if (!record.proofArtifacts) {
        return Response.json({ error: "Proof not yet available" }, { status: 404, headers: corsHeaders });
      }
      return Response.json(record.proofArtifacts, { headers: corsHeaders });
    }
    if (req.method === "POST") {
      const proveMatch = url.pathname.match(/^\/api\/matches\/(.+)\/prove$/);
      if (proveMatch) {
        const matchId = proveMatch[1]!;
        const record = matchHistory.find((m) => m.id === matchId);
        if (!record) {
          return Response.json({ error: "Match not found" }, { status: 404, headers: corsHeaders });
        }
        record.proofStatus = "proving";
        return Response.json({ id: record.id, proofStatus: record.proofStatus }, { headers: corsHeaders });
      }
      const settleMatch = url.pathname.match(/^\/api\/matches\/(.+)\/settle$/);
      if (settleMatch) {
        const matchId = settleMatch[1]!;
        const record = matchHistory.find((m) => m.id === matchId);
        if (!record) {
          return Response.json({ error: "Match not found" }, { status: 404, headers: corsHeaders });
        }
        record.proofStatus = "settled";
        return Response.json({ id: record.id, proofStatus: record.proofStatus }, { headers: corsHeaders });
      }
    }

    // ── Worker API (prover worker polls these) ──────────────

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
        const job = submitJobResult(matchId, body);
        if (!job) {
          return Response.json({ error: "Job not found" }, { status: 404, headers: corsHeaders });
        }
        // Update match record
        const record = matchHistory.find((m) => m.id === matchId);
        if (record) {
          record.proofArtifacts = body;
          record.proofStatus = "verified";
          // Auto-settle if admin key is configured
          if (process.env.STELLAR_ADMIN_SECRET) {
            const sealBytes = new Uint8Array(Buffer.from(body.seal, "hex"));
            const journalBytes = new Uint8Array(Buffer.from(body.journal, "hex"));
            const numericId = parseInt(record.id.replace("match-", ""), 10);
            settleMatchOnChain(numericId, sealBytes, journalBytes)
              .then(() => { record.proofStatus = "settled"; })
              .catch((err) => { console.error("Auto-settle failed:", err); });
          }
        }
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
    const file = Bun.file(STATIC_DIR + filePath);
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
        if (addr && addr.length > 0) {
          ws.data.walletAddress = addr;
        }
        return;
      }

      // Store character choice from any room-related message
      if (typeof (msg as any).character === "number") {
        const ch = (msg as any).character;
        if (ch >= 0 && ch <= 3) ws.data.character = ch;
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
        if (ws.data.roomId) {
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
          rooms.set(roomId, room);
          lobbySockets.delete(ws);
          broadcastLobby();
        }
        return;
      }

      // ── Game input ───────────────────────────────────────
      if (msg.type === "input") {
        const roomId = ws.data.roomId;
        if (!roomId) return;
        if (typeof msg.buttons !== "number" || !Number.isFinite(msg.aimX) || !Number.isFinite(msg.aimY)) return;
        const room = rooms.get(roomId);
        if (!room) return;
        room.handleInput(ws.data.playerId, msg);
        return;
      }
    },

    close(ws: ServerWebSocket<SocketData>) {
      lobbySockets.delete(ws);

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
