import { describe, expect, test } from "bun:test";
import {
  inputFromMessage,
  isValidBracketType,
  isValidMatchFormat,
  validateTournamentConfig,
  validatePartialTournamentConfig,
  generateJoinCode,
} from "./protocol";
import type { InputMessage } from "./protocol";

// ── inputFromMessage ──────────────────────────────────────────

describe("inputFromMessage", () => {
  test("passes through valid buttons within 0x1f mask", () => {
    const msg: InputMessage = { type: "input", buttons: 0b10101, aimX: 0, aimY: 0 };
    const input = inputFromMessage(msg);
    expect(input.buttons).toBe(0b10101);
  });

  test("masks buttons to lower 5 bits (0x1f)", () => {
    // 0xFF = 11111111, masked to 0x1F = 00011111
    const msg: InputMessage = { type: "input", buttons: 0xff, aimX: 0, aimY: 0 };
    const input = inputFromMessage(msg);
    expect(input.buttons).toBe(0x1f);
  });

  test("masks high bits off buttons", () => {
    // 0b11100000 = only high bits set, should be masked to 0
    const msg: InputMessage = { type: "input", buttons: 0b11100000, aimX: 0, aimY: 0 };
    const input = inputFromMessage(msg);
    expect(input.buttons).toBe(0);
  });

  test("buttons=0 stays 0", () => {
    const msg: InputMessage = { type: "input", buttons: 0, aimX: 0, aimY: 0 };
    const input = inputFromMessage(msg);
    expect(input.buttons).toBe(0);
  });

  test("non-finite buttons treated as 0", () => {
    const msg: InputMessage = { type: "input", buttons: NaN, aimX: 0, aimY: 0 };
    const input = inputFromMessage(msg);
    expect(input.buttons).toBe(0);
  });

  test("Infinity buttons treated as 0", () => {
    const msg: InputMessage = { type: "input", buttons: Infinity, aimX: 0, aimY: 0 };
    const input = inputFromMessage(msg);
    expect(input.buttons).toBe(0);
  });

  test("aimX clamped to -1", () => {
    const msg: InputMessage = { type: "input", buttons: 0, aimX: -1, aimY: 0 };
    const input = inputFromMessage(msg);
    expect(input.aimX).toBe(-1);
  });

  test("aimX clamped to 1", () => {
    const msg: InputMessage = { type: "input", buttons: 0, aimX: 1, aimY: 0 };
    const input = inputFromMessage(msg);
    expect(input.aimX).toBe(1);
  });

  test("aimX=0 stays 0", () => {
    const msg: InputMessage = { type: "input", buttons: 0, aimX: 0, aimY: 0 };
    const input = inputFromMessage(msg);
    expect(input.aimX).toBe(0);
  });

  test("invalid aimX values clamped to 0", () => {
    for (const bad of [2, -2, 0.5, -0.5, 99, NaN]) {
      const msg: InputMessage = { type: "input", buttons: 0, aimX: bad, aimY: 0 };
      const input = inputFromMessage(msg);
      expect(input.aimX).toBe(0);
    }
  });

  test("aimY clamped to -1", () => {
    const msg: InputMessage = { type: "input", buttons: 0, aimX: 0, aimY: -1 };
    const input = inputFromMessage(msg);
    expect(input.aimY).toBe(-1);
  });

  test("aimY clamped to 1", () => {
    const msg: InputMessage = { type: "input", buttons: 0, aimX: 0, aimY: 1 };
    const input = inputFromMessage(msg);
    expect(input.aimY).toBe(1);
  });

  test("invalid aimY values clamped to 0", () => {
    for (const bad of [2, -2, 0.5, -0.5, 99, NaN]) {
      const msg: InputMessage = { type: "input", buttons: 0, aimX: 0, aimY: bad };
      const input = inputFromMessage(msg);
      expect(input.aimY).toBe(0);
    }
  });

  test("full valid input passes through correctly", () => {
    const msg: InputMessage = { type: "input", buttons: 0b11111, aimX: -1, aimY: 1 };
    const input = inputFromMessage(msg);
    expect(input.buttons).toBe(0b11111);
    expect(input.aimX).toBe(-1);
    expect(input.aimY).toBe(1);
  });
});

// ── isValidBracketType ───────────────────────────────────────

describe("isValidBracketType", () => {
  test("accepts winners_only", () => {
    expect(isValidBracketType("winners_only")).toBe(true);
  });

  test("accepts partial_consolation", () => {
    expect(isValidBracketType("partial_consolation")).toBe(true);
  });

  test("accepts full_consolation", () => {
    expect(isValidBracketType("full_consolation")).toBe(true);
  });

  test("rejects invalid strings", () => {
    expect(isValidBracketType("double_elimination")).toBe(false);
    expect(isValidBracketType("")).toBe(false);
    expect(isValidBracketType("WINNERS_ONLY")).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(isValidBracketType(null)).toBe(false);
    expect(isValidBracketType(undefined)).toBe(false);
    expect(isValidBracketType(42)).toBe(false);
    expect(isValidBracketType({})).toBe(false);
    expect(isValidBracketType(true)).toBe(false);
  });
});

// ── isValidMatchFormat ───────────────────────────────────────

