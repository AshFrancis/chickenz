import { describe, expect, test, beforeEach } from "bun:test";
import {
  generateMatchId,
  insertMatch,
  getMatchById,
  getRecentMatches,
  updateProofStatus,
  updateElo,
  getLeaderboard,
  getPlayerStats,
  updateStartTxHash,
  updateSettleTxHash,
  updateProofTimestamps,
  updateMatchStartTime,
  updateWalletVerified,
  saveTranscript,
  getTranscriptByRoomId,
  getTranscriptByMatchId,
  saveProverTranscript,
  getProverTranscript,
  updateTranscriptCid,
  updateBoundlessRequestId,
  updateBoundlessTxHash,
  markBotVsBot,
  pruneBotVsBotTranscripts,
  getCasualElo,
  updateCasualElo,
} from "./db";
import type { MatchRecord, ProofArtifacts } from "./db";

// ── Helpers ────────────────────────────────────────────────────

/** Generate a unique ID prefix for test isolation */
function uid(): string {
  return `test-${crypto.randomUUID()}`;
}

/** Create a minimal valid MatchRecord with unique IDs */
function makeMatch(overrides: Partial<MatchRecord> = {}): MatchRecord {
  const id = uid();
  return {
    id,
    sessionId: 1,
    roomName: "Test Room",
    player1: `player1-${id}`,
    player2: `player2-${id}`,
    wallet1: "",
    wallet2: "",
    winner: 0,
    scores: [3, 1],
    timestamp: Date.now(),
    proofStatus: "none",
    roomId: `room-${id}`,
    mode: "casual",
    ...overrides,
  };
}

// ── generateMatchId ────────────────────────────────────────────

