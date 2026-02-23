import type { PlayerInput } from "@chickenz/sim";
import { NULL_INPUT } from "@chickenz/sim";
import type { StateMessage } from "../../../../services/server/src/protocol";
/** Game state data — shared shape of StateMessage, SpectateStateMessage, and WASM exports */
type GameStateData = Omit<StateMessage, "type">;
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
  private lastRemoteInput: PlayerInput = NULL_INPUT;
  private seed: number;
  private mapJson: string;
  private _cachedState: GameStateData | null = null;
  private _cacheValid = false;

  // Diagnostics
  private _lastReplayCount = 0;
  private _lastReconcileErrorX = 0;
  private _lastReconcileErrorY = 0;

  constructor(seed: number, mapJson: string, localPlayerId: number) {
    this.wasmState = new WasmState(seed, mapJson);
    this.predictedTick = 0;
    this.localPlayerId = localPlayerId;
    this.seed = seed;
    this.mapJson = mapJson;
  }

  /** Export the current predicted state as a plain JS object for rendering. Cached until next step/import. */
  get predictedState(): GameStateData | null {
    if (!this._cacheValid) {
      this._cachedState = this.wasmState.export_state() as GameStateData;
      this._cacheValid = true;
    }
    return this._cachedState;
  }

  /** Number of ticks replayed in the last reconciliation (for diagnostics). */
  get lastReplayCount(): number {
    return this._lastReplayCount;
  }

  /** Position error from last reconciliation (for diagnostics). */
  get lastReconcileError(): { x: number; y: number } {
    return { x: this._lastReconcileErrorX, y: this._lastReconcileErrorY };
  }

  /**
   * Run one prediction tick with the local player's input.
   * Stores the input for potential replay during reconciliation.
   */
  predictTick(localInput: PlayerInput): void {
    this.predictedTick++;
    this.inputBuffer.store(this.predictedTick, localInput);
    this.lastLocalInput = localInput;

    // Use last known remote input (mirrors server's missing-input rule: reuse T-1)
    // This dramatically reduces prediction divergence vs NULL_INPUT
    const remote = this.lastRemoteInput;
    const p0 = this.localPlayerId === 0 ? localInput : remote;
    const p1 = this.localPlayerId === 1 ? localInput : remote;

    this.wasmState.step(p0.buttons, p0.aimX, p0.aimY, p1.buttons, p1.aimX, p1.aimY);

    this._cacheValid = false;
  }

  /**
   * Server reconciliation: rollback to server state, replay unconfirmed inputs.
   *
   * The server state at tick T is ground truth. We replay buffered inputs
   * from T+1..predictedTick. Capped at MAX_REPLAY to prevent runaway if
   * client prediction drifts ahead of server.
   */
  applyServerState(
    serverState: GameStateData,
    serverTick: number,
    serverLastButtons?: [number, number],
    serverLastInputs?: [PlayerInput, PlayerInput],
  ): void {
    const MAX_REPLAY = 16; // cap replay to prevent progressive slowdown

    // Extract remote player's last input from server state for prediction
    // This mirrors the server's missing-input rule (reuse T-1) and dramatically
    // reduces divergence between prediction and server reality
    if (serverLastInputs) {
      const remoteId = 1 - this.localPlayerId;
      const remote = serverLastInputs[remoteId];
      if (remote) {
        this.lastRemoteInput = {
          buttons: remote.buttons,
          aimX: remote.aimX,
          aimY: remote.aimY,
        };
      }
    } else if (serverLastButtons) {
      const remoteId = 1 - this.localPlayerId;
      const remoteBtns = serverLastButtons[remoteId] ?? 0;
      this.lastRemoteInput = { buttons: remoteBtns, aimX: 0, aimY: 0 };
    }

    // Track pre-reconciliation position for diagnostics
    const prevPredicted = this.predictedState;
    const localPlayer = prevPredicted?.players[this.localPlayerId];

    if (serverTick >= this.predictedTick) {
      // Server is ahead or caught up — no replay needed
      this.wasmState.import_state(serverState);
      if (this.wasmState.tick() !== serverTick) {
        this.recreateFromState(serverState, serverTick);
      }
      this.predictedTick = serverTick;
      this.inputBuffer.prune(serverTick);
      this._lastReplayCount = 0;
      this._lastReconcileErrorX = 0;
      this._lastReconcileErrorY = 0;
      this._cacheValid = false;
      return;
    }

    // If prediction is WAY ahead, snap it back to prevent huge replay
    const gap = this.predictedTick - serverTick;
    if (gap > MAX_REPLAY) {
      this.wasmState.import_state(serverState);
      if (this.wasmState.tick() !== serverTick) {
        this.recreateFromState(serverState, serverTick);
      }
      this.predictedTick = serverTick;
      this.inputBuffer.prune(serverTick);
      this._lastReplayCount = 0;
      this._lastReconcileErrorX = 0;
      this._lastReconcileErrorY = 0;
      this._cacheValid = false;
      return;
    }

    // Rollback to server state and replay unconfirmed inputs
    this.wasmState.import_state(serverState);

    if (this.wasmState.tick() !== serverTick) {
      this.recreateFromState(serverState, serverTick);
      this.predictedTick = serverTick;
      this.inputBuffer.prune(serverTick);
      this._lastReplayCount = 0;
      this._cacheValid = false;
      return;
    }

    this._lastReplayCount = this.predictedTick - serverTick;

    // Replay with last known remote input (matches server's missing-input rule)
    const remote = this.lastRemoteInput;
    for (let tick = serverTick + 1; tick <= this.predictedTick; tick++) {
      const localInput = this.inputBuffer.get(tick);
      const p0 = this.localPlayerId === 0 ? localInput : remote;
      const p1 = this.localPlayerId === 1 ? localInput : remote;
      this.wasmState.step(p0.buttons, p0.aimX, p0.aimY, p1.buttons, p1.aimX, p1.aimY);
    }

    // Measure reconciliation error (how much the position shifted)
    this._cacheValid = false;
    const newPredicted = this.predictedState;
    const newLocalPlayer = newPredicted?.players[this.localPlayerId];
    if (localPlayer && newLocalPlayer) {
      this._lastReconcileErrorX = Math.abs(newLocalPlayer.x - localPlayer.x);
      this._lastReconcileErrorY = Math.abs(newLocalPlayer.y - localPlayer.y);
    }

    this.inputBuffer.prune(serverTick);
    this._cacheValid = false;
  }

  private recreateFromState(serverState: GameStateData, serverTick: number): void {
    console.warn(
      `[Prediction] import_state failed (WASM tick=${this.wasmState.tick()}, expected=${serverTick}), recreating`,
    );
    try {
      this.wasmState.free();
    } catch {
      /* already freed */
    }
    this.wasmState = new WasmState(this.seed, this.mapJson);
    this.wasmState.import_state(serverState);
    if (this.wasmState.tick() !== serverTick) {
      console.error(
        `[Prediction] import_state failed even after recreate (tick=${this.wasmState.tick()}, expected=${serverTick})`,
      );
    }
  }

  /** Reset prediction state (e.g., on round start). */
  reset(seed: number, mapJson: string) {
    try {
      this.wasmState.free();
    } catch {
      /* already freed */
    }
    this.wasmState = new WasmState(seed, mapJson);
    this.predictedTick = 0;
    this.inputBuffer.clear();
    this.lastRemoteInput = NULL_INPUT;
    this._cacheValid = false;
  }

  /** Free WASM resources. */
  free() {
    try {
      this.wasmState.free();
    } catch {
      /* already freed */
    }
  }

  get currentTick(): number {
    return this.predictedTick;
  }
}
