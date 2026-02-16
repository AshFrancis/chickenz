import { describe, test, expect } from "bun:test";
import { step } from "../src/step";
import { createInitialState } from "../src/index";
import type { GameState, InputMap, MatchConfig, PlayerInput } from "../src/types";
import { Button, Facing, PlayerStateFlag, NULL_INPUT } from "../src/types";
import { ARENA } from "../src/map";
import {
  SHOOT_COOLDOWN,
  PROJECTILE_LIFETIME,
  RESPAWN_TICKS,
  INITIAL_LIVES,
  MATCH_DURATION_TICKS,
  SUDDEN_DEATH_START_TICK,
  MAX_HEALTH,
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

function inputMap(...entries: [number, PlayerInput][]): InputMap {
  return new Map(entries);
}

const NO_INPUTS: InputMap = new Map();

/** Advance state by N ticks with no inputs. */
function advanceTicks(state: GameState, n: number, cfg = config): GameState {
  let s = state;
  const empty = inputMap();
  for (let i = 0; i < n; i++) {
    s = step(s, empty, empty, cfg);
  }
  return s;
}

describe("step", () => {
  test("tick increments by 1", () => {
    const state = createInitialState(config);
    const next = step(state, NO_INPUTS, NO_INPUTS, config);
    expect(next.tick).toBe(1);
  });

  test("missing-input rule reuses previous input", () => {
    const state = createInitialState(config);
    const rightInput: PlayerInput = { buttons: Button.Right, aimX: 1, aimY: 0 };
    const prev = inputMap([0, rightInput]);

    // First tick: player 0 moves right
    const s1 = step(state, prev, NO_INPUTS, config);
    const p1x = s1.players[0]!.x;

    // Second tick: no inputs provided, should reuse previous
    const s2 = step(s1, NO_INPUTS, prev, config);
    const p2x = s2.players[0]!.x;

    // Player should have moved further right
    expect(p2x).toBeGreaterThan(p1x);
  });

  test("shooting spawns a projectile", () => {
    const state = createInitialState(config);
    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 1, aimY: 0 };
    const inputs = inputMap([0, shootInput]);
    const next = step(state, inputs, NO_INPUTS, config);
    expect(next.projectiles.length).toBe(1);
    expect(next.projectiles[0]!.ownerId).toBe(0);
  });

  test("cooldown prevents rapid fire", () => {
    const state = createInitialState(config);
    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 1, aimY: 0 };
    const inputs = inputMap([0, shootInput]);

    const s1 = step(state, inputs, NO_INPUTS, config);
    expect(s1.projectiles.length).toBe(1);
    expect(s1.players[0]!.shootCooldown).toBe(SHOOT_COOLDOWN);

    // Next tick — still shooting but on cooldown
    const s2 = step(s1, inputs, inputs, config);
    // Should still have only 1 projectile (the first one moved, no new one spawned)
    expect(s2.projectiles.length).toBe(1);
  });

  test("projectile expires after lifetime ticks", () => {
    const state = createInitialState(config);
    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 0, aimY: -1 }; // shoot up
    const inputs = inputMap([0, shootInput]);

    let s = step(state, inputs, NO_INPUTS, config);
    expect(s.projectiles.length).toBe(1);

    // Run until projectile expires (shoot up so it goes off-screen or expires)
    const emptyInputs = inputMap();
    for (let i = 0; i < PROJECTILE_LIFETIME + 10; i++) {
      s = step(s, emptyInputs, emptyInputs, config);
    }
    expect(s.projectiles.length).toBe(0);
  });

  test("hit detection — projectile damages player", () => {
    // Create a state and manually position players close together
    let state = createInitialState(config);

    // Place player 0 at x=100, player 1 at x=130 (close enough for projectile to hit)
    const players = state.players.map((p, i) => {
      if (i === 0) return { ...p, x: 100, y: 536 };
      if (i === 1) return { ...p, x: 130, y: 536 };
      return p;
    });
    state = { ...state, players };

    // Player 0 shoots right toward player 1
    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 1, aimY: 0 };
    const inputs = inputMap([0, shootInput]);

    let s = step(state, inputs, NO_INPUTS, config);

    // Run a few ticks for projectile to reach player 1
    const empty = inputMap();
    for (let i = 0; i < 10; i++) {
      s = step(s, empty, empty, config);
    }

    // Player 1 should have taken damage
    expect(s.players[1]!.health).toBeLessThan(100);
  });

  test("kill increments score", () => {
    let state = createInitialState(config);

    // Position players very close — player 1 right next to player 0's gun
    const players = state.players.map((p, i) => {
      if (i === 0) return { ...p, x: 100, y: 536 };
      if (i === 1) return { ...p, x: 120, y: 536, health: 25 }; // one hit to kill
      return p;
    });
    state = { ...state, players };

    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 1, aimY: 0 };
    const inputs = inputMap([0, shootInput]);

    let s = step(state, inputs, NO_INPUTS, config);

    // Run enough ticks for projectile to hit
    const empty = inputMap();
    for (let i = 0; i < 10; i++) {
      s = step(s, empty, empty, config);
    }

    expect(s.score.get(0)).toBeGreaterThanOrEqual(1);
  });
});

