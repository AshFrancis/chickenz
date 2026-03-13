import { describe, expect, test } from "bun:test";
import {
  nextPow2,
  standardSeedOrder,
  generateBracket,
} from "./TournamentRoom";
import type { BracketMatch } from "./protocol";

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
