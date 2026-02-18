import { GRAVITY } from "@chickenz/sim";

export interface RemoteSnapshot {
  time: number; // performance.now() when received
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  stateFlags: number;
}

const MAX_BUFFER_SIZE = 20;
const MAX_EXTRAPOLATION_MS = 60;

export class InterpolationBuffer {
  private buffer: RemoteSnapshot[] = [];

  push(snap: RemoteSnapshot): void {
    this.buffer.push(snap);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer.shift();
    }
  }

  /** Sample interpolated position at the given render time. */
  sample(renderTime: number): RemoteSnapshot | null {
    const buf = this.buffer;
    if (buf.length === 0) return null;
    if (buf.length === 1) return buf[0]!;

    // Find two bracketing snapshots: a.time <= renderTime <= b.time
    for (let i = buf.length - 1; i >= 1; i--) {
      const a = buf[i - 1]!;
      const b = buf[i]!;
      if (a.time <= renderTime && renderTime <= b.time) {
        const span = b.time - a.time;
        const t = span > 0 ? (renderTime - a.time) / span : 0;
        return {
          time: renderTime,
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          vx: b.vx,
          vy: b.vy,
          facing: b.facing,
          stateFlags: b.stateFlags,
        };
      }
    }

    // renderTime is beyond newest snapshot — extrapolate with gravity
    const last = buf[buf.length - 1]!;
    const dt = renderTime - last.time;
    if (dt > 0 && dt <= MAX_EXTRAPOLATION_MS) {
      const ticks = dt / 1000 * 60; // convert ms to tick-fractions (60Hz)
      return {
        time: renderTime,
        x: last.x + last.vx * ticks,
        y: last.y + last.vy * ticks + 0.5 * GRAVITY * ticks * ticks,
        vx: last.vx,
        vy: last.vy + GRAVITY * ticks,
        facing: last.facing,
        stateFlags: last.stateFlags,
      };
    }

    // Beyond max extrapolation or renderTime before all snapshots — return latest
    return last;
  }

  clear(): void {
    this.buffer = [];
  }
}
