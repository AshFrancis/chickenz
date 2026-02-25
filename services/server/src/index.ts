import type { ServerWebSocket } from "bun";
import { GameRoom, type SocketData } from "./GameRoom";
import { TournamentRoom } from "./TournamentRoom";
import type { ClientMessage, RoomInfo, GameMode, InputMessage } from "./protocol";
import { generateJoinCode } from "./protocol";
import { startMatchOnChain, settleMatchOnChain, verifyTxOnChain, verifySettleTxOnChain } from "./stellar";
import {
  proveMatch,
  claimNextJob,
  getJobTranscript,
  submitJobResult,
  isWorkerOnline,
  type ProofArtifacts,
} from "./prover";
import {
  updateElo,
  getCasualElo,
  updateCasualElo,
  getLeaderboard,
  insertMatch,
  updateProofStatus,
  getRecentMatches,
  getMatchById,
  generateMatchId,
  updateStartTxHash,
  updateSettleTxHash,
  updateProofTimestamps,
  updateMatchStartTime,
  updateWalletVerified,
  saveTranscript,
  getTranscriptByRoomId,
  saveProverTranscript,
  getProverTranscript,
  updateTranscriptCid,
  updateBoundlessRequestId,
  updateBoundlessTxHash,
  markBotVsBot,
  pruneBotVsBotTranscripts,
  type MatchRecord,
} from "./db";
import { normalize, resolve } from "path";
import { releaseBotName, randomBotName, createBotSocket } from "./BotAI";
import { BotLobbyManager } from "./BotLobbyManager";
import { hash, Keypair, StrKey, Address, xdr } from "@stellar/stellar-sdk";

// ── Passkey wallet verification helpers ─────────────────────

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

