import { describe, test, expect } from "bun:test";
import { step } from "../src/step";
import { createInitialState } from "../src/index";
import type { GameState, InputMap, MatchConfig, PlayerInput, PlayerState } from "../src/types";
import { Button, Facing, PlayerStateFlag, NULL_INPUT, WeaponType } from "../src/types";
import { ARENA } from "../src/map";
import {
  SHOOT_COOLDOWN,
  PROJECTILE_LIFETIME,
  RESPAWN_TICKS,
  INITIAL_LIVES,
  MATCH_DURATION_TICKS,
  SUDDEN_DEATH_START_TICK,
  MAX_HEALTH,
  WEAPON_STATS,
  WEAPON_PICKUP_RESPAWN_TICKS,
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

/** Give a player a weapon by modifying state directly. */
function armPlayer(state: GameState, playerId: number, weapon: WeaponType): GameState {
  const stats = WEAPON_STATS[weapon];
  const players = state.players.map((p) =>
    p.id === playerId ? { ...p, weapon, ammo: stats.ammo } : p,
  );
  return { ...state, players };
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

    const s1 = step(state, prev, NO_INPUTS, config);
    const p1x = s1.players[0]!.x;

    const s2 = step(s1, NO_INPUTS, prev, config);
    const p2x = s2.players[0]!.x;

    expect(p2x).toBeGreaterThan(p1x);
  });

  test("unarmed player cannot shoot", () => {
    const state = createInitialState(config);
    // Players start unarmed
    expect(state.players[0]!.weapon).toBeNull();
    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 1, aimY: 0 };
    const inputs = inputMap([0, shootInput]);
    const next = step(state, inputs, NO_INPUTS, config);
    expect(next.projectiles.length).toBe(0);
  });

  test("armed player can shoot", () => {
    let state = createInitialState(config);
    state = armPlayer(state, 0, WeaponType.Pistol);

    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 1, aimY: 0 };
    const inputs = inputMap([0, shootInput]);
    const next = step(state, inputs, NO_INPUTS, config);
    expect(next.projectiles.length).toBe(1);
    expect(next.projectiles[0]!.ownerId).toBe(0);
    expect(next.projectiles[0]!.weapon).toBe(WeaponType.Pistol);
  });

  test("cooldown prevents rapid fire", () => {
    let state = createInitialState(config);
    state = armPlayer(state, 0, WeaponType.Pistol);

    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 1, aimY: 0 };
    const inputs = inputMap([0, shootInput]);

    const s1 = step(state, inputs, NO_INPUTS, config);
    expect(s1.projectiles.length).toBe(1);
    const pistolCooldown = WEAPON_STATS[WeaponType.Pistol].cooldown;
    expect(s1.players[0]!.shootCooldown).toBe(pistolCooldown);

    const s2 = step(s1, inputs, inputs, config);
    expect(s2.projectiles.length).toBe(1); // still just one (moved)
  });

  test("projectile expires after lifetime ticks", () => {
    let state = createInitialState(config);
    state = armPlayer(state, 0, WeaponType.Pistol);

    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 0, aimY: -1 };
    const inputs = inputMap([0, shootInput]);

    let s = step(state, inputs, NO_INPUTS, config);
    expect(s.projectiles.length).toBe(1);

    const emptyInputs = inputMap();
    for (let i = 0; i < PROJECTILE_LIFETIME + 10; i++) {
      s = step(s, emptyInputs, emptyInputs, config);
    }
    expect(s.projectiles.length).toBe(0);
  });

  test("hit detection — projectile damages player", () => {
    let state = createInitialState(config);
    state = armPlayer(state, 0, WeaponType.Pistol);

    const players = state.players.map((p, i) => {
      if (i === 0) return { ...p, x: 100, y: 476 };
      if (i === 1) return { ...p, x: 150, y: 476 };
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

    expect(s.players[1]!.health).toBeLessThan(100);
  });

  test("kill increments score", () => {
    let state = createInitialState(config);
    state = armPlayer(state, 0, WeaponType.Pistol);

    const players = state.players.map((p, i) => {
      if (i === 0) return { ...p, x: 100, y: 476 };
      if (i === 1) return { ...p, x: 150, y: 476, health: 20 };
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

    expect(s.score.get(0)).toBeGreaterThanOrEqual(1);
  });
});

describe("weapon system", () => {
  test("players start unarmed", () => {
    const state = createInitialState(config);
    for (const p of state.players) {
      expect(p.weapon).toBeNull();
      expect(p.ammo).toBe(0);
    }
  });

  test("weapon pickups are created from map spawn points", () => {
    const state = createInitialState(config);
    expect(state.weaponPickups.length).toBe(ARENA.weaponSpawnPoints.length);
    for (const pickup of state.weaponPickups) {
      expect(pickup.respawnTimer).toBe(0);
    }
  });

  test("player picks up weapon on overlap", () => {
    let state = createInitialState(config);
    const pickup = state.weaponPickups[0]!;
    // Place player 0 at pickup location
    const players = state.players.map((p, i) =>
      i === 0 ? { ...p, x: pickup.x - 12, y: pickup.y - 16 } : p,
    );
    state = { ...state, players };

    const s = step(state, NO_INPUTS, NO_INPUTS, config);
    const p0 = s.players[0]!;
    expect(p0.weapon).toBe(pickup.weapon);
    expect(p0.ammo).toBe(WEAPON_STATS[pickup.weapon].ammo);
    // Pickup should be on respawn timer
    const updatedPickup = s.weaponPickups[0]!;
    expect(updatedPickup.respawnTimer).toBeGreaterThan(0);
  });

  test("pickup respawns after timer", () => {
    let state = createInitialState(config);
    // Set a pickup to respawn timer
    const pickups = state.weaponPickups.map((p, i) =>
      i === 0 ? { ...p, respawnTimer: 2 } : p,
    );
    state = { ...state, weaponPickups: pickups };

    let s = step(state, NO_INPUTS, NO_INPUTS, config);
    expect(s.weaponPickups[0]!.respawnTimer).toBe(1);

    s = step(s, NO_INPUTS, NO_INPUTS, config);
    expect(s.weaponPickups[0]!.respawnTimer).toBe(0); // available again
  });

  test("ammo depletes and weapon is dropped", () => {
    let state = createInitialState(config);
    // Give player 0 a pistol with 1 ammo
    const players = state.players.map((p, i) =>
      i === 0 ? { ...p, weapon: WeaponType.Pistol, ammo: 1, x: 100, y: 476 } : p,
    );
    state = { ...state, players };

    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 1, aimY: 0 };
    const inputs = inputMap([0, shootInput]);

    const s = step(state, inputs, NO_INPUTS, config);
    expect(s.projectiles.length).toBe(1);
    expect(s.players[0]!.ammo).toBe(0);
    expect(s.players[0]!.weapon).toBeNull(); // weapon dropped
  });

  test("shotgun fires 5 pellets", () => {
    let state = createInitialState(config);
    state = armPlayer(state, 0, WeaponType.Shotgun);

    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 1, aimY: 0 };
    const inputs = inputMap([0, shootInput]);

    const s = step(state, inputs, NO_INPUTS, config);
    expect(s.projectiles.length).toBe(5);
    for (const proj of s.projectiles) {
      expect(proj.weapon).toBe(WeaponType.Shotgun);
    }
  });

  test("shotgun pellets have spread", () => {
    let state = createInitialState(config);
    state = armPlayer(state, 0, WeaponType.Shotgun);

    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 1, aimY: 0 };
    const inputs = inputMap([0, shootInput]);

    const s = step(state, inputs, NO_INPUTS, config);
    // All pellets should have slightly different vy values due to spread
    const vys = s.projectiles.map((p) => p.vy);
    const uniqueVys = new Set(vys);
    expect(uniqueVys.size).toBeGreaterThan(1); // not all same direction
  });

  test("sniper does 80 damage", () => {
    let state = createInitialState(config);
    state = armPlayer(state, 0, WeaponType.Sniper);

    // Place players close together so the bullet hits quickly
    const players = state.players.map((p, i) => {
      if (i === 0) return { ...p, x: 100, y: 476 };
      if (i === 1) return { ...p, x: 180, y: 476 };
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

    expect(s.players[1]!.health).toBe(100 - WEAPON_STATS[WeaponType.Sniper].damage);
  });

  test("SMG has fast cooldown", () => {
    let state = createInitialState(config);
    state = armPlayer(state, 0, WeaponType.SMG);

    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 1, aimY: 0 };
    const inputs = inputMap([0, shootInput]);

    const s1 = step(state, inputs, NO_INPUTS, config);
    expect(s1.projectiles.length).toBe(1);
    expect(s1.players[0]!.shootCooldown).toBe(WEAPON_STATS[WeaponType.SMG].cooldown);

    // After cooldown, should fire again
    let s = s1;
    for (let i = 0; i < WEAPON_STATS[WeaponType.SMG].cooldown; i++) {
      s = step(s, inputs, inputs, config);
    }
    // Should have spawned another projectile
    expect(s.players[0]!.shootCooldown).toBe(WEAPON_STATS[WeaponType.SMG].cooldown);
  });

  test("respawn clears weapon", () => {
    let state = createInitialState(config);
    state = armPlayer(state, 1, WeaponType.Sniper);

    // Kill player 1 directly
    const players = state.players.map((p, i) =>
      i === 1
        ? { ...p, health: 0, stateFlags: 0, lives: 2 }
        : p,
    );
    // Remove all weapon pickups so respawned player can't pick one up immediately
    state = { ...state, players, weaponPickups: [] };

    // Advance through respawn
    let s = state;
    for (let i = 0; i < RESPAWN_TICKS + 5; i++) {
      s = step(s, NO_INPUTS, NO_INPUTS, config);
    }

    // Player 1 should be alive but unarmed
    expect(s.players[1]!.stateFlags & PlayerStateFlag.Alive).toBeTruthy();
    expect(s.players[1]!.weapon).toBeNull();
    expect(s.players[1]!.ammo).toBe(0);
  });

  test("projectile spawns at player edge, not center", () => {
    let state = createInitialState(config);
    state = armPlayer(state, 0, WeaponType.Pistol);
    // Place player at known position
    const players = state.players.map((p, i) =>
      i === 0 ? { ...p, x: 200, y: 476 } : p,
    );
    state = { ...state, players };

    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 1, aimY: 0 };
    const inputs = inputMap([0, shootInput]);

    const s = step(state, inputs, NO_INPUTS, config);
    const proj = s.projectiles[0]!;
    // Should spawn at player edge (x + PLAYER_WIDTH), not center (x + PLAYER_WIDTH/2)
    expect(proj.x).toBeGreaterThan(200 + 12); // more than center
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
    state = armPlayer(state, 0, WeaponType.Pistol);

    const players = state.players.map((p, i) => {
      if (i === 0) return { ...p, x: 100, y: 476 };
      if (i === 1) return { ...p, x: 150, y: 476, health: 1 };
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

    expect(s.players[1]!.lives).toBe(INITIAL_LIVES - 1);
  });

  test("no respawn at 0 lives", () => {
    let state = createInitialState(config);
    state = armPlayer(state, 0, WeaponType.Pistol);

    const players = state.players.map((p, i) => {
      if (i === 0) return { ...p, x: 100, y: 476 };
      if (i === 1) return { ...p, x: 150, y: 476, health: 1, lives: 1 };
      return p;
    });
    state = { ...state, players };

    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 1, aimY: 0 };
    const inputs = inputMap([0, shootInput]);

    let s = step(state, inputs, NO_INPUTS, config);
    const empty = inputMap();
    for (let i = 0; i < RESPAWN_TICKS + 20; i++) {
      s = step(s, empty, empty, config);
    }

    expect(s.players[1]!.lives).toBe(0);
    expect(s.players[1]!.stateFlags & PlayerStateFlag.Alive).toBe(0);
  });

  test("match ends on elimination after linger", () => {
    let state = createInitialState(config);
    state = armPlayer(state, 0, WeaponType.Pistol);

    const players = state.players.map((p, i) => {
      if (i === 0) return { ...p, x: 100, y: 476 };
      if (i === 1) return { ...p, x: 150, y: 476, health: 1, lives: 1 };
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

    // After kill, linger timer starts but matchOver not yet true
    expect(s.deathLingerTimer).toBeGreaterThan(0);
    expect(s.winner).toBe(0);
    expect(s.matchOver).toBe(false);

    // Advance through linger period
    for (let i = 0; i < 30; i++) {
      s = step(s, empty, empty, config);
    }
    expect(s.matchOver).toBe(true);
    expect(s.winner).toBe(0);
  });

  test("matchOver keeps advancing tick but preserves winner", () => {
    let state = createInitialState(config);
    state = { ...state, matchOver: true, winner: 0, tick: 100, deathLingerTimer: 0 };

    const s = step(state, NO_INPUTS, NO_INPUTS, config);
    expect(s.tick).toBe(101);
    expect(s.matchOver).toBe(true);
    expect(s.winner).toBe(0);
  });

  test("death linger delays matchOver by DEATH_LINGER_TICKS", () => {
    let state = createInitialState(config);
    state = armPlayer(state, 0, WeaponType.Pistol);

    const players = state.players.map((p, i) => {
      if (i === 0) return { ...p, x: 100, y: 476 };
      if (i === 1) return { ...p, x: 150, y: 476, health: 1, lives: 1 };
      return p;
    });
    state = { ...state, players };

    const shootInput: PlayerInput = { buttons: Button.Shoot, aimX: 1, aimY: 0 };
    const inputs = inputMap([0, shootInput]);
    const empty = inputMap();

    // Advance until linger starts
    let s = step(state, inputs, NO_INPUTS, config);
    while (s.deathLingerTimer === 0 && !s.matchOver) {
      s = step(s, empty, empty, config);
    }

    // Should be lingering, not matchOver
    expect(s.deathLingerTimer).toBeGreaterThan(0);
    expect(s.matchOver).toBe(false);
    expect(s.winner).toBe(0);
    const lingerStart = s.tick;

    // Advance through remaining linger ticks
    const remaining = s.deathLingerTimer;
    for (let i = 0; i < remaining - 1; i++) {
      s = step(s, empty, empty, config);
      expect(s.matchOver).toBe(false);
    }
    // Last tick
    s = step(s, empty, empty, config);
    expect(s.matchOver).toBe(true);
    expect(s.tick).toBe(lingerStart + remaining);
  });
});

describe("sudden death", () => {
  test("arena walls close after suddenDeathStartTick", () => {
    const shortConfig: MatchConfig = {
      ...config,
      matchDurationTicks: 100,
      suddenDeathStartTick: 50,
    };
    let state = createInitialState(shortConfig);

    state = advanceTicks(state, 51, shortConfig);
    expect(state.tick).toBe(51);
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

    const players = state.players.map((p, i) => {
      if (i === 0) return { ...p, x: 380, y: 476 };
      if (i === 1) return { ...p, x: 770, y: 476 };
      return p;
    });
    state = { ...state, players };

    state = advanceTicks(state, 80, shortConfig);

    expect(state.players[1]!.lives).toBeLessThan(INITIAL_LIVES);
  });
});

describe("time-up", () => {
  test("match ends at matchDurationTicks", () => {
    const shortConfig: MatchConfig = {
      ...config,
      matchDurationTicks: 60,
      suddenDeathStartTick: 60, // no sudden death before time-up
    };
    let state = createInitialState(shortConfig);

    const players = state.players.map((p, i) => {
      if (i === 0) return { ...p, x: 380, y: 476 };
      if (i === 1) return { ...p, x: 390, y: 476 };
      return p;
    });
    state = { ...state, players };

    state = advanceTicks(state, 60, shortConfig);
    expect(state.matchOver).toBe(true);
  });

  test("time-up: player with more lives wins", () => {
    const shortConfig: MatchConfig = {
      ...config,
      initialLives: 3,
      matchDurationTicks: 20,
      suddenDeathStartTick: 20,
    };
    let state = createInitialState(shortConfig);

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

    const players = state.players.map((p, i) => {
      if (i === 1) return { ...p, health: 50 };
      return p;
    });
    state = { ...state, players };

    state = advanceTicks(state, 20, shortConfig);
    expect(state.matchOver).toBe(true);
    expect(state.winner).toBe(0);
  });

  test("time-up: equal lives and health — P1 wins tiebreaker (no draws)", () => {
    const shortConfig: MatchConfig = {
      ...config,
      matchDurationTicks: 20,
      suddenDeathStartTick: 20,
    };
    let state = createInitialState(shortConfig);
    state = advanceTicks(state, 20, shortConfig);
    expect(state.matchOver).toBe(true);
    expect(state.winner).toBe(0);
  });
});