describe("isValidMatchFormat", () => {
  test("accepts bo3", () => {
    expect(isValidMatchFormat("bo3")).toBe(true);
  });

  test("accepts bo5", () => {
    expect(isValidMatchFormat("bo5")).toBe(true);
  });

  test("rejects invalid strings", () => {
    expect(isValidMatchFormat("bo1")).toBe(false);
    expect(isValidMatchFormat("bo7")).toBe(false);
    expect(isValidMatchFormat("")).toBe(false);
    expect(isValidMatchFormat("BO3")).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(isValidMatchFormat(null)).toBe(false);
    expect(isValidMatchFormat(undefined)).toBe(false);
    expect(isValidMatchFormat(3)).toBe(false);
    expect(isValidMatchFormat([])).toBe(false);
  });
});

// ── validateTournamentConfig ─────────────────────────────────

describe("validateTournamentConfig", () => {
  test("returns valid config when both fields are valid", () => {
    const config = validateTournamentConfig({
      bracketType: "winners_only",
      matchFormat: "bo3",
    });
    expect(config).toEqual({
      bracketType: "winners_only",
      matchFormat: "bo3",
    });
  });

  test("defaults bracketType to partial_consolation when missing", () => {
    const config = validateTournamentConfig({ matchFormat: "bo3" });
    expect(config).toEqual({
      bracketType: "partial_consolation",
      matchFormat: "bo3",
    });
  });

  test("defaults matchFormat to bo5 when missing", () => {
    const config = validateTournamentConfig({ bracketType: "full_consolation" });
    expect(config).toEqual({
      bracketType: "full_consolation",
      matchFormat: "bo5",
    });
  });

  test("returns undefined for null input", () => {
    expect(validateTournamentConfig(null)).toBeUndefined();
  });

  test("returns undefined for non-object input", () => {
    expect(validateTournamentConfig("string")).toBeUndefined();
    expect(validateTournamentConfig(42)).toBeUndefined();
    expect(validateTournamentConfig(true)).toBeUndefined();
  });

  test("returns undefined for empty object (no valid fields)", () => {
    expect(validateTournamentConfig({})).toBeUndefined();
  });

  test("returns undefined when both fields are invalid", () => {
    expect(
      validateTournamentConfig({ bracketType: "invalid", matchFormat: "invalid" }),
    ).toBeUndefined();
  });

  test("returns undefined for undefined input", () => {
    expect(validateTournamentConfig(undefined)).toBeUndefined();
  });

  test("ignores extra fields", () => {
    const config = validateTournamentConfig({
      bracketType: "winners_only",
      matchFormat: "bo3",
      extra: "ignored",
    });
    expect(config).toEqual({
      bracketType: "winners_only",
      matchFormat: "bo3",
    });
  });
});

// ── validatePartialTournamentConfig ──────────────────────────

describe("validatePartialTournamentConfig", () => {
  test("returns both fields when both are valid", () => {
    const config = validatePartialTournamentConfig({
      bracketType: "full_consolation",
      matchFormat: "bo5",
    });
    expect(config).toEqual({
      bracketType: "full_consolation",
      matchFormat: "bo5",
    });
  });

  test("returns only bracketType when matchFormat is invalid", () => {
    const config = validatePartialTournamentConfig({
      bracketType: "winners_only",
      matchFormat: "invalid",
    });
    expect(config).toEqual({ bracketType: "winners_only" });
  });

  test("returns only matchFormat when bracketType is invalid", () => {
    const config = validatePartialTournamentConfig({
      matchFormat: "bo3",
      bracketType: "invalid",
    });
    expect(config).toEqual({ matchFormat: "bo3" });
  });

  test("returns undefined for null input", () => {
    expect(validatePartialTournamentConfig(null)).toBeUndefined();
  });

  test("returns undefined for non-object input", () => {
    expect(validatePartialTournamentConfig("string")).toBeUndefined();
    expect(validatePartialTournamentConfig(42)).toBeUndefined();
  });

  test("returns undefined for empty object", () => {
    expect(validatePartialTournamentConfig({})).toBeUndefined();
  });

  test("returns undefined when all fields are invalid", () => {
    expect(
      validatePartialTournamentConfig({ bracketType: "bad", matchFormat: "bad" }),
    ).toBeUndefined();
  });

  test("returns undefined for undefined input", () => {
    expect(validatePartialTournamentConfig(undefined)).toBeUndefined();
  });
});

// ── generateJoinCode ─────────────────────────────────────────

describe("generateJoinCode", () => {
  test("returns a 5-character string", () => {
    const code = generateJoinCode();
    expect(code).toHaveLength(5);
  });

  test("contains only uppercase letters (no I or O)", () => {
    // Run multiple times to increase confidence
    for (let i = 0; i < 100; i++) {
      const code = generateJoinCode();
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ]+$/);
      expect(code).not.toMatch(/[IO]/);
    }
  });

  test("generates different codes (not all identical)", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) {
      codes.add(generateJoinCode());
    }
    // With 24^5 = ~7.9M possible codes, 50 attempts should produce many unique values
    expect(codes.size).toBeGreaterThan(1);
  });

  test("contains only alphabetic characters (no digits)", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateJoinCode();
      expect(code).toMatch(/^[A-Z]+$/);
    }
  });
});
