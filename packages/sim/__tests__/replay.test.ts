import { describe, test, expect } from "bun:test";
import { step } from "../src/step";
import { createInitialState } from "../src/index";
import { hashGameState } from "../src/hash";
import type { MatchConfig, InputMap, PlayerInput } from "../src/types";
import { Button } from "../src/types";
import { ARENA } from "../src/map";
import {
  INITIAL_LIVES,
  MATCH_DURATION_TICKS,
  SUDDEN_DEATH_START_TICK,
} from "../src/constants";

const config: MatchConfig = {
  seed: 42,
  map: ARENA,
  playerCount: 2,
  tickRate: 60,
  initialLives: INITIAL_LIVES,
  matchDurationTicks: MATCH_DURATION_TICKS,
  suddenDeathStartTick: SUDDEN_DEATH_START_TICK,
};

/** Generate a scripted input sequence for replay testing. */
function generateScriptedInputs(totalTicks: number): InputMap[] {
  const inputs: InputMap[] = [];
  for (let t = 0; t < totalTicks; t++) {
    const map = new Map<number, PlayerInput>();

    // Player 0: moves right, periodically jumps and shoots
    let p0buttons = Button.Right;
    if (t % 60 < 10) p0buttons |= Button.Jump;
    if (t % 20 === 0) p0buttons |= Button.Shoot;
    // Reverse direction periodically
    if (t % 120 > 60) p0buttons = (p0buttons & ~Button.Right) | Button.Left;
    map.set(0, { buttons: p0buttons, aimX: t % 120 > 60 ? -1 : 1, aimY: 0 });

    // Player 1: moves left, jumps, shoots at player 0
    let p1buttons = Button.Left;
    if (t % 45 < 8) p1buttons |= Button.Jump;
    if (t % 25 === 5) p1buttons |= Button.Shoot;
    if (t % 100 > 50) p1buttons = (p1buttons & ~Button.Left) | Button.Right;
    map.set(1, { buttons: p1buttons, aimX: t % 100 > 50 ? 1 : -1, aimY: -0.3 });

    inputs.push(map);
  }
  return inputs;
}

function runSimulation(
  cfg: MatchConfig,
  scriptedInputs: InputMap[],
  hashInterval: number,
): { hashes: Map<number, number>; finalState: ReturnType<typeof createInitialState> } {
  let state = createInitialState(cfg);
  let prevInputs: InputMap = new Map();
  const hashes = new Map<number, number>();

  hashes.set(0, hashGameState(state));

  for (let t = 0; t < scriptedInputs.length; t++) {
    const inputs = scriptedInputs[t]!;
    state = step(state, inputs, prevInputs, cfg);
    prevInputs = inputs;

    if ((t + 1) % hashInterval === 0) {
      hashes.set(t + 1, hashGameState(state));
    }
  }

  return { hashes, finalState: state };
}

describe("replay determinism", () => {
  test("600 ticks with scripted inputs produce identical hashes on replay", () => {
    const totalTicks = 600;
    const hashInterval = 60;
    const scriptedInputs = generateScriptedInputs(totalTicks);

    // Run 1
    const run1 = runSimulation(config, scriptedInputs, hashInterval);

    // Run 2 — exact same seed + inputs
    const run2 = runSimulation(config, scriptedInputs, hashInterval);

    // All intermediate hashes must match
    for (const [tick, hash] of run1.hashes) {
      expect(run2.hashes.get(tick)).toBe(hash);
    }

    // Final state hash must match
    expect(hashGameState(run1.finalState)).toBe(hashGameState(run2.finalState));

    // Sanity: we actually checked multiple intervals
    expect(run1.hashes.size).toBe(11); // tick 0 + 10 intervals
  });

  test("different seeds produce different final states", () => {
    const totalTicks = 300;
    const scriptedInputs = generateScriptedInputs(totalTicks);

    const config1 = { ...config, seed: 42 };
    const config2 = { ...config, seed: 999 };

    const run1 = runSimulation(config1, scriptedInputs, totalTicks);
    const run2 = runSimulation(config2, scriptedInputs, totalTicks);

    expect(hashGameState(run1.finalState)).not.toBe(hashGameState(run2.finalState));
  });

  test("hash is stable — known state produces known hash", () => {
    const state = createInitialState(config);
    const h1 = hashGameState(state);
    const h2 = hashGameState(state);
    expect(h1).toBe(h2);
    expect(typeof h1).toBe("number");
    expect(h1).toBeGreaterThan(0);
  });
});
