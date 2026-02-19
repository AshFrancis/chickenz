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

    // Server is ahead or at same tick — accept server state but still
    // protect local cooldown and projectile ownership (server may not
    // have received our fire input yet, especially on low-latency/localhost).
    if (serverTick >= this.predictedTick) {
      const sp = serverState.players[this.localPlayerId];
      const pp = this.predictedState.players[this.localPlayerId];
      const remoteProj = serverState.projectiles.filter(
        p => p.ownerId !== this.localPlayerId,
      );
      const localProj = this.predictedState.projectiles.filter(
        p => p.ownerId === this.localPlayerId,
      );
      let players = serverState.players;
      if (sp && pp) {
        players = serverState.players.map((p, i) =>
          i === this.localPlayerId
            ? { ...p, shootCooldown: pp.shootCooldown }
            : p,
        );
      }
      this.predictedState = {
        ...serverState,
        players,
        projectiles: [...remoteProj, ...localProj],
      };
      this.predictedTick = serverTick;
      this.prevInputs = new Map();
      return;
    }

    const serverPlayer = serverState.players[this.localPlayerId];
    const predictedPlayer = this.predictedState.players[this.localPlayerId];

    // Server-authoritative position with smooth convergence.
    // Nudge predicted position toward server each update so client
    // never permanently diverges (e.g. grounded mismatch on platforms).
    const DEAD_ZONE = 2;        // px — ignore tiny divergence
    const NUDGE_FACTOR = 0.15;  // blend 15% toward server per update (~300ms convergence)
    const SNAP_THRESHOLD = 60;  // px — teleport if way off

    if (serverPlayer && predictedPlayer) {
      const died = serverPlayer.lives < predictedPlayer.lives;

      let corrected;
      if (died) {
        // Died → accept full server state (respawn position)
        corrected = { ...serverPlayer };
      } else {
        const dx = serverPlayer.x - predictedPlayer.x;
        const dy = serverPlayer.y - predictedPlayer.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        let nx = predictedPlayer.x;
        let ny = predictedPlayer.y;
        let nvx = predictedPlayer.vx;
        let nvy = predictedPlayer.vy;
        let nGrounded = predictedPlayer.grounded;

        if (dist > SNAP_THRESHOLD) {
          // Way off — teleport to server position
          nx = serverPlayer.x;
          ny = serverPlayer.y;
          nvx = serverPlayer.vx;
          nvy = serverPlayer.vy;
          nGrounded = serverPlayer.grounded;
        } else if (dist > DEAD_ZONE) {
          // Smooth nudge toward server
          nx += dx * NUDGE_FACTOR;
          ny += dy * NUDGE_FACTOR;
          nvx += (serverPlayer.vx - predictedPlayer.vx) * NUDGE_FACTOR;
          nvy += (serverPlayer.vy - predictedPlayer.vy) * NUDGE_FACTOR;
          // Trust server grounded state to prevent gravity re-divergence
          nGrounded = serverPlayer.grounded;
        }

        corrected = {
          ...predictedPlayer,
          x: nx,
          y: ny,
          vx: nvx,
          vy: nvy,
          grounded: nGrounded,
          health: serverPlayer.health,
          lives: serverPlayer.lives,
          weapon: serverPlayer.weapon,
          ammo: serverPlayer.ammo,
          shootCooldown: predictedPlayer.shootCooldown,
        };
      }

      const players = this.predictedState.players.map((p, i) =>
        i === this.localPlayerId ? corrected : serverState.players[i] ?? p,
      );
      // Split projectiles by ownership:
      // - Remote-owned: server is authoritative (prediction doesn't have remote input)
      // - Local-owned: prediction is authoritative (responsive, no ghost doubles)
      const remoteProjectiles = serverState.projectiles.filter(
        p => p.ownerId !== this.localPlayerId,
      );
      const localProjectiles = this.predictedState.projectiles.filter(
        p => p.ownerId === this.localPlayerId,
      );
      this.predictedState = {
        ...this.predictedState,
        players,
        projectiles: [...remoteProjectiles, ...localProjectiles],
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
