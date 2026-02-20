import { describe, test, expect } from "bun:test";
import { applyPlayerInput, applyGravity, moveAndCollide } from "../src/physics";
import { Button, Facing, PlayerStateFlag, NULL_INPUT } from "../src/types";
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
  MAX_JUMPS,
  WALL_SLIDE_SPEED,
  WALL_JUMP_VX,
  WALL_JUMP_VY,
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
    weapon: null,
    ammo: 0,
    jumpsLeft: MAX_JUMPS,
    wallSliding: false,
    wallDir: 0,
    ...overrides,
  };
}

const simpleMap: GameMap = {
  width: 800,
  height: 600,
  platforms: [{ x: 0, y: 568, width: 800, height: 32 }],
  spawnPoints: [{ x: 100, y: 536 }],
  weaponSpawnPoints: [],
};

describe("applyPlayerInput", () => {
  test("left button accelerates toward -PLAYER_SPEED", () => {
    const p = makePlayer({ grounded: true });
    const input = { buttons: Button.Left, aimX: -1, aimY: 0 };
    const result = applyPlayerInput(p, input, NULL_INPUT);
    expect(result.vx).toBe(-ACCELERATION);
    let player = p;
    for (let i = 0; i < 20; i++) {
      player = applyPlayerInput(player, input, input);
    }
    expect(player.vx).toBe(-PLAYER_SPEED);
  });

  test("right button accelerates toward PLAYER_SPEED", () => {
    const p = makePlayer({ grounded: true });
    const input = { buttons: Button.Right, aimX: 1, aimY: 0 };
    const result = applyPlayerInput(p, input, NULL_INPUT);
    expect(result.vx).toBe(ACCELERATION);
    let player = p;
    for (let i = 0; i < 20; i++) {
      player = applyPlayerInput(player, input, input);
    }
    expect(player.vx).toBe(PLAYER_SPEED);
  });

  test("no movement buttons → decelerates toward 0", () => {
    const p = makePlayer({ vx: PLAYER_SPEED });
    const noInput = { buttons: 0, aimX: 0, aimY: 0 };
    const r1 = applyPlayerInput(p, noInput, NULL_INPUT);
    expect(r1.vx).toBe(PLAYER_SPEED - DECELERATION);
    let player = p;
    for (let i = 0; i < 20; i++) {
      player = applyPlayerInput(player, noInput, noInput);
    }
    expect(player.vx).toBe(0);
  });

  test("jump on ground uses jumpsLeft", () => {
    const p = makePlayer({ grounded: true, jumpsLeft: MAX_JUMPS });
    const input = { buttons: Button.Jump, aimX: 0, aimY: 0 };
    const result = applyPlayerInput(p, input, NULL_INPUT);
    expect(result.vy).toBe(JUMP_VELOCITY);
    expect(result.jumpsLeft).toBe(MAX_JUMPS - 1);
  });

  test("double jump in air when jumpsLeft > 0", () => {
    const p = makePlayer({ grounded: false, jumpsLeft: 1, vy: 5 });
    const input = { buttons: Button.Jump, aimX: 0, aimY: 0 };
    const result = applyPlayerInput(p, input, NULL_INPUT);
    expect(result.vy).toBe(JUMP_VELOCITY);
    expect(result.jumpsLeft).toBe(0);
  });

  test("no jump when jumpsLeft === 0", () => {
    const p = makePlayer({ grounded: false, jumpsLeft: 0, vy: 5 });
    const input = { buttons: Button.Jump, aimX: 0, aimY: 0 };
    const result = applyPlayerInput(p, input, NULL_INPUT);
    expect(result.vy).toBe(5); // unchanged
    expect(result.jumpsLeft).toBe(0);
  });

  test("jump is edge-triggered — holding jump does not re-fire", () => {
    const p = makePlayer({ grounded: true, jumpsLeft: MAX_JUMPS });
    const jumpInput = { buttons: Button.Jump, aimX: 0, aimY: 0 };
    // Jump held from previous tick — no edge
    const result = applyPlayerInput(p, jumpInput, jumpInput);
    expect(result.vy).toBe(0); // no jump
    expect(result.jumpsLeft).toBe(MAX_JUMPS);
  });

  test("wall jump pushes away from wall", () => {
    const p = makePlayer({ wallSliding: true, wallDir: 1, jumpsLeft: 1, vy: 2 });
    const input = { buttons: Button.Jump, aimX: 0, aimY: 0 };
    const result = applyPlayerInput(p, input, NULL_INPUT);
    expect(result.vx).toBe(-WALL_JUMP_VX); // pushed left (away from right wall)
    expect(result.vy).toBe(WALL_JUMP_VY);
    expect(result.jumpsLeft).toBe(0);
  });

  test("facing updates from aim direction", () => {
    const p = makePlayer({ facing: Facing.Right });
    const result = applyPlayerInput(p, { buttons: 0, aimX: -1, aimY: 0 }, NULL_INPUT);
    expect(result.facing).toBe(Facing.Left);
  });

  test("dead player input is ignored", () => {
    const p = makePlayer({ stateFlags: 0 });
    const result = applyPlayerInput(
      p,
      { buttons: Button.Right | Button.Jump, aimX: 1, aimY: 0 },
      NULL_INPUT,
    );
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

  test("wall sliding caps fall speed to WALL_SLIDE_SPEED", () => {
    const p = makePlayer({ vy: 0, wallSliding: true });
    let player = p;
    for (let i = 0; i < 30; i++) {
      player = applyGravity(player);
    }
    expect(player.vy).toBe(WALL_SLIDE_SPEED);
  });
});

describe("moveAndCollide", () => {
  test("player lands on platform", () => {
    const p = makePlayer({ x: 100, y: 568 - PLAYER_HEIGHT - 1, vy: 5 });
    const result = moveAndCollide(p, simpleMap, 0, simpleMap.width, 0);
    expect(result.y).toBe(568 - PLAYER_HEIGHT);
    expect(result.vy).toBe(0);
    expect(result.grounded).toBe(true);
  });

  test("landing resets jumpsLeft to MAX_JUMPS", () => {
    const p = makePlayer({ x: 100, y: 568 - PLAYER_HEIGHT - 1, vy: 5, jumpsLeft: 0 });
    const result = moveAndCollide(p, simpleMap, 0, simpleMap.width, 0);
    expect(result.grounded).toBe(true);
    expect(result.jumpsLeft).toBe(MAX_JUMPS);
  });

  test("boundary clamping — left wall", () => {
    const p = makePlayer({ x: 2, vx: -10 });
    const result = moveAndCollide(p, simpleMap, 0, simpleMap.width, 0);
    expect(result.x).toBe(0);
  });

  test("boundary clamping — right wall", () => {
    const p = makePlayer({ x: simpleMap.width - PLAYER_WIDTH - 2, vx: 10 });
    const result = moveAndCollide(p, simpleMap, 0, simpleMap.width, 0);
    expect(result.x).toBe(simpleMap.width - PLAYER_WIDTH);
  });

  test("boundary clamping — ceiling", () => {
    const p = makePlayer({ x: 100, y: 2, vy: -10 });
    const result = moveAndCollide(p, simpleMap, 0, simpleMap.width, 0);
    expect(result.y).toBe(0);
    expect(result.vy).toBe(0);
  });

  test("one-way platform — no collision from below", () => {
    const mapWithPlat: GameMap = {
      width: 800,
      height: 600,
      platforms: [{ x: 50, y: 300, width: 200, height: 16 }],
      spawnPoints: [],
      weaponSpawnPoints: [],
    };
    const p = makePlayer({ x: 100, y: 310, vy: -5 });
    const result = moveAndCollide(p, mapWithPlat, 0, mapWithPlat.width, 0);
    expect(result.y).toBe(305);
    expect(result.grounded).toBe(false);
  });

  test("dynamic arena bounds clamp player", () => {
    const p = makePlayer({ x: 100, vx: 0 });
    const result = moveAndCollide(p, simpleMap, 200, 600, 0);
    expect(result.x).toBe(200);
  });

  test("wall slide detected at left boundary", () => {
    const p = makePlayer({ x: 0, vx: -1, vy: 5, jumpsLeft: 0 });
    const result = moveAndCollide(p, simpleMap, 0, simpleMap.width, Button.Left);
    expect(result.wallSliding).toBe(true);
    expect(result.wallDir).toBe(-1);
    expect(result.jumpsLeft).toBe(1); // granted 1 jump for wall-jump
  });

  test("wall slide detected at right boundary", () => {
    const p = makePlayer({
      x: simpleMap.width - PLAYER_WIDTH,
      vx: 1,
      vy: 5,
      jumpsLeft: 0,
    });
    const result = moveAndCollide(p, simpleMap, 0, simpleMap.width, Button.Right);
    expect(result.wallSliding).toBe(true);
    expect(result.wallDir).toBe(1);
    expect(result.jumpsLeft).toBe(1);
  });

  test("no wall slide when grounded", () => {
    const p = makePlayer({
      x: 0,
      y: 568 - PLAYER_HEIGHT - 1,
      vx: -1,
      vy: 5,
    });
    const result = moveAndCollide(p, simpleMap, 0, simpleMap.width, Button.Left);
    expect(result.grounded).toBe(true);
    expect(result.wallSliding).toBe(false);
  });

  test("no wall slide without pressing into wall", () => {
    const p = makePlayer({ x: 0, vx: -1, vy: 5 });
    const result = moveAndCollide(p, simpleMap, 0, simpleMap.width, 0); // no buttons
    expect(result.wallSliding).toBe(false);
  });
});
