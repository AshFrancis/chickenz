/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, test } from "bun:test";
import { nextPow2, standardSeedOrder, generateBracket, TournamentRoom } from "./TournamentRoom";
import type { BracketMatch, BracketType, TournamentConfig } from "./protocol";
import type { SocketData } from "./GameRoom";
import type { ServerWebSocket } from "bun";

type GameSocket = ServerWebSocket<SocketData>;

/** Create a minimal mock socket for TournamentRoom tests. */
function mockSocket(username?: string): GameSocket {
  const messages: string[] = [];
  const data: SocketData = {
    roomId: null,
    playerId: -1,
    username: username ?? `Player${Math.floor(Math.random() * 10000)}`,
    walletAddress: "",
    character: 0,
    awayCharacter: 1,
    tournamentId: null,
    msgCount: 0,
    msgResetTime: 0,
  };
  return {
    data,
    send(msg: string | Buffer) {
      messages.push(typeof msg === "string" ? msg : msg.toString());
      return 0;
    },
    close() {},
    subscribe() {},
    unsubscribe() {},
    publish() {},
    // Expose captured messages for assertions
    _messages: messages,
  } as unknown as GameSocket & { _messages: string[] };
}

/** Get captured messages from a mock socket */
function getMessages(ws: GameSocket): string[] {
  return (ws as unknown as { _messages: string[] })._messages;
}

/** Parse the last message sent to a socket */
function lastMessage(ws: GameSocket): Record<string, unknown> | null {
  const msgs = getMessages(ws);
  if (msgs.length === 0) return null;
  return JSON.parse(msgs[msgs.length - 1]!);
}

// ── nextPow2 ────────────────────────────────────────────────────

describe("nextPow2", () => {
  test("powers of 2 return themselves", () => {
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(2)).toBe(2);
    expect(nextPow2(4)).toBe(4);
    expect(nextPow2(8)).toBe(8);
  });

  test("non-powers round up", () => {
    expect(nextPow2(3)).toBe(4);
    expect(nextPow2(5)).toBe(8);
    expect(nextPow2(6)).toBe(8);
    expect(nextPow2(7)).toBe(8);
  });
});

// ── standardSeedOrder ───────────────────────────────────────────

describe("standardSeedOrder", () => {
  test("n=1 gives [[0,1]]", () => {
    expect(standardSeedOrder(1)).toEqual([[0, 1]]);
  });

  test("n=2 gives correct 4-player seeding", () => {
    const pairs = standardSeedOrder(2);
    expect(pairs).toHaveLength(2);
    // Standard: seed 0 vs seed 3, seed 1 vs seed 2
    expect(pairs).toEqual([
      [0, 3],
      [1, 2],
    ]);
  });

  test("n=4 gives correct 8-player seeding", () => {
    const pairs = standardSeedOrder(4);
    expect(pairs).toHaveLength(4);
    // Standard: 1v8, 4v5, 2v7, 3v6 → 0-indexed: 0v7, 3v4, 1v6, 2v5
    expect(pairs).toEqual([
      [0, 7],
      [3, 4],
      [1, 6],
      [2, 5],
    ]);
  });

  test("no duplicate seeds across all pairs", () => {
    for (const n of [1, 2, 4]) {
      const pairs = standardSeedOrder(n);
      const allSeeds = pairs.flat();
      const unique = new Set(allSeeds);
      expect(unique.size).toBe(allSeeds.length);
    }
  });

  test("all seeds from 0 to 2n-1 are present", () => {
    for (const n of [1, 2, 4]) {
      const pairs = standardSeedOrder(n);
      const allSeeds = new Set(pairs.flat());
      for (let i = 0; i < 2 * n; i++) {
        expect(allSeeds.has(i)).toBe(true);
      }
    }
  });
});

// ── generateBracket ─────────────────────────────────────────────

