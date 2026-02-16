import type { GameState } from "./types";

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnvFeed(hash: number, byte: number): number {
  hash ^= byte & 0xff;
  hash = Math.imul(hash, FNV_PRIME);
  return hash >>> 0;
}

function fnvFeedInt32(hash: number, value: number): number {
  hash = fnvFeed(hash, value & 0xff);
  hash = fnvFeed(hash, (value >>> 8) & 0xff);
  hash = fnvFeed(hash, (value >>> 16) & 0xff);
  hash = fnvFeed(hash, (value >>> 24) & 0xff);
  return hash;
}

// Reusable buffer for float64 → bytes conversion
const f64Buf = new ArrayBuffer(8);
const f64View = new DataView(f64Buf);

function fnvFeedFloat64(hash: number, value: number): number {
  f64View.setFloat64(0, value, true); // little-endian
  for (let i = 0; i < 8; i++) {
    hash = fnvFeed(hash, f64View.getUint8(i));
  }
  return hash;
}

/**
 * FNV-1a 32-bit hash over all GameState fields in canonical order.
 * Deterministic: same GameState always produces the same hash.
 */
export function hashGameState(state: GameState): number {
  let h = FNV_OFFSET;

  // Tick
  h = fnvFeedInt32(h, state.tick);

  // Players (sorted by id for canonical order)
  const sortedPlayers = [...state.players].sort((a, b) => a.id - b.id);
  for (const p of sortedPlayers) {
    h = fnvFeedInt32(h, p.id);
    h = fnvFeedFloat64(h, p.x);
    h = fnvFeedFloat64(h, p.y);
    h = fnvFeedFloat64(h, p.vx);
    h = fnvFeedFloat64(h, p.vy);
    h = fnvFeedInt32(h, p.facing);
    h = fnvFeedInt32(h, p.health);
    h = fnvFeedInt32(h, p.shootCooldown);
    h = fnvFeedInt32(h, p.grounded ? 1 : 0);
    h = fnvFeedInt32(h, p.stateFlags);
    h = fnvFeedInt32(h, p.respawnTimer);
    h = fnvFeedInt32(h, p.lives);
  }

  // Projectiles (sorted by id)
  const sortedProj = [...state.projectiles].sort((a, b) => a.id - b.id);
  for (const proj of sortedProj) {
    h = fnvFeedInt32(h, proj.id);
    h = fnvFeedInt32(h, proj.ownerId);
    h = fnvFeedFloat64(h, proj.x);
    h = fnvFeedFloat64(h, proj.y);
    h = fnvFeedFloat64(h, proj.vx);
    h = fnvFeedFloat64(h, proj.vy);
    h = fnvFeedInt32(h, proj.lifetime);
  }

  // RNG state
  h = fnvFeedInt32(h, state.rngState);

  // Score (sorted by player id)
  const sortedScoreKeys = [...state.score.keys()].sort((a, b) => a - b);
  for (const key of sortedScoreKeys) {
    h = fnvFeedInt32(h, key);
    h = fnvFeedInt32(h, state.score.get(key)!);
  }

  // Next projectile id
  h = fnvFeedInt32(h, state.nextProjectileId);

  // Arena bounds, match state
  h = fnvFeedFloat64(h, state.arenaLeft);
  h = fnvFeedFloat64(h, state.arenaRight);
  h = fnvFeedInt32(h, state.matchOver ? 1 : 0);
  h = fnvFeedInt32(h, state.winner);

  return h;
}
