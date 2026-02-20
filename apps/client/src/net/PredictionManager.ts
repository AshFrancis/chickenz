import type { GameState, MatchConfig, PlayerInput, InputMap } from "@chickenz/sim";
import { step, NULL_INPUT } from "@chickenz/sim";
import { InputBuffer } from "./InputBuffer";

/**
 * Client-side prediction with server reconciliation.
 *
 * Uses the standard rollback + replay approach:
 * 1. Client runs sim locally for instant responsiveness (predictTick)
 * 2. When server state arrives, rollback to that state
 * 3. Replay all unconfirmed local inputs on top
 * 4. Result = correctly predicted state with any server divergence resolved
 */
export class PredictionManager {
  predictedState: GameState;
  private config: MatchConfig;
  private localPlayerId: number;
  private inputBuffer = new InputBuffer();
  private predictedTick: number;
  private prevInputs: InputMap = new Map();
  private lastLocalInput: PlayerInput = NULL_INPUT;

  constructor(initialState: GameState, config: MatchConfig, localPlayerId: number) {
    this.predictedState = initialState;
    this.predictedTick = initialState.tick;
    this.config = config;
    this.localPlayerId = localPlayerId;
  }

  /**
   * Run one prediction tick with the local player's input.
   * Stores the input for potential replay during reconciliation.
   */
  predictTick(localInput: PlayerInput): GameState {
    this.predictedTick++;
    this.inputBuffer.store(this.predictedTick, localInput);
    this.lastLocalInput = localInput;

    const inputs: InputMap = new Map([
      [this.localPlayerId, localInput],
      [1 - this.localPlayerId, NULL_INPUT],
    ]);

    this.predictedState = step(this.predictedState, inputs, this.prevInputs, this.config);
    this.prevInputs = inputs;

    return this.predictedState;
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
  applyServerState(serverState: GameState, serverTick: number): void {
    if (serverTick >= this.predictedTick) {
      // Server is ahead or caught up — no replay needed
      this.predictedState = serverState;
      this.predictedTick = serverTick;
      // Use tracked lastLocalInput instead of inputBuffer (which may return
      // NULL_INPUT for this tick) — guarantees correct edge detection
      this.prevInputs = new Map([
        [this.localPlayerId, this.lastLocalInput],
        [1 - this.localPlayerId, NULL_INPUT],
      ]);
      this.inputBuffer.prune(serverTick);
      return;
    }

    // Rollback to server state and replay unconfirmed inputs.
    // Seed prevInputs from the input at serverTick so the first replayed tick
    // has correct edge detection (prevents phantom jump on reconciliation).
    let state = serverState;
    const seedInput = this.inputBuffer.get(serverTick);
    let prevInputs: InputMap = new Map([
      [this.localPlayerId, seedInput],
      [1 - this.localPlayerId, NULL_INPUT],
    ]);

    for (let tick = serverTick + 1; tick <= this.predictedTick; tick++) {
      const localInput = this.inputBuffer.get(tick);
      const inputs: InputMap = new Map([
        [this.localPlayerId, localInput],
        [1 - this.localPlayerId, NULL_INPUT],
      ]);
      state = step(state, inputs, prevInputs, this.config);
      prevInputs = inputs;
    }

    this.predictedState = state;
    this.prevInputs = prevInputs;
    this.inputBuffer.prune(serverTick);
  }

  /** Reset prediction state (e.g., on round start). */
  reset(initialState: GameState) {
    this.predictedState = initialState;
    this.predictedTick = initialState.tick;
    this.inputBuffer.clear();
    this.prevInputs = new Map();
  }

  get currentTick(): number {
    return this.predictedTick;
  }
}
