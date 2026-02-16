import type { PlayerInput } from "@chickenz/sim";

/** Recorded input for one tick: [player0, player1]. */
export type TickInputs = [PlayerInput, PlayerInput];

/**
 * Records all per-tick inputs during a match.
 * The resulting transcript + seed is exactly what the RISC Zero prover needs.
 */
export class TranscriptRecorder {
  private inputs: TickInputs[] = [];
  private _seed: number = 0;

  start(seed: number) {
    this.inputs = [];
    this._seed = seed;
  }

  record(p0: PlayerInput, p1: PlayerInput) {
    this.inputs.push([
      { buttons: p0.buttons, aimX: p0.aimX, aimY: p0.aimY },
      { buttons: p1.buttons, aimX: p1.aimX, aimY: p1.aimY },
    ]);
  }

  get seed(): number {
    return this._seed;
  }

  get length(): number {
    return this.inputs.length;
  }

  /** Export as ProverInput JSON (matches services/prover/core/src/types.rs). */
  toProverInput(): object {
    return {
      config: {
        seed: this._seed,
        // The prover only needs seed — map/config are hardcoded in the guest
      },
      transcript: this.inputs.map(([p0, p1]) => [
        { buttons: p0.buttons, aim_x: p0.aimX, aim_y: p0.aimY },
        { buttons: p1.buttons, aim_x: p1.aimX, aim_y: p1.aimY },
      ]),
    };
  }

  /** Download transcript as JSON file (for manual prover submission). */
  download() {
    const json = JSON.stringify(this.toProverInput(), null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chickenz_transcript_${this._seed}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