function base64UrlDecode(str: string): Uint8Array {
  // Restore standard base64: replace URL-safe chars, add padding
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** Replicate SAK's contract address derivation: credentialId → Stellar contract address. */
function deriveSmartAccountAddress(credentialIdB64url: string): string {
  const credentialIdBuf = Buffer.from(base64UrlDecode(credentialIdB64url));
  const deployerKeypair = Keypair.fromRawEd25519Seed(hash(Buffer.from("openzeppelin-smart-account-kit")));
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(TESTNET_PASSPHRASE)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(deployerKeypair.publicKey()).toScAddress(),
          salt: hash(credentialIdBuf),
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

/** Convert DER-encoded ECDSA signature to raw r||s (64 bytes) for crypto.subtle. */
function derToRaw(derSig: Uint8Array): Uint8Array {
  // DER: 0x30 [len] 0x02 [rLen] [r...] 0x02 [sLen] [s...]
  if (derSig.length < 8 || derSig[0] !== 0x30) throw new Error("Not a DER signature");
  let offset = 2; // skip 0x30 + total length
  if (derSig[1]! & 0x80) offset += derSig[1]! & 0x7f; // long form length (unlikely but handle)

  if (derSig[offset] !== 0x02) throw new Error("Expected integer tag for r");
  const rLen = derSig[offset + 1]!;
  const rStart = offset + 2;
  const rBytes = derSig.subarray(rStart, rStart + rLen);

  const sOffset = rStart + rLen;
  if (derSig[sOffset] !== 0x02) throw new Error("Expected integer tag for s");
  const sLen = derSig[sOffset + 1]!;
  const sStart = sOffset + 2;
  const sBytes = derSig.subarray(sStart, sStart + sLen);

  // Pad/trim to exactly 32 bytes each (remove leading zero padding, left-pad if short)
  const raw = new Uint8Array(64);
  const rTrimmed = rBytes[0] === 0 && rLen > 32 ? rBytes.subarray(1) : rBytes;
  const sTrimmed = sBytes[0] === 0 && sLen > 32 ? sBytes.subarray(1) : sBytes;
  raw.set(rTrimmed, 32 - rTrimmed.length);
  raw.set(sTrimmed, 64 - sTrimmed.length);
  return raw;
}

/** Verify a WebAuthn P-256 assertion signature. */
async function verifyPasskeyAssertion(
  publicKeyBytes: Uint8Array,
  assertion: { authenticatorData: string; clientDataJSON: string; signature: string },
): Promise<boolean> {
  try {
    const authData = base64UrlDecode(assertion.authenticatorData);
    const clientDataJSON = base64UrlDecode(assertion.clientDataJSON);
    const signatureDer = base64UrlDecode(assertion.signature);

    // Signed data = authenticatorData || SHA-256(clientDataJSON)
    const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", Buffer.from(clientDataJSON)));
    const signedData = Buffer.alloc(authData.length + 32);
    signedData.set(authData);
    signedData.set(clientDataHash, authData.length);

    // Import P-256 public key
    const key = await crypto.subtle.importKey(
      "raw",
      Buffer.from(publicKeyBytes),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );

    // Convert DER signature to raw r||s format
    const rawSig = derToRaw(signatureDer);

    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(rawSig), signedData);
  } catch (err) {
    console.error("[wallet] Assertion verification error:", err);
    return false;
  }
}

const PORT = Number(process.env.PORT) || 3000;
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
const allSockets = new Set<ServerWebSocket<SocketData>>(); // all connected WS clients

function generateRoomId(): string {
  let id: string;
  do {
    id = crypto.randomUUID().slice(0, 8);
  } while (rooms.has(id));
  return id;
}

const botLobbyManager = new BotLobbyManager({
  generateRoomId,
  isJoinCodeInUse,
  broadcastLobby: () => broadcastLobby(),
});

function getVisibleRooms(): RoomInfo[] {
  const list: RoomInfo[] = [];
  for (const room of rooms.values()) {
    if (!room.isEnded() && !room.isPrivate) {
      list.push(room.toInfo());
    }
  }
  // Include fake bot waiting rooms
  list.push(...botLobbyManager.getFakeRooms());
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
  const rawSeal = Buffer.from(artifacts.seal, "hex");
  // Contract expects 260 bytes: 4-byte Groth16 verifier selector + 256-byte proof
  // Selector = first 4 bytes of Groth16ReceiptVerifierParameters digest (risc0 3.0.x)
  const GROTH16_SELECTOR = Buffer.from("73c457ba", "hex");
  const sealBytes =
    rawSeal.length === 256 ? new Uint8Array(Buffer.concat([GROTH16_SELECTOR, rawSeal])) : new Uint8Array(rawSeal); // already has selector (260 bytes)
  const journalBytes = new Uint8Array(Buffer.from(artifacts.journal, "hex"));
  settleMatchOnChain(sessionId, sealBytes, journalBytes)
    .then((hash) => {
      if (hash) {
        updateProofStatus(matchId, "settled");
        updateSettleTxHash(matchId, hash);
        console.log(`[stellar] Auto-settled ${matchId}: ${hash}`);
      } else {
        console.error(`[stellar] Auto-settle returned no tx hash for ${matchId}`);
        // Leave as "verified" so manual settle can retry
      }
    })
    .catch((err) => {
      console.error("Auto-settle failed:", err);
      // Leave as "verified" so manual settle can retry
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
    const data = (await res.json()) as { IpfsHash: string };
    const cid = data.IpfsHash;
    updateTranscriptCid(matchId, cid);
    console.log(`[ipfs] Transcript pinned for ${matchId}: ${cid}`);
  } catch (err) {
    console.error(`[ipfs] Failed to pin transcript for ${matchId}:`, err);
  }
}

function returnToLobby(
  sockets: ServerWebSocket<SocketData>[],
  winner: number,
  roomId: string,
  roomName: string,
  scores: [number, number],
  mode: GameMode,
) {
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

  // Update casual ELO for bot matches
  if (room?.isBotMatch && winner >= 0 && winner <= 1) {
    const playerName = sockets[0]?.data.username;
    if (playerName) {
      const botElo = 500 + Math.round(room.currentBotDifficulty * 1000);
      updateCasualElo(playerName, winner === 0, botElo);
    }
  }

  // Record match history
  if (sockets.length === 2) {
    const matchId = generateMatchId();
    if (room) room.matchRecordId = matchId;
    const sessionId = room?.sessionId || Date.now() >>> 0;
    const record: MatchRecord = {
      id: matchId,
      sessionId,
      roomName,
      player1: sockets[0]?.data.username || "Player 1",
      player2: sockets[1]?.data.username || "Player 2",
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

    // Trigger proving for ranked matches (never bots), only if match completed naturally (2 winning rounds)
    const rw = room?.roundWinsSnapshot;
    const hasFullResult = rw && (rw[0] >= 2 || rw[1] >= 2);
    if (mode === "ranked" && !room?.isBotMatch && room && hasFullResult) {
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
      proveMatch(
        matchId,
        transcript,
        onProofResult,
        (requestId) => updateBoundlessRequestId(matchId, requestId),
        (txHash) => updateBoundlessTxHash(matchId, txHash),
      );
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
      void pinTranscriptToIPFS(matchId, fullTranscript);
      // Save prover-format transcript for reprove (config + winning rounds only)
      if (mode === "ranked" && !room.isBotMatch) {
        saveProverTranscript(matchId, room.getTranscript());
      }
    }

    // Store timeline fields that insertMatch doesn't cover
    if (record.matchStartTime) updateMatchStartTime(matchId, record.matchStartTime);
    if (record.wallet1Verified || record.wallet2Verified) {
      updateWalletVerified(matchId, !!record.wallet1Verified, !!record.wallet2Verified);
    }
  }

  // Release bot name for reuse
  if (room?.isBotMatch && room.botName) {
    releaseBotName(room.botName);
  }

  for (const ws of sockets) {
    // Skip bot sockets — they're fake objects that should never enter the lobby
    if (!allSockets.has(ws)) continue;
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
    .then((hash) => {
      if (!hash) return;
      room.startTxHash = hash;
      // If match already ended and DB record exists, update directly (race fix)
      if (room.matchRecordId) {
        updateStartTxHash(room.matchRecordId, hash);
      }
    })
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

/** Check if a join code is already in use by any room or tournament. */
function isJoinCodeInUse(code: string): boolean {
  for (const room of rooms.values()) {
    if (room.joinCode === code && !room.isEnded()) return true;
  }
  for (const t of tournaments.values()) {
    if (t.joinCode === code && t.status !== "ended") return true;
  }
  return false;
}

/** Ensure a room/tournament's join code is globally unique; re-roll if collision. */
function ensureUniqueJoinCode(entity: { joinCode: string }) {
  let attempts = 0;
  while (isJoinCodeInUse(entity.joinCode) && attempts++ < 100) {
    entity.joinCode = generateJoinCode();
  }
}

// ── Username validation ───────────────────────────────────

const PROFANITY_LIST = new Set([
  "fuck",
  "shit",
  "ass",
  "bitch",
  "dick",
  "cock",
  "pussy",
  "cunt",
  "fag",
  "nigger",
  "nigga",
  "retard",
  "whore",
  "slut",
  "damn",
  "piss",
  "twat",
  "wanker",
  "arse",
  "bollock",
  "bugger",
  "chink",
  "coon",
  "dyke",
  "feck",
  "homo",
  "jizz",
  "kike",
  "knob",
  "muff",
  "nig",
  "prick",
  "spic",
  "tit",
  "turd",
  "anal",
  "anus",
  "balls",
  "boob",
  "dildo",
  "douche",
  "erect",
  "felch",
  "fudge",
  "gtfo",
  "handjob",
  "horny",
  "jackoff",
  "jerkoff",
  "milf",
  "nazi",
  "nude",
  "nutsack",
  "orgasm",
  "penis",
  "porn",
  "pube",
  "rape",
  "scrotum",
  "semen",
  "sex",
  "skank",
  "spunk",
  "stfu",
  "testicle",
  "vagina",
  "vulva",
]);

function normalizeLeetSpeak(s: string): string {
  return s
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/@/g, "a")
    .replace(/\$/g, "s")
    .replace(/!/g, "i");
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

// Reusable verification tokens: address → { token, issuedAt } (24h TTL, lost on server restart)
const verifiedTokens = new Map<string, { token: string; issuedAt: number }>();
const VERIFIED_TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 hours
// Prune expired tokens every 10 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [addr, entry] of verifiedTokens) {
      if (now - entry.issuedAt > VERIFIED_TOKEN_TTL) verifiedTokens.delete(addr);
    }
  },
  10 * 60 * 1000,
);

const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || "*";
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// Simple per-IP rate limiter for HTTP API endpoints
const httpRateMap = new Map<string, { count: number; resetAt: number }>();
const HTTP_RATE_WINDOW = 60_000; // 1 minute window
const HTTP_RATE_LIMIT = 120; // max requests per window per IP

function checkHttpRate(ip: string): boolean {
  const now = Date.now();
  let entry = httpRateMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + HTTP_RATE_WINDOW };
    httpRateMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= HTTP_RATE_LIMIT;
}
// Prune stale rate entries every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [ip, entry] of httpRateMap) {
      if (now >= entry.resetAt) httpRateMap.delete(ip);
    }
  },
  5 * 60 * 1000,
);

