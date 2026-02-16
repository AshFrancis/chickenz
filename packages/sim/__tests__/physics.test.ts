import { describe, test, expect } from "bun:test";
import { applyPlayerInput, applyGravity, moveAndCollide } from "../src/physics";
import { Button, Facing, PlayerStateFlag } from "../src/types";
import type { PlayerState, GameMap } from "../src/types";
import {
  GRAVITY,
  JUMP_VELOCITY,
  MAX_FALL_SPEED,
  PLAYER_SPEED,
  ACCELERATION,
  DECELERATION,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
} from "../src/constants";

function makePlayer(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id: 0,
    x: 100,
    y: 100,
    vx: 0,
    vy: 0,
    facing: Facing.Right,
    health: 100,
    lives: 3,
    shootCooldown: 0,
    grounded: false,
    stateFlags: PlayerStateFlag.Alive,
    respawnTimer: 0,
    ...overrides,
  };
}

const simpleMap: GameMap = {
  width: 800,
  height: 600,
  platforms: [{ x: 0, y: 568, width: 800, height: 32 }],
  spawnPoints: [{ x: 100, y: 536 }],
};

describe("applyPlayerInput", () => {
  test("left button accelerates toward -PLAYER_SPEED", () => {
    const p = makePlayer({ grounded: true });
    const result = applyPlayerInput(p, { buttons: Button.Left, aimX: -1, aimY: 0 });
    expect(result.vx).toBe(-ACCELERATION);
    // After enough ticks, reaches max speed
    let player = p;
    for (let i = 0; i < 20; i++) {
      player = applyPlayerInput(player, { buttons: Button.Left, aimX: -1, aimY: 0 });
    }
    expect(player.vx).toBe(-PLAYER_SPEED);
  });

  test("right button accelerates toward PLAYER_SPEED", () => {
    const p = makePlayer({ grounded: true });
    const result = applyPlayerInput(p, { buttons: Button.Right, aimX: 1, aimY: 0 });
    expect(result.vx).toBe(ACCELERATION);
    let player = p;
    for (let i = 0; i < 20; i++) {
      player = applyPlayerInput(player, { buttons: Button.Right, aimX: 1, aimY: 0 });
    }
    expect(player.vx).toBe(PLAYER_SPEED);
  });

  test("no movement buttons → decelerates toward 0", () => {
    const p = makePlayer({ vx: PLAYER_SPEED });
    const r1 = applyPlayerInput(p, { buttons: 0, aimX: 0, aimY: 0 });
    expect(r1.vx).toBe(PLAYER_SPEED - DECELERATION);
    // Eventually reaches 0
    let player = p;
    for (let i = 0; i < 20; i++) {
      player = applyPlayerInput(player, { buttons: 0, aimX: 0, aimY: 0 });
    }
    expect(player.vx).toBe(0);
  });

  test("jump only when grounded", () => {
    const grounded = makePlayer({ grounded: true });
    const airborne = makePlayer({ grounded: false });
    const input = { buttons: Button.Jump, aimX: 0, aimY: 0 };

    expect(applyPlayerInput(grounded, input).vy).toBe(JUMP_VELOCITY);
    expect(applyPlayerInput(airborne, input).vy).toBe(0); // unchanged
  });

  test("facing updates from aim direction", () => {
    const p = makePlayer({ facing: Facing.Right });
    const result = applyPlayerInput(p, { buttons: 0, aimX: -1, aimY: 0 });
    expect(result.facing).toBe(Facing.Left);
  });

  test("dead player input is ignored", () => {
    const p = makePlayer({ stateFlags: 0 }); // not alive
    const result = applyPlayerInput(p, { buttons: Button.Right | Button.Jump, aimX: 1, aimY: 0 });
    expect(result.vx).toBe(0);
  });
});

describe("applyGravity", () => {
  test("gravity accumulates", () => {
    let p = makePlayer({ vy: 0 });
    p = applyGravity(p);
    expect(p.vy).toBe(GRAVITY);
    p = applyGravity(p);
    expect(p.vy).toBe(GRAVITY * 2);
  });

  test("vy clamped to MAX_FALL_SPEED", () => {
    const p = makePlayer({ vy: MAX_FALL_SPEED });
    const result = applyGravity(p);
    expect(result.vy).toBe(MAX_FALL_SPEED);
  });
});

describe("moveAndCollide", () => {
  test("player lands on platform", () => {
    // Player just above ground, falling
    const p = makePlayer({ x: 100, y: 568 - PLAYER_HEIGHT - 1, vy: 5 });
    const result = moveAndCollide(p, simpleMap, 0, simpleMap.width);
    expect(result.y).toBe(568 - PLAYER_HEIGHT);
    expect(result.vy).toBe(0);
    expect(result.grounded).toBe(true);
  });

  test("boundary clamping — left wall", () => {
    const p = makePlayer({ x: 2, vx: -10 });
    const result = moveAndCollide(p, simpleMap, 0, simpleMap.width);
    expect(result.x).toBe(0);
  });

  test("boundary clamping — right wall", () => {
    const p = makePlayer({ x: simpleMap.width - PLAYER_WIDTH - 2, vx: 10 });
    const result = moveAndCollide(p, simpleMap, 0, simpleMap.width);
    expect(result.x).toBe(simpleMap.width - PLAYER_WIDTH);
  });

  test("boundary clamping — ceiling", () => {
    const p = makePlayer({ x: 100, y: 2, vy: -10 });
    const result = moveAndCollide(p, simpleMap, 0, simpleMap.width);
    expect(result.y).toBe(0);
    expect(result.vy).toBe(0);
  });

  test("one-way platform — no collision from below", () => {
    const mapWithPlat: GameMap = {
      width: 800,
      height: 600,
      platforms: [{ x: 50, y: 300, width: 200, height: 16 }],
      spawnPoints: [],
    };
    // Player is below the platform, moving up
    const p = makePlayer({ x: 100, y: 310, vy: -5 });
    const result = moveAndCollide(p, mapWithPlat, 0, mapWithPlat.width);
    // Should pass through
    expect(result.y).toBe(305);
    expect(result.grounded).toBe(false);
  });

  test("dynamic arena bounds clamp player", () => {
    // Arena narrowed to [200, 600]
    const p = makePlayer({ x: 100, vx: 0 });
    const result = moveAndCollide(p, simpleMap, 200, 600);
    expect(result.x).toBe(200); // clamped to arenaLeft
  });
});
