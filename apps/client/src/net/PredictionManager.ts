import type { PlayerInput } from "@chickenz/sim";
import { NULL_INPUT } from "@chickenz/sim";
import { WasmState } from "../wasm";
import { InputBuffer } from "./InputBuffer";

/**
 * Client-side prediction with server reconciliation using WASM sim.
 *
 * Uses the standard rollback + replay approach:
 * 1. Client runs sim locally for instant responsiveness (predictTick)
 * 2. When server state arrives, rollback to that state
 * 3. Replay all unconfirmed local inputs on top
 * 4. Result = correctly predicted state with any server divergence resolved
 */
export class PredictionManager {
  private wasmState: WasmState;
  private localPlayerId: number;
  private inputBuffer = new InputBuffer();
  private predictedTick: number;
  private lastLocalInput: PlayerInput = NULL_INPUT;
  private seed: number;
  private mapJson: string;

  constructor(seed: number, mapJson: string, localPlayerId: number) {
    this.wasmState = new WasmState(seed, mapJson);
    this.predictedTick = 0;
    this.localPlayerId = localPlayerId;
    this.seed = seed;
    this.mapJson = mapJson;
  }

  /** Export the current predicted state as a plain JS object for rendering. */
  get predictedState(): any {
    return this.wasmState.export_state();
  }

  /**
   * Run one prediction tick with the local player's input.
   * Stores the input for potential replay during reconciliation.
   */
  predictTick(localInput: PlayerInput): any {
    this.predictedTick++;
    this.inputBuffer.store(this.predictedTick, localInput);
    this.lastLocalInput = localInput;

    const p0 = this.localPlayerId === 0 ? localInput : NULL_INPUT;
    const p1 = this.localPlayerId === 1 ? localInput : NULL_INPUT;

    this.wasmState.step(
      p0.buttons, p0.aimX, p0.aimY,
      p1.buttons, p1.aimX, p1.aimY,
    );

    return this.wasmState.export_state();
  }

  /**
   * Server reconciliation: rollback to server state, replay unconfirmed inputs.
   *
   * This is the core of the netcode. The server state at tick T is ground truth.
   * We replay our buffered inputs from T+1..predictedTick on top of it.
   * If our prediction was accurate, the result is nearly identical (no visible
   * correction). If it diverged (e.g., different collision), the correction
   * happens automatically and the smoothLerp in rendering absorbs it visually.
   */
  applyServerState(serverState: any, serverTick: number, _serverLastButtons?: [number, number]): void {
    if (serverTick >= this.predictedTick) {
      // Server is ahead or caught up — no replay needed
      this.wasmState.import_state(serverState);
      // Verify import succeeded — if WASM tick doesn't match, import silently failed
      if (this.wasmState.tick() !== serverTick) {
        this.recreateFromState(serverState, serverTick);
      }
      this.predictedTick = serverTick;
      this.inputBuffer.prune(serverTick);
      return;
    }

    // Rollback to server state and replay unconfirmed inputs
    this.wasmState.import_state(serverState);

    // Verify import succeeded — if WASM tick doesn't match, import silently failed
    // This prevents tick runaway where replay compounds on top of stale state
    if (this.wasmState.tick() !== serverTick) {
      this.recreateFromState(serverState, serverTick);
      // After recreation, skip replay — just accept server state as-is
      this.predictedTick = serverTick;
      this.inputBuffer.prune(serverTick);
      return;
    }

    for (let tick = serverTick + 1; tick <= this.predictedTick; tick++) {
      const localInput = this.inputBuffer.get(tick);
      const p0 = this.localPlayerId === 0 ? localInput : NULL_INPUT;
      const p1 = this.localPlayerId === 1 ? localInput : NULL_INPUT;
      this.wasmState.step(
        p0.buttons, p0.aimX, p0.aimY,
        p1.buttons, p1.aimX, p1.aimY,
      );
    }

    this.inputBuffer.prune(serverTick);
  }

  /**
   * Fallback: recreate WASM state when import_state fails.
   * Creates a fresh WasmState at tick 0, then imports the server state.
   * If that also fails, the state is at tick 0 and will be overwritten next frame.
   */
  private recreateFromState(serverState: any, serverTick: number): void {
    console.warn(`[Prediction] import_state failed (WASM tick=${this.wasmState.tick()}, expected=${serverTick}), recreating`);
    try { this.wasmState.free(); } catch { /* already freed */ }
    this.wasmState = new WasmState(this.seed, this.mapJson);
    this.wasmState.import_state(serverState);
    // If still wrong after recreation, log but continue — will self-correct next frame
    if (this.wasmState.tick() !== serverTick) {
      console.error(`[Prediction] import_state failed even after recreate (tick=${this.wasmState.tick()}, expected=${serverTick})`);
    }
  }

  /** Reset prediction state (e.g., on round start). */
  reset(seed: number, mapJson: string) {
    try { this.wasmState.free(); } catch { /* already freed */ }
    this.wasmState = new WasmState(seed, mapJson);
    this.predictedTick = 0;
    this.inputBuffer.clear();
  }

  /** Free WASM resources. */
  free() {
    try { this.wasmState.free(); } catch { /* already freed */ }
  }

  get currentTick(): number {
    return this.predictedTick;
  }
}