describe("lives system", () => {
  test("players start with initialLives", () => {
    const state = createInitialState(config);
    for (const p of state.players) {
      expect(p.lives).toBe(INITIAL_LIVES);
    }
  });

  test("lives decrement on kill", () => {
    let state = createInitialState(config);

    // Set player 1 to 1 HP so one hit kills
    const players = state.players.map((p, i) => {
      if (i === 0) return { ...p, x: 100, y: 536 };
      if (i === 1) return { ...p, x: 120, y: 536, health: 1 };
      return p;
    });
    state = { ...state, players };

    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 1, aimY: 0 };
    const inputs = inputMap([0, shootInput]);

    let s = step(state, inputs, NO_INPUTS, config);
    const empty = inputMap();
    for (let i = 0; i < 10; i++) {
      s = step(s, empty, empty, config);
    }

    // Player 1 should have lost a life
    expect(s.players[1]!.lives).toBe(INITIAL_LIVES - 1);
  });

  test("no respawn at 0 lives", () => {
    let state = createInitialState(config);

    // Player 1 has 1 life left and 1 HP
    const players = state.players.map((p, i) => {
      if (i === 0) return { ...p, x: 100, y: 536 };
      if (i === 1) return { ...p, x: 120, y: 536, health: 1, lives: 1 };
      return p;
    });
    state = { ...state, players };

    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 1, aimY: 0 };
    const inputs = inputMap([0, shootInput]);

    let s = step(state, inputs, NO_INPUTS, config);
    const empty = inputMap();
    // Run enough ticks for hit + respawn timer to fully elapse
    for (let i = 0; i < RESPAWN_TICKS + 20; i++) {
      s = step(s, empty, empty, config);
    }

    // Player 1 should stay dead — 0 lives, no respawn
    expect(s.players[1]!.lives).toBe(0);
    expect(s.players[1]!.stateFlags & PlayerStateFlag.Alive).toBe(0);
  });

  test("match ends on elimination", () => {
    let state = createInitialState(config);

    // Player 1 has 1 life, 1 HP
    const players = state.players.map((p, i) => {
      if (i === 0) return { ...p, x: 100, y: 536 };
      if (i === 1) return { ...p, x: 120, y: 536, health: 1, lives: 1 };
      return p;
    });
    state = { ...state, players };

    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 1, aimY: 0 };
    const inputs = inputMap([0, shootInput]);

    let s = step(state, inputs, NO_INPUTS, config);
    const empty = inputMap();
    for (let i = 0; i < 10; i++) {
      s = step(s, empty, empty, config);
    }

    expect(s.matchOver).toBe(true);
    expect(s.winner).toBe(0); // player 0 wins
  });

  test("matchOver early return prevents further state changes", () => {
    let state = createInitialState(config);
    state = { ...state, matchOver: true, winner: 0, tick: 100 };

    const s = step(state, NO_INPUTS, NO_INPUTS, config);
    expect(s.tick).toBe(100); // unchanged — early return
    expect(s).toBe(state); // exact same reference
  });
});

