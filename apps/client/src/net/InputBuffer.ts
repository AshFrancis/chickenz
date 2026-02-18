import type { PlayerInput } from "@chickenz/sim";
import { NULL_INPUT } from "@chickenz/sim";

const MAX_BUFFER_SIZE = 120; // ~2 seconds at 60Hz

/**
 * Stores local inputs by tick for prediction replay.
 * Keeps a sliding window of recent inputs.
 */
export class InputBuffer {
  private buffer = new Map<number, PlayerInput>();

  store(tick: number, input: PlayerInput): void {
    this.buffer.set(tick, input);
    // Prune old entries
    if (this.buffer.size > MAX_BUFFER_SIZE) {
      const cutoff = tick - MAX_BUFFER_SIZE;
      this.prune(cutoff);
    }
  }

  get(tick: number): PlayerInput {
    return this.buffer.get(tick) ?? NULL_INPUT;
  }

  getRange(fromTick: number, toTick: number): Map<number, PlayerInput> {
    const result = new Map<number, PlayerInput>();
    for (let t = fromTick; t <= toTick; t++) {
      const input = this.buffer.get(t);
      if (input) result.set(t, input);
    }
    return result;
  }

  prune(beforeTick: number): void {
    for (const key of this.buffer.keys()) {
      if (key < beforeTick) {
        this.buffer.delete(key);
      }
    }
  }

  clear(): void {
    this.buffer.clear();
  }
}