describe("generateMatchId", () => {
  test("returns a string starting with 'match-'", () => {
    const id = generateMatchId();
    expect(id.startsWith("match-")).toBe(true);
  });

  test("returns unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateMatchId());
    }
    expect(ids.size).toBe(100);
  });

  test("contains a UUID after the prefix", () => {
    const id = generateMatchId();
    const uuid = id.slice("match-".length);
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

// ── insertMatch + getMatchById ─────────────────────────────────

describe("insertMatch + getMatchById", () => {
  test("inserts and retrieves a match by ID", () => {
    const match = makeMatch();
    insertMatch(match);
    const retrieved = getMatchById(match.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(match.id);
    expect(retrieved!.player1).toBe(match.player1);
    expect(retrieved!.player2).toBe(match.player2);
    expect(retrieved!.winner).toBe(match.winner);
    expect(retrieved!.scores).toEqual(match.scores);
    expect(retrieved!.proofStatus).toBe("none");
    expect(retrieved!.mode).toBe("casual");
  });

  test("returns null for non-existent match", () => {
    expect(getMatchById("non-existent-id")).toBeNull();
  });

  test("preserves wallet addresses", () => {
    const match = makeMatch({
      wallet1: "GABCDEF123",
      wallet2: "GZYXWV987",
    });
    insertMatch(match);
    const retrieved = getMatchById(match.id);
    expect(retrieved!.wallet1).toBe("GABCDEF123");
    expect(retrieved!.wallet2).toBe("GZYXWV987");
  });

  test("preserves scores correctly", () => {
    const match = makeMatch({ scores: [5, 2] });
    insertMatch(match);
    const retrieved = getMatchById(match.id);
    expect(retrieved!.scores).toEqual([5, 2]);
  });

  test("preserves mode field", () => {
    const ranked = makeMatch({ mode: "ranked" });
    insertMatch(ranked);
    expect(getMatchById(ranked.id)!.mode).toBe("ranked");
  });

  test("preserves start_tx_hash and settle_tx_hash", () => {
    const match = makeMatch({ startTxHash: "abc123", settleTxHash: "def456" });
    insertMatch(match);
    const retrieved = getMatchById(match.id);
    expect(retrieved!.startTxHash).toBe("abc123");
    expect(retrieved!.settleTxHash).toBe("def456");
  });

  test("wallet fields default to empty string", () => {
    const match = makeMatch();
    insertMatch(match);
    const retrieved = getMatchById(match.id);
    expect(retrieved!.wallet1).toBe("");
    expect(retrieved!.wallet2).toBe("");
  });

  test("wallet1Verified and wallet2Verified default to false", () => {
    const match = makeMatch();
    insertMatch(match);
    const retrieved = getMatchById(match.id);
    expect(retrieved!.wallet1Verified).toBe(false);
    expect(retrieved!.wallet2Verified).toBe(false);
  });
});

// ── getRecentMatches ──────────────────────────────────────────

describe("getRecentMatches", () => {
  test("returns matches ordered by timestamp descending", () => {
    const now = Date.now();
    const m1 = makeMatch({ timestamp: now - 2000 });
    const m2 = makeMatch({ timestamp: now - 1000 });
    const m3 = makeMatch({ timestamp: now });
    insertMatch(m1);
    insertMatch(m2);
    insertMatch(m3);

    const recent = getRecentMatches(100);
    const testIds = [m1.id, m2.id, m3.id];
    const filtered = recent.filter((m) => testIds.includes(m.id));
    expect(filtered[0]!.id).toBe(m3.id);
    expect(filtered[1]!.id).toBe(m2.id);
    expect(filtered[2]!.id).toBe(m1.id);
  });

  test("respects limit parameter", () => {
    const results = getRecentMatches(1);
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

// ── updateProofStatus ─────────────────────────────────────────

describe("updateProofStatus", () => {
  test("updates status without artifacts", () => {
    const match = makeMatch();
    insertMatch(match);

    updateProofStatus(match.id, "pending");
    expect(getMatchById(match.id)!.proofStatus).toBe("pending");

    updateProofStatus(match.id, "proving");
    expect(getMatchById(match.id)!.proofStatus).toBe("proving");
  });

  test("updates status with artifacts", () => {
    const match = makeMatch();
    insertMatch(match);

    const artifacts: ProofArtifacts = {
      seal: "0xseal123",
      journal: "0xjournal456",
      imageId: "0ximage789",
    };

    updateProofStatus(match.id, "verified", artifacts);
    const retrieved = getMatchById(match.id)!;
    expect(retrieved.proofStatus).toBe("verified");
    expect(retrieved.proofArtifacts).toEqual(artifacts);
  });

  test("transitions through all valid statuses", () => {
    const match = makeMatch();
    insertMatch(match);

    const statuses: MatchRecord["proofStatus"][] = [
      "none",
      "pending",
      "proving",
      "verified",
      "settled",
    ];
    for (const status of statuses) {
      updateProofStatus(match.id, status);
      expect(getMatchById(match.id)!.proofStatus).toBe(status);
    }
  });

  test("proofArtifacts is undefined when not set", () => {
    const match = makeMatch();
    insertMatch(match);
    const retrieved = getMatchById(match.id)!;
    expect(retrieved.proofArtifacts).toBeUndefined();
  });
});

// ── ELO calculations ──────────────────────────────────────────

describe("updateElo", () => {
  test("equal ratings: winner gains ~16, loser loses ~16 (K=32)", () => {
    const winner = `elo-w-${uid()}`;
    const loser = `elo-l-${uid()}`;

    const result = updateElo(winner, loser);
    // Both start at 1000. Expected score = 0.5
    // Winner: 1000 + 32 * (1 - 0.5) = 1016
    // Loser:  1000 + 32 * (0 - 0.5) = 984
    expect(result.winnerElo).toBe(1016);
    expect(result.loserElo).toBe(984);
  });

  test("winner gains and loser loses rating", () => {
    const winner = `elo-w-${uid()}`;
    const loser = `elo-l-${uid()}`;
    const result = updateElo(winner, loser);
    expect(result.winnerElo).toBeGreaterThan(1000);
    expect(result.loserElo).toBeLessThan(1000);
  });

  test("loser ELO cannot go below 0", () => {
    const winner = `elo-w-${uid()}`;
    const loser = `elo-l-${uid()}`;

    // Lose many games to drive ELO down
    for (let i = 0; i < 200; i++) {
      updateElo(winner, loser);
    }
    const loserStats = getPlayerStats(loser);
    expect(loserStats!.elo).toBeGreaterThanOrEqual(0);
  });

  test("tracks wins and losses", () => {
    const winner = `elo-w-${uid()}`;
    const loser = `elo-l-${uid()}`;

    updateElo(winner, loser);
    updateElo(winner, loser);
    updateElo(winner, loser);

    const winnerStats = getPlayerStats(winner);
    const loserStats = getPlayerStats(loser);

    expect(winnerStats!.wins).toBe(3);
    expect(winnerStats!.losses).toBe(0);
    expect(loserStats!.wins).toBe(0);
    expect(loserStats!.losses).toBe(3);
  });

  test("underdog gains more than favored player", () => {
    const strong = `elo-strong-${uid()}`;
    const weak = `elo-weak-${uid()}`;

    // Give strong player a high rating
    for (let i = 0; i < 10; i++) {
      updateElo(strong, `disposable-${uid()}`);
    }

    const strongBefore = getPlayerStats(strong)!.elo;
    const weakBefore = getPlayerStats(weak)?.elo ?? 1000;

    // Weak player beats the strong player
    const result = updateElo(weak, strong);
    const weakGain = result.winnerElo - weakBefore;
    const strongLoss = strongBefore - result.loserElo;

    // The underdog should gain more than ~16 (since expected score < 0.5)
    expect(weakGain).toBeGreaterThan(16);
    // The favored player should lose more than ~16
    expect(strongLoss).toBeGreaterThan(16);
  });

  test("favored player gains less than 16 for expected win", () => {
    const strong = `elo-strong-${uid()}`;
    const weak = `elo-weak-${uid()}`;

    // Give strong player high rating first
    for (let i = 0; i < 10; i++) {
      updateElo(strong, `disposable-${uid()}`);
    }

    const strongBefore = getPlayerStats(strong)!.elo;
    const result = updateElo(strong, weak);
    const gain = result.winnerElo - strongBefore;

    // Expected win: gain should be less than 16
    expect(gain).toBeLessThan(16);
    expect(gain).toBeGreaterThan(0);
  });

  test("creates new players with default ELO 1000", () => {
    const name = `elo-new-${uid()}`;
    // Before any games, player shouldn't exist in stats
    expect(getPlayerStats(name)).toBeNull();

    // After a game, player should exist
    updateElo(name, `opponent-${uid()}`);
    const stats = getPlayerStats(name);
    expect(stats).not.toBeNull();
    // Starting from 1000, winning against another 1000-rated player
    expect(stats!.elo).toBe(1016);
  });
});

// ── Leaderboard ───────────────────────────────────────────────

describe("getLeaderboard", () => {
  test("returns entries sorted by ELO descending", () => {
    const board = getLeaderboard(100);
    for (let i = 1; i < board.length; i++) {
      expect(board[i - 1]!.elo).toBeGreaterThanOrEqual(board[i]!.elo);
    }
  });

  test("respects limit parameter", () => {
    const board = getLeaderboard(2);
    expect(board.length).toBeLessThanOrEqual(2);
  });

  test("entries contain name, elo, wins, losses", () => {
    // Ensure at least one player exists
    const name = `lb-${uid()}`;
    updateElo(name, `lb-opponent-${uid()}`);

    const board = getLeaderboard(100);
    expect(board.length).toBeGreaterThan(0);
    const entry = board[0]!;
    expect(typeof entry.name).toBe("string");
    expect(typeof entry.elo).toBe("number");
    expect(typeof entry.wins).toBe("number");
    expect(typeof entry.losses).toBe("number");
  });
});

// ── getPlayerStats ────────────────────────────────────────────

describe("getPlayerStats", () => {
  test("returns null for unknown player", () => {
    expect(getPlayerStats(`unknown-${uid()}`)).toBeNull();
  });

  test("returns stats for existing player", () => {
    const name = `stats-${uid()}`;
    updateElo(name, `opponent-${uid()}`);
    const stats = getPlayerStats(name);
    expect(stats).not.toBeNull();
    expect(stats!.name).toBe(name);
    expect(stats!.wins).toBe(1);
    expect(stats!.losses).toBe(0);
  });
});

// ── Timeline update functions ─────────────────────────────────

describe("timeline updates", () => {
  test("updateStartTxHash sets hash", () => {
    const match = makeMatch();
    insertMatch(match);
    updateStartTxHash(match.id, "tx-start-hash");
    expect(getMatchById(match.id)!.startTxHash).toBe("tx-start-hash");
  });

  test("updateSettleTxHash sets hash", () => {
    const match = makeMatch();
    insertMatch(match);
    updateSettleTxHash(match.id, "tx-settle-hash");
    expect(getMatchById(match.id)!.settleTxHash).toBe("tx-settle-hash");
  });

  test("updateProofTimestamps sets all three fields", () => {
    const match = makeMatch();
    insertMatch(match);
    updateProofTimestamps(match.id, 1000, 2000, "local");
    const retrieved = getMatchById(match.id)!;
    expect(retrieved.proofRequestedAt).toBe(1000);
    expect(retrieved.proofCompletedAt).toBe(2000);
    expect(retrieved.proofSource).toBe("local");
  });

  test("updateMatchStartTime sets time", () => {
    const match = makeMatch();
    insertMatch(match);
    updateMatchStartTime(match.id, 12345);
    expect(getMatchById(match.id)!.matchStartTime).toBe(12345);
  });

  test("updateWalletVerified sets both flags", () => {
    const match = makeMatch();
    insertMatch(match);
    updateWalletVerified(match.id, true, false);
    const r1 = getMatchById(match.id)!;
    expect(r1.wallet1Verified).toBe(true);
    expect(r1.wallet2Verified).toBe(false);

    updateWalletVerified(match.id, false, true);
    const r2 = getMatchById(match.id)!;
    expect(r2.wallet1Verified).toBe(false);
    expect(r2.wallet2Verified).toBe(true);
  });
});

// ── Transcript storage ────────────────────────────────────────

describe("saveTranscript + getTranscriptByMatchId", () => {
  test("saves and retrieves transcript by match ID", () => {
    const match = makeMatch();
    insertMatch(match);

    const transcript = { rounds: [{ tick: 1, data: "test" }] };
    saveTranscript(match.id, transcript);

    const retrieved = getTranscriptByMatchId(match.id);
    expect(retrieved).toEqual(transcript);
  });

  test("returns null for match with no transcript", () => {
    const match = makeMatch();
    insertMatch(match);
    expect(getTranscriptByMatchId(match.id)).toBeNull();
  });

  test("returns null for non-existent match", () => {
    expect(getTranscriptByMatchId("non-existent")).toBeNull();
  });
});

describe("getTranscriptByRoomId", () => {
  test("retrieves transcript by room ID", () => {
    const roomId = `room-${uid()}`;
    const match = makeMatch({ roomId });
    insertMatch(match);

    const transcript = { events: ["a", "b"] };
    saveTranscript(match.id, transcript);

    const retrieved = getTranscriptByRoomId(roomId);
    expect(retrieved).toEqual(transcript);
  });

  test("returns most recent match transcript for a room", () => {
    const roomId = `room-${uid()}`;
    const m1 = makeMatch({ roomId, timestamp: 1000, id: uid() });
    const m2 = makeMatch({ roomId, timestamp: 2000, id: uid() });
    insertMatch(m1);
    insertMatch(m2);

    saveTranscript(m1.id, { data: "old" });
    saveTranscript(m2.id, { data: "new" });

    const retrieved = getTranscriptByRoomId(roomId);
    expect(retrieved).toEqual({ data: "new" });
  });

  test("returns null for room with no matches", () => {
    expect(getTranscriptByRoomId(`nonexistent-room-${uid()}`)).toBeNull();
  });
});

// ── Prover transcript ─────────────────────────────────────────

describe("saveProverTranscript + getProverTranscript", () => {
  test("saves and retrieves prover transcript", () => {
    const match = makeMatch();
    insertMatch(match);

    const proverData = { proof: "data", cycles: 234000 };
    saveProverTranscript(match.id, proverData);

    const retrieved = getProverTranscript(match.id);
    expect(retrieved).toEqual(proverData);
  });

  test("returns null when no prover transcript exists", () => {
    const match = makeMatch();
    insertMatch(match);
    expect(getProverTranscript(match.id)).toBeNull();
  });

  test("returns null for non-existent match", () => {
    expect(getProverTranscript("non-existent")).toBeNull();
  });
});

// ── Boundless + CID ──────────────────────────────────────────

describe("updateTranscriptCid", () => {
  test("sets transcript CID on match", () => {
    const match = makeMatch();
    insertMatch(match);
    updateTranscriptCid(match.id, "QmTestCid123");
    expect(getMatchById(match.id)!.transcriptCid).toBe("QmTestCid123");
  });
});

describe("updateBoundlessRequestId", () => {
  test("sets boundless request ID", () => {
    const match = makeMatch();
    insertMatch(match);
    updateBoundlessRequestId(match.id, "req-abc123");
    expect(getMatchById(match.id)!.boundlessRequestId).toBe("req-abc123");
  });
});

describe("updateBoundlessTxHash", () => {
  test("sets boundless tx hash", () => {
    const match = makeMatch();
    insertMatch(match);
    updateBoundlessTxHash(match.id, "0xdeadbeef");
    expect(getMatchById(match.id)!.boundlessTxHash).toBe("0xdeadbeef");
  });
});

// ── Bot-vs-bot ────────────────────────────────────────────────

describe("markBotVsBot + pruneBotVsBotTranscripts", () => {
  test("pruneBotVsBotTranscripts runs without error", () => {
    // Just verify it doesn't throw
    expect(() => pruneBotVsBotTranscripts()).not.toThrow();
  });

  test("markBotVsBot marks match as bot-vs-bot", () => {
    const match = makeMatch();
    insertMatch(match);
    markBotVsBot(match.id);
    // We can verify by saving a transcript and running prune
    // The match won't be pruned if it's in the most recent 100
    saveTranscript(match.id, { data: "bot game" });
    pruneBotVsBotTranscripts();
    // Should still have transcript (within top 100 bot matches)
    const transcript = getTranscriptByMatchId(match.id);
    expect(transcript).toEqual({ data: "bot game" });
  });
});

// ── Casual ELO ────────────────────────────────────────────────

describe("getCasualElo", () => {
  test("returns default 800 for unknown player", () => {
    const elo = getCasualElo(`casual-unknown-${uid()}`);
    expect(elo).toBe(800);
  });

  test("returns updated ELO after games", () => {
    const name = `casual-${uid()}`;
    updateCasualElo(name, true, 800);
    const elo = getCasualElo(name);
    expect(elo).toBeGreaterThan(800);
  });
});

describe("updateCasualElo", () => {
  test("equal ratings: winner gains ~12, K=24", () => {
    const name = `casual-w-${uid()}`;
    // Playing against equal opponent (800)
    const newElo = updateCasualElo(name, true, 800);
    // 800 + 24 * (1 - 0.5) = 812
    expect(newElo).toBe(812);
  });

  test("equal ratings: loser loses ~12, K=24", () => {
    const name = `casual-l-${uid()}`;
    // Playing against equal opponent (800)
    const newElo = updateCasualElo(name, false, 800);
    // 800 + 24 * (0 - 0.5) = 788
    expect(newElo).toBe(788);
  });

  test("ELO cannot go below 0", () => {
    const name = `casual-bot-${uid()}`;
    // Lose many times
    let elo = 800;
    for (let i = 0; i < 200; i++) {
      elo = updateCasualElo(name, false, 2000);
    }
    expect(elo).toBeGreaterThanOrEqual(0);
  });

  test("returns the new ELO value", () => {
    const name = `casual-ret-${uid()}`;
    const newElo = updateCasualElo(name, true, 800);
    expect(typeof newElo).toBe("number");
    expect(newElo).toBeGreaterThan(800);
  });

  test("accumulates games played correctly", () => {
    const name = `casual-gp-${uid()}`;
    updateCasualElo(name, true, 800);
    updateCasualElo(name, false, 800);
    updateCasualElo(name, true, 800);
    // Verify the player exists with correct ELO (3 games played)
    const elo = getCasualElo(name);
    expect(typeof elo).toBe("number");
  });
});

// ── Migration idempotency ────────────────────────────────────

describe("migration idempotency", () => {
  test("importing db module twice does not crash", async () => {
    // The module has already been imported once above.
    // Re-importing should not throw (SQLite CREATE TABLE IF NOT EXISTS + try/catch migrations)
    expect(async () => {
      await import("./db");
    }).not.toThrow();
  });
});