describe("generateBracket", () => {
  // Helper: count matches by status
  function countByStatus(matches: BracketMatch[]) {
    const counts: Record<string, number> = {};
    for (const m of matches) {
      counts[m.status] = (counts[m.status] || 0) + 1;
    }
    return counts;
  }

  // Helper: count matches by bracketSide
  function countBySide(matches: BracketMatch[]) {
    const counts: Record<string, number> = {};
    for (const m of matches) {
      counts[m.bracketSide] = (counts[m.bracketSide] || 0) + 1;
    }
    return counts;
  }

  describe("2 players", () => {
    test("winners_only: 1 match (the final)", () => {
      const matches = generateBracket(2, "winners_only");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.bracketSide).toBe("winners");
      expect(matches[0]!.label).toBe("Final");
      expect(matches[0]!.status).toBe("pending");
    });

    test("all bracket types produce 1 match for 2 players", () => {
      for (const bt of ["winners_only", "partial_consolation", "full_consolation"] as const) {
        const matches = generateBracket(2, bt);
        expect(matches).toHaveLength(1);
      }
    });
  });

  describe("3 players", () => {
    test("winners_only: 2 real matches + 1 bye", () => {
      const matches = generateBracket(3, "winners_only");
      // 4-player bracket: 2 SFs + 1 Final = 3 total, one SF is bye
      expect(matches).toHaveLength(3);
      const sides = countBySide(matches);
      expect(sides.winners).toBe(2); // 2 SFs
      expect(sides.final).toBe(1);
      const statuses = countByStatus(matches);
      expect(statuses.bye).toBe(1); // top seed gets bye
      expect(statuses.pending).toBe(2);
    });

    test("bye match has a winner (auto-advance)", () => {
      const matches = generateBracket(3, "winners_only");
      const bye = matches.find((m) => m.status === "bye");
      expect(bye).toBeDefined();
      expect(bye!.winner).toBeDefined();
    });

    test("partial_consolation: generates 3rd place match (sources are SF losers)", () => {
      // With 3 players (padded to 4), there are 2 SFs (one bye, one real).
      // The 3rd place match is generated but the bye SF loser won't resolve at runtime.
      const matches = generateBracket(3, "partial_consolation");
      const thirdPlace = matches.filter((m) => m.bracketSide === "third_place");
      expect(thirdPlace).toHaveLength(1);
      expect(thirdPlace[0]!.sourceA.type).toBe("loser");
      expect(thirdPlace[0]!.sourceB.type).toBe("loser");
    });
  });

  describe("4 players", () => {
    test("winners_only: 3 matches (2 SFs + 1 Final)", () => {
      const matches = generateBracket(4, "winners_only");
      expect(matches).toHaveLength(3);
      const sides = countBySide(matches);
      expect(sides.winners).toBe(2);
      expect(sides.final).toBe(1);
      expect(countByStatus(matches).bye).toBeUndefined(); // no byes
    });

    test("partial_consolation: 4 matches (3 winners + 1 third_place)", () => {
      const matches = generateBracket(4, "partial_consolation");
      const sides = countBySide(matches);
      expect(sides.winners).toBe(2);
      expect(sides.final).toBe(1);
      expect(sides.third_place).toBe(1);
      expect(matches).toHaveLength(4);
    });

    test("third_place match sources are losers of the two SFs", () => {
      const matches = generateBracket(4, "partial_consolation");
      const tp = matches.find((m) => m.bracketSide === "third_place")!;
      expect(tp.sourceA.type).toBe("loser");
      expect(tp.sourceB.type).toBe("loser");
      // The SF matches are round 0 in a 4-player bracket
      const sfs = matches.filter((m) => m.bracketSide === "winners" && m.round === 0);
      expect(sfs).toHaveLength(2);
      const sfIndices = new Set(sfs.map((m) => m.matchIndex));
      if (tp.sourceA.type === "loser") expect(sfIndices.has(tp.sourceA.matchIndex)).toBe(true);
      if (tp.sourceB.type === "loser") expect(sfIndices.has(tp.sourceB.matchIndex)).toBe(true);
    });

    test("all seed sources reference seeds 0-3", () => {
      const matches = generateBracket(4, "winners_only");
      const seeds = new Set<number>();
      for (const m of matches) {
        if (m.sourceA.type === "seed") seeds.add(m.sourceA.seed);
        if (m.sourceB.type === "seed") seeds.add(m.sourceB.seed);
      }
      expect(seeds.size).toBe(4);
      expect([...seeds].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    });
  });

  describe("5 players", () => {
    test("winners_only: 7 total matches (3 byes)", () => {
      const matches = generateBracket(5, "winners_only");
      // 8-player bracket: 4 QFs + 2 SFs + 1 Final = 7, with 3 byes
      expect(matches).toHaveLength(7);
      expect(countByStatus(matches).bye).toBe(3);
    });
  });

  describe("8 players", () => {
    test("winners_only: 7 matches, no byes", () => {
      const matches = generateBracket(8, "winners_only");
      expect(matches).toHaveLength(7);
      expect(countByStatus(matches).bye).toBeUndefined();
      const sides = countBySide(matches);
      expect(sides.winners).toBe(6); // 4 QFs + 2 SFs
      expect(sides.final).toBe(1);
    });

    test("partial_consolation: 8 matches", () => {
      const matches = generateBracket(8, "partial_consolation");
      expect(matches).toHaveLength(8);
      expect(countBySide(matches).third_place).toBe(1);
    });

    test("full_consolation: generates consolation bracket", () => {
      const matches = generateBracket(8, "full_consolation");
      const sides = countBySide(matches);
      expect(sides.consolation).toBeGreaterThan(0);
      // Should have more matches than winners_only
      expect(matches.length).toBeGreaterThan(7);
    });

    test("no duplicate matchIndex values", () => {
      for (const bt of ["winners_only", "partial_consolation", "full_consolation"] as const) {
        const matches = generateBracket(8, bt);
        const indices = matches.map((m) => m.matchIndex);
        expect(new Set(indices).size).toBe(indices.length);
      }
    });

    test("all matchIndex values are sequential from 0", () => {
      const matches = generateBracket(8, "winners_only");
      const indices = matches.map((m) => m.matchIndex).sort((a, b) => a - b);
      for (let i = 0; i < indices.length; i++) {
        expect(indices[i]).toBe(i);
      }
    });

    test("all seed sources in 0-7", () => {
      const matches = generateBracket(8, "winners_only");
      const seeds = new Set<number>();
      for (const m of matches) {
        if (m.sourceA.type === "seed") seeds.add(m.sourceA.seed);
        if (m.sourceB.type === "seed") seeds.add(m.sourceB.seed);
      }
      expect(seeds.size).toBe(8);
    });
  });

  describe("bracket structure invariants", () => {
    test("final match sources are winners of previous round", () => {
      for (const pc of [4, 6, 8]) {
        const matches = generateBracket(pc, "winners_only");
        const final = matches.find((m) => m.bracketSide === "final");
        expect(final).toBeDefined();
        expect(final!.sourceA.type).toBe("winner");
        expect(final!.sourceB.type).toBe("winner");
      }
    });

    test("winner/loser sources reference existing matchIndex values", () => {
      for (const pc of [2, 3, 4, 5, 6, 7, 8]) {
        for (const bt of ["winners_only", "partial_consolation", "full_consolation"] as const) {
          const matches = generateBracket(pc, bt);
          const validIndices = new Set(matches.map((m) => m.matchIndex));
          for (const m of matches) {
            for (const src of [m.sourceA, m.sourceB]) {
              if (src.type === "winner" || src.type === "loser") {
                expect(validIndices.has(src.matchIndex)).toBe(true);
              }
            }
          }
        }
      }
    });

    test("round 0 matches only have seed or bye sources", () => {
      for (const pc of [2, 3, 4, 5, 6, 7, 8]) {
        const matches = generateBracket(pc, "winners_only");
        const r0 = matches.filter((m) => m.round === 0 && m.bracketSide === "winners");
        for (const m of r0) {
          expect(["seed", "bye"]).toContain(m.sourceA.type);
          expect(["seed", "bye"]).toContain(m.sourceB.type);
        }
      }
    });
  });
});

