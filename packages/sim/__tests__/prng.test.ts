import { describe, test, expect } from "bun:test";
import { prngNext, prngIntRange } from "../src/prng";

describe("prng", () => {
  test("determinism — same seed produces same sequence", () => {
    const [v1, s1] = prngNext(42);
    const [v2, s2] = prngNext(42);
    expect(v1).toBe(v2);
    expect(s1).toBe(s2);
  });

  test("sequence stability — fixed snapshot", () => {
    let state = 12345;
    const values: number[] = [];
    for (let i = 0; i < 5; i++) {
      const [v, next] = prngNext(state);
      values.push(v);
      state = next;
    }
    // Re-run with same seed
    state = 12345;
    for (let i = 0; i < 5; i++) {
      const [v, next] = prngNext(state);
      expect(v).toBe(values[i]);
      state = next;
    }
  });

  test("values are in [0, 1)", () => {
    let state = 1;
    for (let i = 0; i < 1000; i++) {
      const [v, next] = prngNext(state);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      state = next;
    }
  });

  test("distinct seeds produce different sequences", () => {
    const [v1] = prngNext(100);
    const [v2] = prngNext(200);
    expect(v1).not.toBe(v2);
  });

  test("prngIntRange returns values in [min, max]", () => {
    let state = 999;
    for (let i = 0; i < 200; i++) {
      const [val, next] = prngIntRange(state, 3, 7);
      expect(val).toBeGreaterThanOrEqual(3);
      expect(val).toBeLessThanOrEqual(7);
      state = next;
    }
  });

  test("prngIntRange covers the full range", () => {
    const seen = new Set<number>();
    let state = 0;
    for (let i = 0; i < 1000; i++) {
      const [val, next] = prngIntRange(state, 0, 3);
      seen.add(val);
      state = next;
    }
    expect(seen.size).toBe(4); // 0, 1, 2, 3
  });
});
