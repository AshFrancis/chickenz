import type { GameState, MatchConfig, PlayerInput, InputMap } from "@chickenz/sim";
import { step, NULL_INPUT } from "@chickenz/sim";
import { InputBuffer } from "./InputBuffer";

/**
 * Client-side prediction manager.
 * Runs the sim locally for the local player, reconciles with server state.
 */
export class PredictionManager {
  predictedState: GameState;
  private lastConfirmedState: GameState;
  private lastConfirmedTick: number;
  private config: MatchConfig;
  private localPlayerId: number;
  private inputBuffer = new InputBuffer();
  private predictedTick: number;
  private prevInputs: InputMap = new Map();

  constructor(initialState: GameState, config: MatchConfig, localPlayerId: number) {
    this.predictedState = initialState;
    this.lastConfirmedState = initialState;
    this.lastConfirmedTick = initialState.tick;
    this.predictedTick = initialState.tick;
    this.config = config;
    this.localPlayerId = localPlayerId;
  }

  /**
   * Run one prediction tick with the local player's input.
   * Returns the predicted state for rendering.
   */
  predictTick(localInput: PlayerInput): GameState {
    this.predictedTick++;
    this.inputBuffer.store(this.predictedTick, localInput);

    // Build input map: local player uses predicted input, remote uses NULL
    const inputs: InputMap = new Map([
      [this.localPlayerId, localInput],
      [1 - this.localPlayerId, NULL_INPUT],
    ]);

    this.predictedState = step(this.predictedState, inputs, this.prevInputs, this.config);
    this.prevInputs = inputs;

    return this.predictedState;
  }

  /**
   * Apply authoritative server state and reconcile.
   * Replays buffered inputs from server tick to current predicted tick.
   */
  applyServerState(serverState: GameState, serverTick: number): void {
    this.lastConfirmedState = serverState;
    this.lastConfirmedTick = serverTick;

    // Check if we need to reconcile
    if (serverTick >= this.predictedTick) {
      // Server is ahead or at same tick — just use server state
      this.predictedState = serverState;
      this.predictedTick = serverTick;
      this.prevInputs = new Map();
      return;
    }

    const serverPlayer = serverState.players[this.localPlayerId];
    const predictedPlayer = this.predictedState.players[this.localPlayerId];

    // Client-authoritative movement: never rollback or nudge position.
    // Instead, merge server-authoritative fields (health, lives, weapon)
    // into the predicted state. The only time we accept server position
    // is on death (respawn teleport to spawn point).
    if (serverPlayer && predictedPlayer) {
      const died = serverPlayer.lives < predictedPlayer.lives;
      const corrected = died
        ? { ...serverPlayer }  // died → accept full server state (respawn position)
        : {
            ...predictedPlayer,
            health: serverPlayer.health,
            lives: serverPlayer.lives,
            weapon: serverPlayer.weapon,
            ammo: serverPlayer.ammo,
            shootCooldown: Math.min(predictedPlayer.shootCooldown, serverPlayer.shootCooldown),
          };
      const players = this.predictedState.players.map((p, i) =>
        i === this.localPlayerId ? corrected : serverState.players[i] ?? p,
      );
      this.predictedState = {
        ...this.predictedState,
        players,
        projectiles: serverState.projectiles,
        weaponPickups: serverState.weaponPickups,
        score: serverState.score,
        matchOver: serverState.matchOver,
        winner: serverState.winner,
        deathLingerTimer: serverState.deathLingerTimer,
      };
    }
  }

  /** Reset prediction state (e.g., on match start). */
  reset(initialState: GameState) {
    this.predictedState = initialState;
    this.lastConfirmedState = initialState;
    this.lastConfirmedTick = initialState.tick;
    this.predictedTick = initialState.tick;
    this.inputBuffer.clear();
    this.prevInputs = new Map();
  }

  get currentTick(): number {
    return this.predictedTick;
  }
}