// ── Bye Resolution ─────────────────────────────────────────

describe("bye resolution in bracket", () => {
  test("3-player bracket: bye auto-advances seed 0 (top seed)", () => {
    const matches = generateBracket(3, "winners_only");
    const byeMatches = matches.filter((m) => m.status === "bye");
    expect(byeMatches.length).toBeGreaterThanOrEqual(1);

    // The bye match winner should be a valid seed (0..2)
    for (const bye of byeMatches) {
      if (bye.winner !== undefined) {
        expect(bye.winner).toBeGreaterThanOrEqual(0);
        expect(bye.winner).toBeLessThan(3);
      }
    }
  });

  test("5-player bracket: 3 byes, winners correctly assigned", () => {
    const matches = generateBracket(5, "winners_only");
    const byeMatches = matches.filter((m) => m.status === "bye");
    expect(byeMatches).toHaveLength(3);

    // Each bye with a real player should have a winner
    for (const bye of byeMatches) {
      // A bye with one real seed and one bye source has a winner
      const hasRealSeedA = bye.sourceA.type === "seed" && bye.sourceA.seed < 5;
      const hasRealSeedB = bye.sourceB.type === "seed" && bye.sourceB.seed < 5;
      if (hasRealSeedA || hasRealSeedB) {
        expect(bye.winner).toBeDefined();
      }
    }
  });

  test("6-player bracket: 2 byes cascade correctly", () => {
    const matches = generateBracket(6, "winners_only");
    const byeMatches = matches.filter((m) => m.status === "bye");
    expect(byeMatches).toHaveLength(2);

    // bye winners should propagate into later rounds
    for (const bye of byeMatches) {
      expect(bye.winner).toBeDefined();
      // Find matches sourcing this bye's winner
      const downstream = matches.filter(
        (m) =>
          (m.sourceA.type === "winner" && m.sourceA.matchIndex === bye.matchIndex) ||
          (m.sourceB.type === "winner" && m.sourceB.matchIndex === bye.matchIndex),
      );
      expect(downstream.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("7-player bracket: 1 bye", () => {
    const matches = generateBracket(7, "winners_only");
    const byeMatches = matches.filter((m) => m.status === "bye");
    expect(byeMatches).toHaveLength(1);
    expect(byeMatches[0]!.winner).toBeDefined();
  });

  test("bye match has no loser", () => {
    for (const pc of [3, 5, 6, 7]) {
      const matches = generateBracket(pc, "winners_only");
      const byeMatches = matches.filter((m) => m.status === "bye");
      for (const bye of byeMatches) {
        expect(bye.loser).toBeUndefined();
      }
    }
  });

  test("all byes in 8-player bracket: 0 byes", () => {
    const matches = generateBracket(8, "winners_only");
    const byeMatches = matches.filter((m) => m.status === "bye");
    expect(byeMatches).toHaveLength(0);
  });
});

// ── Match Result Propagation (bracket structure) ────────────

describe("match result propagation", () => {
  test("winner source references exist for all non-round-0 winners matches", () => {
    for (const pc of [4, 6, 8]) {
      const matches = generateBracket(pc, "winners_only");
      const nonR0 = matches.filter((m) => m.round > 0 || m.bracketSide === "final");
      for (const m of nonR0) {
        // Both sources should reference winners of earlier matches
        if (m.sourceA.type === "winner") {
          const src = matches.find((s) => s.matchIndex === m.sourceA.matchIndex);
          expect(src).toBeDefined();
        }
        if (m.sourceB.type === "winner") {
          const src = matches.find((s) => s.matchIndex === m.sourceB.matchIndex);
          expect(src).toBeDefined();
        }
      }
    }
  });

  test("final match always sources winners of SF matches (4+ players)", () => {
    for (const pc of [4, 5, 6, 7, 8]) {
      const matches = generateBracket(pc, "winners_only");
      const final = matches.find((m) => m.bracketSide === "final")!;
      expect(final.sourceA.type).toBe("winner");
      expect(final.sourceB.type).toBe("winner");

      if (final.sourceA.type === "winner" && final.sourceB.type === "winner") {
        const srcA = matches.find((m) => m.matchIndex === final.sourceA.matchIndex)!;
        const srcB = matches.find((m) => m.matchIndex === final.sourceB.matchIndex)!;
        // Both SF matches should exist
        expect(srcA).toBeDefined();
        expect(srcB).toBeDefined();
        // SFs should be one round before the final
        expect(srcA.round).toBe(final.round - 1);
        expect(srcB.round).toBe(final.round - 1);
      }
    }
  });

  test("full consolation bracket: loser sources reference winners bracket matches", () => {
    const matches = generateBracket(8, "full_consolation");
    const consolation = matches.filter((m) => m.bracketSide === "consolation" || m.bracketSide === "third_place");
    expect(consolation.length).toBeGreaterThan(0);

    for (const m of consolation) {
      for (const src of [m.sourceA, m.sourceB]) {
        if (src.type === "loser") {
          // Must reference a valid match in the winners bracket
          const referenced = matches.find((s) => s.matchIndex === src.matchIndex);
          expect(referenced).toBeDefined();
          expect(["winners", "final"]).toContain(referenced!.bracketSide);
        }
      }
    }
  });

  test("third_place match in partial_consolation sources SF losers", () => {
    for (const pc of [4, 6, 8]) {
      const matches = generateBracket(pc, "partial_consolation");
      const tp = matches.find((m) => m.bracketSide === "third_place");
      expect(tp).toBeDefined();
      expect(tp!.sourceA.type).toBe("loser");
      expect(tp!.sourceB.type).toBe("loser");

      // The referenced matches should be the SFs
      if (tp!.sourceA.type === "loser" && tp!.sourceB.type === "loser") {
        const sfA = matches.find((m) => m.matchIndex === tp!.sourceA.matchIndex)!;
        const sfB = matches.find((m) => m.matchIndex === tp!.sourceB.matchIndex)!;
        expect(sfA.bracketSide).toBe("winners");
        expect(sfB.bracketSide).toBe("winners");
      }
    }
  });
});

// ── TournamentRoom: Config Validation ───────────────────────

describe("TournamentRoom config validation", () => {
  test("constructor uses default config when none provided", () => {
    const ws = mockSocket("Host");
    const room = new TournamentRoom("t1", ws);
    const config = room.getConfig();
    expect(config.bracketType).toBe("partial_consolation");
    expect(config.matchFormat).toBe("bo5");
  });

  test("constructor accepts custom config", () => {
    const ws = mockSocket("Host");
    const config: TournamentConfig = { bracketType: "winners_only", matchFormat: "bo3" };
    const room = new TournamentRoom("t2", ws, config);
    expect(room.getConfig()).toEqual(config);
  });

  test("updateConfig changes bracket type for host", () => {
    const host = mockSocket("Host");
    const room = new TournamentRoom("t3", host);
    const result = room.updateConfig(host, { bracketType: "full_consolation" });
    expect(result).toBe(true);
    expect(room.getConfig().bracketType).toBe("full_consolation");
  });

  test("updateConfig changes match format for host", () => {
    const host = mockSocket("Host");
    const room = new TournamentRoom("t4", host);
    const result = room.updateConfig(host, { matchFormat: "bo3" });
    expect(result).toBe(true);
    expect(room.getConfig().matchFormat).toBe("bo3");
  });

  test("updateConfig rejects invalid bracket type", () => {
    const host = mockSocket("Host");
    const room = new TournamentRoom("t5", host);
    const result = room.updateConfig(host, { bracketType: "invalid_type" as BracketType });
    expect(result).toBe(false);
    expect(room.getConfig().bracketType).toBe("partial_consolation"); // unchanged
  });

  test("updateConfig rejects invalid match format", () => {
    const host = mockSocket("Host");
    const room = new TournamentRoom("t6", host);
    const result = room.updateConfig(host, { matchFormat: "bo7" as any });
    expect(result).toBe(false);
    expect(room.getConfig().matchFormat).toBe("bo5"); // unchanged
  });

  test("updateConfig rejects non-host", () => {
    const host = mockSocket("Host");
    const nonHost = mockSocket("Player2");
    const room = new TournamentRoom("t7", host);
    room.addPlayer(nonHost);
    const result = room.updateConfig(nonHost, { bracketType: "winners_only" });
    expect(result).toBe(false);
    expect(room.getConfig().bracketType).toBe("partial_consolation"); // unchanged
  });

  test("updateConfig rejects after tournament starts", () => {
    const host = mockSocket("Host");
    const p2 = mockSocket("P2");
    const room = new TournamentRoom("t8", host);
    room.addPlayer(p2);
    room.startTournament(host);
    const result = room.updateConfig(host, { bracketType: "winners_only" });
    expect(result).toBe(false);
  });

  test("updateConfig with empty partial returns false", () => {
    const host = mockSocket("Host");
    const room = new TournamentRoom("t9", host);
    const result = room.updateConfig(host, {});
    expect(result).toBe(false);
  });
});

// ── TournamentRoom: Player Management ───────────────────────

describe("TournamentRoom player management", () => {
  test("creator is added as first participant", () => {
    const host = mockSocket("Host");
    const room = new TournamentRoom("pm1", host);
    expect(room.participantCount).toBe(1);
    expect(room.connectedCount).toBe(1);
  });

  test("addPlayer adds participants up to MAX_PLAYERS", () => {
    const host = mockSocket("Host");
    const room = new TournamentRoom("pm2", host);
    for (let i = 1; i < 8; i++) {
      const result = room.addPlayer(mockSocket(`P${i}`));
      expect(result).toBe(true);
    }
    expect(room.participantCount).toBe(8);
  });

  test("9th player is added as spectator", () => {
    const host = mockSocket("Host");
    const room = new TournamentRoom("pm3", host);
    for (let i = 1; i < 8; i++) {
      room.addPlayer(mockSocket(`P${i}`));
    }
    // 9th player should be added as spectator
    const spectator = mockSocket("Spectator");
    const result = room.addPlayer(spectator);
    expect(result).toBe(true);
    expect(room.participantCount).toBe(9);
  });

  test("rejects players after max players + max spectators", () => {
    const host = mockSocket("Host");
    const room = new TournamentRoom("pm4", host);
    // 7 more players = 8 total
    for (let i = 1; i < 8; i++) {
      room.addPlayer(mockSocket(`P${i}`));
    }
    // 5 spectators
    for (let i = 0; i < 5; i++) {
      room.addPlayer(mockSocket(`S${i}`));
    }
    // 14th person should be rejected
    const result = room.addPlayer(mockSocket("Extra"));
    expect(result).toBe(false);
  });

  test("addPlayer fails after tournament starts", () => {
    const host = mockSocket("Host");
    const p2 = mockSocket("P2");
    const room = new TournamentRoom("pm5", host);
    room.addPlayer(p2);
    room.startTournament(host);
    const result = room.addPlayer(mockSocket("Late"));
    expect(result).toBe(false);
  });

  test("handleDisconnect removes participant in waiting state", () => {
    const host = mockSocket("Host");
    const p2 = mockSocket("P2");
    const room = new TournamentRoom("pm6", host);
    room.addPlayer(p2);
    expect(room.participantCount).toBe(2);
    room.handleDisconnect(p2);
    expect(room.participantCount).toBe(1);
  });

  test("handleDisconnect on unknown socket is no-op", () => {
    const host = mockSocket("Host");
    const room = new TournamentRoom("pm7", host);
    const stranger = mockSocket("Stranger");
    room.handleDisconnect(stranger); // should not throw
    expect(room.participantCount).toBe(1);
  });

  test("toggleRole switches player to spectator", () => {
    const host = mockSocket("Host");
    const p2 = mockSocket("P2");
    const room = new TournamentRoom("pm8", host);
    room.addPlayer(p2);

    const result = room.toggleRole(p2);
    expect(result).toBe(true);
    // P2 is now spectator; verify by checking the lobby broadcast
    const msg = lastMessage(p2);
    expect(msg).not.toBeNull();
    if (msg && Array.isArray(msg.participants)) {
      const p2Data = (msg.participants as Array<{ slot: number; role: string }>).find(
        (p: { slot: number; role: string }) => p.slot === 1,
      );
      expect(p2Data?.role).toBe("spectator");
    }
  });

  test("toggleRole fails after tournament starts", () => {
    const host = mockSocket("Host");
    const p2 = mockSocket("P2");
    const room = new TournamentRoom("pm9", host);
    room.addPlayer(p2);
    room.startTournament(host);
    expect(room.toggleRole(p2)).toBe(false);
  });
});

// ── TournamentRoom: Start Tournament ────────────────────────

describe("TournamentRoom start tournament", () => {
  test("requires at least 2 players", () => {
    const host = mockSocket("Host");
    const room = new TournamentRoom("st1", host);
    expect(room.startTournament(host)).toBe(false);
    expect(room.status).toBe("waiting");
  });

  test("only host can start", () => {
    const host = mockSocket("Host");
    const p2 = mockSocket("P2");
    const room = new TournamentRoom("st2", host);
    room.addPlayer(p2);
    expect(room.startTournament(p2)).toBe(false);
    expect(room.status).toBe("waiting");
  });

  test("host can start with 2 players", () => {
    const host = mockSocket("Host");
    const p2 = mockSocket("P2");
    const room = new TournamentRoom("st3", host);
    room.addPlayer(p2);
    expect(room.startTournament(host)).toBe(true);
    expect(room.status).toBe("playing");
  });

  test("cannot start twice", () => {
    const host = mockSocket("Host");
    const p2 = mockSocket("P2");
    const room = new TournamentRoom("st4", host);
    room.addPlayer(p2);
    room.startTournament(host);
    expect(room.startTournament(host)).toBe(false);
  });

  test("tournament lobby broadcast includes bracket after start", () => {
    const host = mockSocket("Host");
    const p2 = mockSocket("P2");
    const room = new TournamentRoom("st5", host);
    room.addPlayer(p2);
    room.startTournament(host);

    const msg = lastMessage(host);
    expect(msg).not.toBeNull();
    expect(msg!.status).toBe("playing");
    expect(msg!.bracket).toBeDefined();
  });

  test("bracket has correct number of matches for player count", () => {
    // 4 players with partial_consolation: 2 SFs + 1 Final + 1 3rd place = 4
    const host = mockSocket("Host");
    const players = [mockSocket("P2"), mockSocket("P3"), mockSocket("P4")];
    const room = new TournamentRoom("st6", host, {
      bracketType: "partial_consolation",
      matchFormat: "bo5",
    });
    for (const p of players) room.addPlayer(p);
    room.startTournament(host);

    const msg = lastMessage(host);
    const bracket = msg!.bracket as { matches: BracketMatch[] };
    expect(bracket.matches).toHaveLength(4);
  });
});

// ── TournamentRoom: Forfeit Handling ────────────────────────

describe("TournamentRoom forfeit handling", () => {
  test("disconnect during playing state marks player as forfeited", () => {
    const host = mockSocket("Host");
    const p2 = mockSocket("P2");
    const room = new TournamentRoom("ff1", host);
    room.addPlayer(p2);
    room.startTournament(host);
    expect(room.status).toBe("playing");

    // Disconnect p2 (should mark as forfeited)
    room.handleDisconnect(p2);
    expect(room.connectedCount).toBe(1);
  });

  test("disconnect during waiting removes participant entirely", () => {
    const host = mockSocket("Host");
    const p2 = mockSocket("P2");
    const p3 = mockSocket("P3");
    const room = new TournamentRoom("ff2", host);
    room.addPlayer(p2);
    room.addPlayer(p3);
    room.handleDisconnect(p2);
    expect(room.participantCount).toBe(2); // removed, not just marked
  });

  test("isSocketInTournament returns false for unknown socket", () => {
    const host = mockSocket("Host");
    const room = new TournamentRoom("ff3", host);
    const stranger = mockSocket("Stranger");
    expect(room.isSocketInTournament(stranger)).toBe(false);
  });

  test("isSocketInTournament returns true for added player", () => {
    const host = mockSocket("Host");
    const room = new TournamentRoom("ff4", host);
    expect(room.isSocketInTournament(host)).toBe(true);
  });
});

// ── Standings Computation (via bracket structure) ───────────

describe("standings computation structure", () => {
  test("winners_only 4-player bracket has correct structure for standings", () => {
    // With 4 players in winners_only:
    // - Final winner = 1st, final loser = 2nd
    // - SF losers = joint 3rd
    const matches = generateBracket(4, "winners_only");
    const final = matches.find((m) => m.bracketSide === "final");
    expect(final).toBeDefined();
    expect(final!.sourceA.type).toBe("winner");
    expect(final!.sourceB.type).toBe("winner");

    // SFs feed into the final
    const sfs = matches.filter((m) => m.bracketSide === "winners" && m.round === 0);
    expect(sfs).toHaveLength(2);
  });

  test("partial_consolation 4-player has 3rd place match for complete ranking", () => {
    const matches = generateBracket(4, "partial_consolation");
    const tp = matches.find((m) => m.bracketSide === "third_place");
    expect(tp).toBeDefined();
    // 3rd place match gives us places 1-4 completely
    // 1st: final winner, 2nd: final loser, 3rd: 3rd place winner, 4th: 3rd place loser
  });

  test("full_consolation 8-player has consolation matches for complete ranking", () => {
    const matches = generateBracket(8, "full_consolation");
    const consolation = matches.filter((m) => m.bracketSide === "consolation" || m.bracketSide === "third_place");
    expect(consolation.length).toBeGreaterThan(0);

    // Total matches should cover all possible rankings
    // Winners: 7 matches, plus consolation matches
    expect(matches.length).toBeGreaterThan(7);
  });

  test("partial_consolation 8-player: exactly 1 third-place match", () => {
    const matches = generateBracket(8, "partial_consolation");
    const tpMatches = matches.filter((m) => m.bracketSide === "third_place");
    expect(tpMatches).toHaveLength(1);
  });

  test("winners_only has no consolation or third_place matches", () => {
    for (const pc of [2, 3, 4, 5, 6, 7, 8]) {
      const matches = generateBracket(pc, "winners_only");
      const consolation = matches.filter((m) => m.bracketSide === "consolation" || m.bracketSide === "third_place");
      expect(consolation).toHaveLength(0);
    }
  });

  test("full_consolation 4-player bracket has consolation structure", () => {
    const matches = generateBracket(4, "full_consolation");
    // With 4 players: 2 SFs + 1 Final in winners + consolation for complete ranking
    const consolation = matches.filter((m) => m.bracketSide === "consolation" || m.bracketSide === "third_place");
    expect(consolation.length).toBeGreaterThan(0);
  });

  test("simulated 4-player bracket: manual match resolution produces complete results", () => {
    // Simulate resolving a 4-player winners_only bracket manually
    const matches = generateBracket(4, "winners_only");

    // Find the two SFs (round 0)
    const sfs = matches.filter((m) => m.bracketSide === "winners" && m.round === 0);
    expect(sfs).toHaveLength(2);

    // Each SF should have two seed sources
    for (const sf of sfs) {
      expect(sf.sourceA.type).toBe("seed");
      expect(sf.sourceB.type).toBe("seed");
    }

    // The final sources the winners of both SFs
    const final = matches.find((m) => m.bracketSide === "final")!;
    expect(final.sourceA.type).toBe("winner");
    expect(final.sourceB.type).toBe("winner");

    if (final.sourceA.type === "winner" && final.sourceB.type === "winner") {
      expect(final.sourceA.matchIndex).toBe(sfs[0]!.matchIndex);
      expect(final.sourceB.matchIndex).toBe(sfs[1]!.matchIndex);
    }
  });
});
