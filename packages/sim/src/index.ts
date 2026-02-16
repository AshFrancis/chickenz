export * from "./types";
export * from "./constants";
export * from "./prng";
export * from "./map";
export * from "./physics";
export * from "./projectiles";
export * from "./step";
export * from "./hash";

import type { GameState, MatchConfig, PlayerState } from "./types";
import { Facing, PlayerStateFlag } from "./types";
import { MAX_HEALTH } from "./constants";

/** Create the initial game state from a match config. */
export function createInitialState(config: MatchConfig): GameState {
  const players: PlayerState[] = [];
  for (let i = 0; i < config.playerCount; i++) {
    const spawn = config.map.spawnPoints[i % config.map.spawnPoints.length]!;
    players.push({
      id: i,
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      facing: Facing.Right,
      health: MAX_HEALTH,
      lives: config.initialLives,
      shootCooldown: 0,
      grounded: false,
      stateFlags: PlayerStateFlag.Alive,
      respawnTimer: 0,
    });
  }

  const score = new Map<number, number>();
  for (let i = 0; i < config.playerCount; i++) {
    score.set(i, 0);
  }

  return {
    tick: 0,
    players,
    projectiles: [],
    rngState: config.seed,
    score,
    nextProjectileId: 0,
    arenaLeft: 0,
    arenaRight: config.map.width,
    matchOver: false,
    winner: -1,
  };
}
