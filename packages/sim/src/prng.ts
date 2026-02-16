/**
 * Mulberry32 — deterministic 32-bit PRNG.
 * Pure function: returns [value, nextState].
 */
export function prngNext(state: number): [number, number] {
  let t = (state + 0x6d2b79f5) | 0;
  const nextState = t >>> 0; // this is the new state
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, nextState];
}

/** Returns a random integer in [min, max] inclusive. */
export function prngIntRange(
  state: number,
  min: number,
  max: number,
): [number, number] {
  const [value, nextState] = prngNext(state);
  const range = max - min + 1;
  return [min + Math.floor(value * range), nextState];
}