const server = Bun.serve<SocketData>({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Rate limit API endpoints
    if (url.pathname.startsWith("/api/")) {
      const ip = server.requestIP(req)?.address ?? "unknown";
      if (!checkHttpRate(ip)) {
        return Response.json({ error: "Too many requests" }, { status: 429, headers: corsHeaders });
      }
    }

    // Lightweight ping endpoint for region latency measurement
    if (url.pathname === "/api/ping") {
      return new Response("ok", { headers: corsHeaders });
    }

    // Relayer proxy: forward /relayer/* to channels.openzeppelin.com/* (avoids CORS issues)
    if (url.pathname.startsWith("/relayer/")) {
      // Gate: only allow requests from our own origin (prevents third parties from abusing our API key)
      if (ALLOWED_ORIGIN !== "*") {
        const origin = req.headers.get("origin") ?? "";
        if (origin !== ALLOWED_ORIGIN) {
          return Response.json({ error: "Forbidden" }, { status: 403, headers: corsHeaders });
        }
      }
      const relayerApiKey = process.env.RELAYER_API_KEY;
      if (!relayerApiKey) {
        return Response.json({ error: "Relayer not configured" }, { status: 503, headers: corsHeaders });
      }
      const targetPath = url.pathname.replace(/^\/relayer/, "");
      const targetUrl = `https://channels.openzeppelin.com${targetPath}${url.search}`;
      const proxyHeaders: Record<string, string> = {
        Authorization: `Bearer ${relayerApiKey}`,
      };
      // Forward relevant headers from the original request
      const ct = req.headers.get("content-type");
      if (ct) proxyHeaders["Content-Type"] = ct;
      try {
        const proxyRes = await fetch(targetUrl, {
          method: req.method,
          headers: proxyHeaders,
          body: req.method !== "GET" && req.method !== "HEAD" ? await req.arrayBuffer() : undefined,
        });
        const body = await proxyRes.arrayBuffer();
        const resHeaders: Record<string, string> = { ...corsHeaders };
        const resCt = proxyRes.headers.get("content-type");
        if (resCt) resHeaders["Content-Type"] = resCt;
        return new Response(body, { status: proxyRes.status, headers: resHeaders });
      } catch (err) {
        console.error("[relayer proxy] error:", err);
        return Response.json({ error: "Relayer proxy failed" }, { status: 502, headers: corsHeaders });
      }
    }

    // Redirect raw IP access to canonical hostname
    const host = req.headers.get("host") || "";
    const canonicalHost = process.env.CANONICAL_HOST;
    if (canonicalHost && !host.startsWith(canonicalHost) && /^\d+\.\d+\.\d+\.\d+/.test(host)) {
      return new Response(null, {
        status: 301,
        headers: {
          Location: `https://${canonicalHost}${url.pathname}${url.search}`,
          "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
        },
      });
    }

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      // Validate Origin header to prevent cross-site WebSocket hijacking
      const origin = req.headers.get("origin") ?? "";
      if (ALLOWED_ORIGIN !== "*" && origin && origin !== ALLOWED_ORIGIN) {
        return new Response("Forbidden origin", { status: 403 });
      }
      const upgraded = server.upgrade(req, {
        data: {
          roomId: null,
          playerId: -1,
          username: "",
          walletAddress: "",
          character: 0,
          awayCharacter: 1,
          tournamentId: null,
          msgCount: 0,
          msgResetTime: Date.now(),
        },
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
    const transcriptMatch = url.pathname.match(/^\/transcript\/([a-zA-Z0-9_-]+)$/);
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

    // Match history endpoints (strip sensitive fields for public API)
    if (url.pathname === "/api/matches") {
      const matches = getRecentMatches().map(({ proofArtifacts: _pa, ...rest }) => rest);
      return Response.json(matches, { headers: corsHeaders });
    }
    const matchStatusMatch = url.pathname.match(/^\/api\/matches\/([a-zA-Z0-9_-]+)\/status$/);
    if (matchStatusMatch) {
      const matchId = matchStatusMatch[1]!;
      const record = getMatchById(matchId);
      if (!record) {
        return Response.json({ error: "Match not found" }, { status: 404, headers: corsHeaders });
      }
      return Response.json({ id: record.id, proofStatus: record.proofStatus }, { headers: corsHeaders });
    }
    const matchProofMatch = url.pathname.match(/^\/api\/matches\/([a-zA-Z0-9_-]+)\/proof$/);
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
    const matchDetailMatch = url.pathname.match(/^\/api\/matches\/([a-zA-Z0-9_-]+)\/detail$/);
    if (matchDetailMatch) {
      const matchId = matchDetailMatch[1]!;
      const record = getMatchById(matchId);
      if (!record) {
        return Response.json({ error: "Match not found" }, { status: 404, headers: corsHeaders });
      }
      return Response.json(
        {
          ...record,
          contractAddress: process.env.CHICKENZ_CONTRACT || "CBRDPRKUK3NH2HXOWSNZPG2ZSXXXZBR7GCMN7WLHWINMLNDCJ7NSREKG",
          verifierAddress: "CDUDXCLMNE7Q4BZJLLB3KACFOS55SS55GSQW2UYHDUXTJKZUDDAJYCIH",
          gameHubAddress: "CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG",
        },
        { headers: corsHeaders },
      );
    }

    // ── Client-triggered settle notification ──────────────
    const matchSettleMatch = url.pathname.match(/^\/api\/matches\/([a-zA-Z0-9_-]+)\/settle$/);
    if (req.method === "POST" && matchSettleMatch) {
      const matchId = matchSettleMatch[1]!;
      const record = getMatchById(matchId);
      if (!record) {
        return Response.json({ error: "Match not found" }, { status: 404, headers: corsHeaders });
      }
      if (record.proofStatus !== "verified") {
        return Response.json({ error: "Match not in verified state" }, { status: 400, headers: corsHeaders });
      }
      const body = await req.json().catch(() => ({}) as Record<string, unknown>);
      const txHash = body?.txHash;
      if (!txHash || typeof txHash !== "string") {
        return Response.json({ error: "txHash required" }, { status: 400, headers: corsHeaders });
      }
      // Validate txHash looks like a Stellar transaction hash (64 hex chars)
      if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
        return Response.json({ error: "Invalid txHash format" }, { status: 400, headers: corsHeaders });
      }
      // Verify the transaction on-chain: if sessionId is known, check it called settle_match
      // on our contract with the right session ID; otherwise fall back to success-only check
      const txVerified =
        record.sessionId !== undefined
          ? await verifySettleTxOnChain(txHash, record.sessionId)
          : await verifyTxOnChain(txHash);
      if (!txVerified) {
        return Response.json(
          { error: "Transaction not found, not successful, or does not match this match" },
          { status: 400, headers: corsHeaders },
        );
      }
      updateProofStatus(matchId, "settled");
      updateSettleTxHash(matchId, txHash);
      return Response.json({ ok: true, proofStatus: "settled" }, { headers: corsHeaders });
    }

    // ── Wallet register/revalidate endpoints ─────────────────
    if (req.method === "POST" && url.pathname === "/api/wallet/register") {
      try {
        const body = (await req.json()) as {
          address: string;
          credentialId: string;
          publicKey?: string;
          assertion?: { authenticatorData: string; clientDataJSON: string; signature: string };
        };
        if (!body.address || !/^C[A-Z2-7]{55}$/.test(body.address)) {
          return Response.json({ error: "Invalid address" }, { status: 400, headers: corsHeaders });
        }
        if (!body.credentialId) {
          return Response.json({ error: "Missing credentialId" }, { status: 400, headers: corsHeaders });
        }
        // Verify credentialId → address derivation matches claimed address
        // (deterministic and unforgeable — core security check)
        const derivedAddress = deriveSmartAccountAddress(body.credentialId);
        if (derivedAddress !== body.address) {
          console.warn(`[wallet] Address derivation mismatch: claimed=${body.address} derived=${derivedAddress}`);
          return Response.json({ error: "Address derivation mismatch" }, { status: 403, headers: corsHeaders });
        }
        // If public key provided, verify format and optionally verify assertion signature
        if (body.publicKey) {
          const pubKeyBytes = base64UrlDecode(body.publicKey);
          if (pubKeyBytes.length !== 65 || pubKeyBytes[0] !== 0x04) {
            return Response.json({ error: "Invalid public key format" }, { status: 400, headers: corsHeaders });
          }
          // If assertion present (login path), verify P-256 signature
          if (body.assertion) {
            const sigValid = await verifyPasskeyAssertion(pubKeyBytes, body.assertion);
            if (!sigValid) {
              return Response.json({ error: "Assertion signature invalid" }, { status: 403, headers: corsHeaders });
            }
          }
        }
        // Mark all matching WS connections as verified
        for (const ws of allSockets) {
          if (ws.data.walletAddress === body.address) {
            ws.data.walletVerified = true;
          }
        }
        // Issue reusable token
        const token = crypto.randomUUID();
        verifiedTokens.set(body.address, { token, issuedAt: Date.now() });
        return Response.json({ verified: true, token }, { headers: corsHeaders });
      } catch (err) {
        console.error("[wallet] register error:", err);
        return Response.json({ error: "Invalid body" }, { status: 400, headers: corsHeaders });
      }
    }

    // Revalidate with a previously issued token (no passkey prompt needed)
    if (req.method === "POST" && url.pathname === "/api/wallet/revalidate") {
      try {
        const body = (await req.json()) as { address: string; token: string };
        if (!body.address || !body.token || !/^C[A-Z2-7]{55}$/.test(body.address)) {
          return Response.json({ verified: false }, { headers: corsHeaders });
        }
        const stored = verifiedTokens.get(body.address);
        if (!stored || stored.token !== body.token) {
          return Response.json({ verified: false }, { headers: corsHeaders });
        }
        // Token matches — mark all matching WebSocket connections as verified
        for (const ws of allSockets) {
          if (ws.data.walletAddress === body.address) {
            ws.data.walletVerified = true;
          }
        }
        return Response.json({ verified: true }, { headers: corsHeaders });
      } catch {
        return Response.json({ verified: false }, { headers: corsHeaders });
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
    const workerInputMatch = url.pathname.match(/^\/api\/worker\/input\/([a-zA-Z0-9_-]+)$/);
    if (workerInputMatch) {
      const matchId = workerInputMatch[1]!;
      const transcript = getJobTranscript(matchId);
      if (!transcript) {
        return Response.json({ error: "Job not found" }, { status: 404, headers: corsHeaders });
      }
      return Response.json(transcript, { headers: corsHeaders });
    }

    // Worker submits proof result
    if (req.method === "POST" && url.pathname.match(/^\/api\/worker\/result\/([a-zA-Z0-9_-]+)$/)) {
      const matchId = url.pathname.match(/^\/api\/worker\/result\/([a-zA-Z0-9_-]+)$/)![1]!;
      try {
        const body = (await req.json()) as {
          seal: string;
          journal: string;
          imageId: string;
          boundlessRequestId?: string;
          boundlessTxHash?: string;
        };
        // 1E: Validate proof artifacts are valid hex with correct lengths
        // Seal: 260 bytes (520 hex) with selector, or 256 bytes (512 hex) without
        // ImageId: 32 bytes (64 hex)
        if (
          typeof body.seal !== "string" ||
          typeof body.journal !== "string" ||
          typeof body.imageId !== "string" ||
          !/^[0-9a-fA-F]{512}([0-9a-fA-F]{8})?$/.test(body.seal) ||
          !/^[0-9a-fA-F]{152}$/.test(body.journal) ||
          !/^[0-9a-fA-F]{64}$/.test(body.imageId)
        ) {
          return Response.json({ error: "Invalid proof artifacts" }, { status: 400, headers: corsHeaders });
        }
        // Save Boundless request ID and tx hash if provided by worker
        console.log(
          `[worker] Result for ${matchId}: requestId=${body.boundlessRequestId ?? "none"}, txHash=${body.boundlessTxHash ?? "none"}`,
        );
        if (body.boundlessRequestId && typeof body.boundlessRequestId === "string") {
          updateBoundlessRequestId(matchId, body.boundlessRequestId);
        }
        if (body.boundlessTxHash && typeof body.boundlessTxHash === "string") {
          updateBoundlessTxHash(matchId, body.boundlessTxHash);
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

    // Admin: re-prove a stuck match from its stored transcript (worker API key required)
    const reprovenMatch = url.pathname.match(/^\/api\/admin\/reprove\/([a-zA-Z0-9_-]+)$/);
    if (req.method === "POST" && reprovenMatch) {
      const apiKey = req.headers.get("x-api-key");
      if (!apiKey || apiKey !== process.env.WORKER_API_KEY) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
      }
      const matchId = reprovenMatch[1]!;
      const record = getMatchById(matchId);
      if (!record) return Response.json({ error: "Match not found" }, { status: 404, headers: corsHeaders });
      if (record.proofStatus === "settled") {
        return Response.json({ error: "Match already settled" }, { status: 400, headers: corsHeaders });
      }
      const transcript = getProverTranscript(matchId);
      if (!transcript)
        return Response.json({ error: "No prover transcript stored for match" }, { status: 404, headers: corsHeaders });
      updateProofStatus(matchId, "proving");
      const proofRequestedAt = Date.now();
      const onProofResult = (artifacts: ProofArtifacts | null, source?: string) => {
        if (artifacts) {
          updateProofTimestamps(matchId, proofRequestedAt, Date.now(), source || "unknown");
          updateProofStatus(matchId, "verified", artifacts);
          if (artifacts.boundlessRequestId) updateBoundlessRequestId(matchId, artifacts.boundlessRequestId);
          const sessionId = record.sessionId ?? 0;
          autoSettleMatch(matchId, sessionId, artifacts);
        } else {
          updateProofStatus(matchId, "pending");
        }
      };
      proveMatch(
        matchId,
        transcript,
        onProofResult,
        (requestId) => updateBoundlessRequestId(matchId, requestId),
        (txHash) => updateBoundlessTxHash(matchId, txHash),
      );
      console.log(`[admin] Re-prove triggered for ${matchId}`);
      return Response.json({ ok: true, matchId }, { headers: corsHeaders });
    }

    // API status endpoint
    if (url.pathname === "/api/status") {
      return Response.json(
        {
          name: "chickenz-server",
          region: process.env.SERVER_REGION || "unknown",
          activeRooms: [...rooms.values()].filter((r) => !r.isEnded()).length,
          lobbyClients: lobbySockets.size,
        },
        { headers: corsHeaders },
      );
    }

    // Static file serving (production client build)
    const STATIC_DIR = new URL("../public", import.meta.url).pathname;
    const staticDirWithSep = STATIC_DIR.endsWith("/") ? STATIC_DIR : STATIC_DIR + "/";
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const resolved = normalize(resolve(STATIC_DIR, "." + filePath));
    if (!resolved.startsWith(staticDirWithSep) && resolved !== STATIC_DIR) {
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
      allSockets.add(ws);
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

      // ── Ping/pong (RTT measurement) ─────────────────────
      if (msg.type === "ping") {
        const t = typeof msg.t === "number" ? msg.t : 0;
        ws.send(JSON.stringify({ type: "pong", t }));
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
        const addr = (msg.address ?? "").trim();
        if (addr && /^[CG][A-Z2-7]{55}$/.test(addr)) {
          ws.data.walletAddress = addr;
          // Don't trust client-supplied verified flag; require server-side verification
          ws.data.walletVerified = false;
        } else {
          // Empty or invalid address = wallet disconnected — clear verified state
          ws.data.walletAddress = "";
          ws.data.walletVerified = false;
        }
        return;
      }

      // Store character choices from any room-related message
      if ("character" in msg && typeof msg.character === "number") {
        const ch = msg.character;
        if (ch >= 0 && ch <= 3) ws.data.character = ch;
      }
      if ("awayCharacter" in msg && typeof msg.awayCharacter === "number") {
        const ch = msg.awayCharacter;
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
        if (ws.data.roomId || ws.data.tournamentId) {
          ws.send(JSON.stringify({ type: "error", message: "Already in a room or tournament" }));
          return;
        }

        const isPrivate = !!msg.isPrivate;
        const mode: GameMode = msg.mode === "ranked" ? "ranked" : "casual";
        if (mode === "ranked" && !ws.data.walletVerified) {
          ws.send(JSON.stringify({ type: "error", message: "Verified wallet required for ranked" }));
          return;
        }
        const name = isPrivate ? "Private Match" : "Public Match";
        const roomId = generateRoomId();
        const room = new GameRoom(roomId, name, ws, isPrivate, mode);
        ensureUniqueJoinCode(room);
        room.onEnded = returnToLobby;
        room.onStarted = onMatchStarted;
        rooms.set(roomId, room);
        lobbySockets.delete(ws);
        broadcastLobby();

        // Auto-add bot after 5s if no human joins (casual only, not private)
        if (mode === "casual" && !isPrivate) {
          const playerElo = getCasualElo(ws.data.username || "");
          const difficulty = Math.max(0, Math.min(1, (playerElo - 500) / 1000));
          botLobbyManager.watchHumanRoom(roomId, () => {
            if (room.isWaiting()) room.addBot(difficulty);
          });
        }
        return;
      }

      // ── Join by room ID ────────────────────────────────────
      if (msg.type === "join_room") {
        if (ws.data.roomId || ws.data.tournamentId) {
          ws.send(JSON.stringify({ type: "error", message: "Already in a room or tournament" }));
          return;
        }

        // Check if this is a fake bot lobby room
        const fakeRoom = botLobbyManager.getFakeRoom(msg.roomId);
        if (fakeRoom) {
          const botName = botLobbyManager.consumeFakeRoom(msg.roomId);
          if (botName) {
            const roomId = generateRoomId();
            const room = new GameRoom(roomId, "Public Match", ws, false, "casual", true);
            ensureUniqueJoinCode(room);
            room.onEnded = returnToLobby;
            room.onStarted = onMatchStarted;
            rooms.set(roomId, room);
            lobbySockets.delete(ws);
            const playerElo = getCasualElo(ws.data.username || "");
            const difficulty = Math.max(0, Math.min(1, (playerElo - 500) / 1000));
            room.addBot(difficulty, botName);
            broadcastLobby();
            return;
          }
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
        if (room.mode === "ranked" && !ws.data.walletVerified) {
          ws.send(JSON.stringify({ type: "error", message: "Verified wallet required for ranked" }));
          return;
        }

        // Cancel bot auto-join timer if a human is joining
        botLobbyManager.cancelWatch(msg.roomId);
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

        // Check if code matches a fake bot lobby room
        const fakeByCode = botLobbyManager.findByJoinCode(code);
        if (fakeByCode) {
          const botName = botLobbyManager.consumeFakeRoom(fakeByCode.id);
          if (botName) {
            const roomId = generateRoomId();
            const room = new GameRoom(roomId, "Public Match", ws, false, "casual", true);
            ensureUniqueJoinCode(room);
            room.onEnded = returnToLobby;
            room.onStarted = onMatchStarted;
            rooms.set(roomId, room);
            lobbySockets.delete(ws);
            const playerElo = getCasualElo(ws.data.username || "");
            const difficulty = Math.max(0, Math.min(1, (playerElo - 500) / 1000));
            room.addBot(difficulty, botName);
            broadcastLobby();
            return;
          }
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

        // Enforce wallet verification for ranked rooms (same as join_room)
        if (room.mode === "ranked" && !ws.data.walletVerified) {
          ws.send(JSON.stringify({ type: "error", message: "Verified wallet required for ranked" }));
          return;
        }

        // Cancel bot auto-join timer if a human is joining
        botLobbyManager.cancelWatch(room.id);
        room.addPlayer(ws);
        lobbySockets.delete(ws);
        broadcastLobby();
        return;
      }

      // ── Quickplay (auto-match) ───────────────────────────
      if (msg.type === "quickplay") {
        if (ws.data.roomId || ws.data.tournamentId) {
          ws.send(JSON.stringify({ type: "error", message: "Already in a room or tournament" }));
          return;
        }

        const mode: GameMode = msg.mode === "ranked" ? "ranked" : "casual";
        if (mode === "ranked" && !ws.data.walletVerified) {
          ws.send(JSON.stringify({ type: "error", message: "Verified wallet required for ranked" }));
          return;
        }

        // Find first waiting PUBLIC room with matching mode
        let matched = false;
        for (const room of rooms.values()) {
          if (room.isWaiting() && !room.isPrivate && room.mode === mode) {
            botLobbyManager.cancelWatch(room.id);
            room.addPlayer(ws);
            lobbySockets.delete(ws);
            broadcastLobby();
            matched = true;
            break;
          }
        }

        // If no real room matched and casual, try joining a fake bot room instantly
        if (!matched && mode === "casual") {
          const fakeRooms = botLobbyManager.getFakeRooms();
          if (fakeRooms.length > 0) {
            const fake = fakeRooms[Math.floor(Math.random() * fakeRooms.length)]!;
            const botName = botLobbyManager.consumeFakeRoom(fake.id);
            if (botName) {
              const roomId = generateRoomId();
              const room = new GameRoom(roomId, "Quick Play", ws, false, "casual", true);
              ensureUniqueJoinCode(room);
              room.onEnded = returnToLobby;
              room.onStarted = onMatchStarted;
              rooms.set(roomId, room);
              lobbySockets.delete(ws);
              const playerElo = getCasualElo(ws.data.username || "");
              const difficulty = Math.max(0, Math.min(1, (playerElo - 500) / 1000));
              room.addBot(difficulty, botName);
              broadcastLobby();
              matched = true;
            }
          }
        }

        if (!matched) {
          const roomId = generateRoomId();
          const room = new GameRoom(roomId, "Quick Play", ws, false, mode);
          ensureUniqueJoinCode(room);
          room.onEnded = returnToLobby;
          room.onStarted = onMatchStarted;
          rooms.set(roomId, room);
          lobbySockets.delete(ws);
          broadcastLobby();

          // Auto-add bot after 5s if no human joins (casual only)
          if (mode === "casual") {
            const playerElo = getCasualElo(ws.data.username || "");
            const difficulty = Math.max(0, Math.min(1, (playerElo - 500) / 1000));
            botLobbyManager.watchHumanRoom(roomId, () => {
              if (room.isWaiting()) room.addBot(difficulty);
            });
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
        let tournamentId: string;
        do {
          tournamentId = crypto.randomUUID().slice(0, 8);
        } while (tournaments.has(tournamentId));
        const tournament = new TournamentRoom(tournamentId, ws);
        ensureUniqueJoinCode(tournament);
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
        const code = (msg.code ?? "").trim().toUpperCase();
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

      // ── Add bot to room ────────────────────────────────────
      if (msg.type === "add_bot") {
        const roomId = ws.data.roomId;
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (room && room.isWaiting() && room.playerCount === 1 && room.mode !== "ranked") {
          botLobbyManager.cancelWatch(roomId);
          const playerElo = getCasualElo(ws.data.username || "");
          const difficulty = Math.max(0, Math.min(1, (playerElo - 500) / 1000));
          room.addBot(difficulty);
          broadcastLobby();
        }
        return;
      }

      // ── Game input ───────────────────────────────────────
      if (msg.type === "input") {
        // Validate input fields (applies to both regular and tournament games)
        if (typeof msg.buttons !== "number" || !Number.isInteger(msg.buttons) || msg.buttons < 0 || msg.buttons > 0x1f)
          return;
        if (!Number.isFinite(msg.aimX) || !Number.isFinite(msg.aimY)) return;
        msg.aimX = Math.max(-1, Math.min(1, Math.round(msg.aimX)));
        msg.aimY = Math.max(-1, Math.min(1, Math.round(msg.aimY)));

        // Tournament input: route through tournament's active game room
        const tournamentId = ws.data.tournamentId;
        if (tournamentId) {
          const tournament = tournaments.get(tournamentId);
          if (tournament) {
            tournament.handleInput(ws, msg as InputMessage);
          }
          return;
        }
        const roomId = ws.data.roomId;
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        room.handleInput(ws.data.playerId, msg);
        return;
      }
    },

    close(ws: ServerWebSocket<SocketData>) {
      allSockets.delete(ws);
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

// Start bot lobby system
botLobbyManager.start();

// Bot-vs-bot exhibition matches — spawn one every 2-5 minutes
function spawnBotVsBotMatch() {
  const roomId = generateRoomId();
  const bot0Name = randomBotName();
  const bot0Socket = createBotSocket(bot0Name);
  const diff0 = 0.2 + Math.random() * 0.6; // 0.2-0.8
  const diff1 = 0.2 + Math.random() * 0.6;
  const room = new GameRoom(roomId, "Public Match", bot0Socket, false, "casual", true);
  ensureUniqueJoinCode(room);
  room.onEnded = (sockets, winner, rid, roomName, scores, mode) => {
    // Record match history
    const matchId = generateMatchId();
    room.matchRecordId = matchId;
    const record: MatchRecord = {
      id: matchId,
      sessionId: room.sessionId,
      roomName,
      player1: sockets[0]?.data.username || "Bot 1",
      player2: sockets[1]?.data.username || "Bot 2",
      wallet1: "",
      wallet2: "",
      winner,
      scores,
      timestamp: Date.now(),
      proofStatus: "none",
      roomId: rid,
      mode,
      matchStartTime: room.matchStartTime,
    };
    insertMatch(record);
    markBotVsBot(matchId);
    const fullTranscript = room.getFullTranscript();
    saveTranscript(matchId, fullTranscript);
    pruneBotVsBotTranscripts();
    // Release both bot names
    releaseBotName(bot0Name);
    if (room.botName) releaseBotName(room.botName);
    cleanupRoom(rid);
    broadcastLobby();
  };
  room.makeBotVsBot(diff0);
  room.addBot(diff1);
  rooms.set(roomId, room);
  broadcastLobby();
}

const BOT_MATCH_MIN_MS = 2 * 60_000; // 2 minutes
const BOT_MATCH_MAX_MS = 5 * 60_000; // 5 minutes
function scheduleBotVsBotMatch() {
  const delay = BOT_MATCH_MIN_MS + Math.random() * (BOT_MATCH_MAX_MS - BOT_MATCH_MIN_MS);
  setTimeout(() => {
    spawnBotVsBotMatch();
    scheduleBotVsBotMatch();
  }, delay);
}
scheduleBotVsBotMatch();

console.log(`Chickenz server running on http://localhost:${server.port}`);