describe("sudden death", () => {
  test("arena walls close after suddenDeathStartTick", () => {
    // Use a short config for testing
    const shortConfig: MatchConfig = {
      ...config,
      matchDurationTicks: 100,
      suddenDeathStartTick: 50,
    };
    let state = createInitialState(shortConfig);

    // Advance to tick 51 (one tick into sudden death — tick 50 has 0 progress)
    state = advanceTicks(state, 51, shortConfig);
    expect(state.tick).toBe(51);
    // Arena should have started closing
    expect(state.arenaLeft).toBeGreaterThan(0);
    expect(state.arenaRight).toBeLessThan(shortConfig.map.width);
  });

  test("sudden death kills player outside closing walls", () => {
    const shortConfig: MatchConfig = {
      ...config,
      matchDurationTicks: 100,
      suddenDeathStartTick: 50,
    };
    let state = createInitialState(shortConfig);

    // Place players near edges — player 1 at far right
    const players = state.players.map((p, i) => {
      if (i === 0) return { ...p, x: 380, y: 536 }; // center, safe
      if (i === 1) return { ...p, x: 770, y: 536 }; // far right, will be caught
      return p;
    });
    state = { ...state, players };

    // Advance well past sudden death start so walls close enough
    state = advanceTicks(state, 80, shortConfig);

    // Player 1 should have lost at least one life from wall crush
    expect(state.players[1]!.lives).toBeLessThan(INITIAL_LIVES);
  });
});

describe("time-up", () => {
  test("match ends at matchDurationTicks", () => {
    const shortConfig: MatchConfig = {
      ...config,
      matchDurationTicks: 60,
      suddenDeathStartTick: 50,
    };
    let state = createInitialState(shortConfig);

    // Place players at center so they survive sudden death
    const players = state.players.map((p, i) => {
      if (i === 0) return { ...p, x: 380, y: 536 };
      if (i === 1) return { ...p, x: 390, y: 536 };
      return p;
    });
    state = { ...state, players };

    state = advanceTicks(state, 60, shortConfig);
    expect(state.matchOver).toBe(true);
  });

  test("time-up: player with more lives wins", () => {
    const shortConfig: MatchConfig = {
      ...config,
      matchDurationTicks: 20,
      suddenDeathStartTick: 20, // no sudden death
    };
    let state = createInitialState(shortConfig);

    // Player 0 has 3 lives, player 1 has 1 life
    const players = state.players.map((p, i) => {
      if (i === 1) return { ...p, lives: 1 };
      return p;
    });
    state = { ...state, players };

    state = advanceTicks(state, 20, shortConfig);
    expect(state.matchOver).toBe(true);
    expect(state.winner).toBe(0);
  });

  test("time-up: equal lives, more health wins", () => {
    const shortConfig: MatchConfig = {
      ...config,
      matchDurationTicks: 20,
      suddenDeathStartTick: 20,
    };
    let state = createInitialState(shortConfig);

    // Same lives, but player 0 has more health
    const players = state.players.map((p, i) => {
      if (i === 1) return { ...p, health: 50 };
      return p;
    });
    state = { ...state, players };

    state = advanceTicks(state, 20, shortConfig);
    expect(state.matchOver).toBe(true);
    expect(state.winner).toBe(0);
  });

  test("time-up: equal lives and health is a draw", () => {
    const shortConfig: MatchConfig = {
      ...config,
      matchDurationTicks: 20,
      suddenDeathStartTick: 20,
    };
    let state = createInitialState(shortConfig);
    state = advanceTicks(state, 20, shortConfig);
    expect(state.matchOver).toBe(true);
    expect(state.winner).toBe(-1);
  });
});
