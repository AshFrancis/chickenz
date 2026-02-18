import type { PlayerInput } from "@chickenz/sim";
import { Button } from "@chickenz/sim";

/**
 * Manages local keyboard input for two players.
 *
 * P1: WASD + Space to shoot
 * P2: Arrow keys + Shift to shoot
 */
export class InputManager {
  private keys: Record<string, boolean> = {};

  init(_canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => {
      this.keys[e.code] = true;
    });
    window.addEventListener("keyup", (e) => {
      this.keys[e.code] = false;
    });
    window.addEventListener("blur", () => {
      this.keys = {};
    });
  }

  /** P1: WASD + Space, aims in movement/facing direction */
  getPlayer1Input(_playerX: number, _playerY: number): PlayerInput {
    let buttons = 0;
    if (this.keys["KeyA"]) buttons |= Button.Left;
    if (this.keys["KeyD"]) buttons |= Button.Right;
    if (this.keys["KeyW"]) buttons |= Button.Jump;
    if (this.keys["Space"]) buttons |= Button.Shoot;

    // Aim horizontally based on movement keys; (0,0) falls back to facing direction in sim
    let aimX = 0;
    if (this.keys["KeyA"]) aimX = -1;
    if (this.keys["KeyD"]) aimX = 1;

    return { buttons, aimX, aimY: 0 };
  }

  /** P2: Arrow keys + Shift shoot, aims in movement/facing direction */
  getPlayer2Input(_playerX: number, _playerY: number): PlayerInput {
    let buttons = 0;
    if (this.keys["ArrowLeft"]) buttons |= Button.Left;
    if (this.keys["ArrowRight"]) buttons |= Button.Right;
    if (this.keys["ArrowUp"]) buttons |= Button.Jump;
    if (this.keys["ShiftRight"] || this.keys["ShiftLeft"]) buttons |= Button.Shoot;

    // Aim horizontally based on arrow keys; (0,0) falls back to facing direction in sim
    let aimX = 0;
    if (this.keys["ArrowLeft"]) aimX = -1;
    if (this.keys["ArrowRight"]) aimX = 1;

    return { buttons, aimX, aimY: 0 };
  }
}
