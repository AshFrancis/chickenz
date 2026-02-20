import type { PlayerInput } from "@chickenz/sim";
import { Button } from "@chickenz/sim";

/** Each action has two bindable slots: [primary, secondary]. Empty string = unbound. */
export interface KeyBindings {
  left: [string, string];
  right: [string, string];
  jump: [string, string];
  shoot: [string, string];
  taunt: [string, string];
}

export type BindAction = keyof KeyBindings;

const DEFAULT_BINDINGS: KeyBindings = {
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  jump: ["KeyW", "ArrowUp"],
  shoot: ["Space", "Mouse0"],
  taunt: ["KeyS", "ArrowDown"],
};

const STORAGE_KEY = "chickenz-bindings";

/** Human-readable label for a keyboard/mouse code. */
export function friendlyKeyName(code: string): string {
  if (!code) return "—";
  if (code === "Mouse0") return "MOUSE1";
  if (code === "Mouse1") return "MOUSE3";
  if (code === "Mouse2") return "MOUSE2";
  if (code === "Space") return "SPACE";
  if (code.startsWith("Key")) return code.slice(3).toUpperCase();
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Arrow")) return code.slice(5).toUpperCase();
  if (code.startsWith("Shift")) return "SHIFT";
  if (code.startsWith("Control")) return "CTRL";
  if (code.startsWith("Alt")) return "ALT";
  return code.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();
}

/**
 * Manages local keyboard input with two rebindable slots per action.
 */
export class InputManager {
  private keys: Record<string, boolean> = {};
  private bindings: KeyBindings;

  constructor() {
    this.bindings = this.loadBindings();
  }

  init(canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => {
      this.keys[e.code] = true;
    });
    window.addEventListener("keyup", (e) => {
      this.keys[e.code] = false;
    });
    canvas.addEventListener("mousedown", (e) => {
      this.keys[`Mouse${e.button}`] = true;
    });
    canvas.addEventListener("mouseup", (e) => {
      this.keys[`Mouse${e.button}`] = false;
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("blur", () => {
      this.keys = {};
    });
  }

  getBindings(): KeyBindings {
    return {
      left: [...this.bindings.left],
      right: [...this.bindings.right],
      jump: [...this.bindings.jump],
      shoot: [...this.bindings.shoot],
      taunt: [...this.bindings.taunt],
    };
  }

  setBindings(b: KeyBindings) {
    this.bindings = {
      left: [...b.left],
      right: [...b.right],
      jump: [...b.jump],
      shoot: [...b.shoot],
      taunt: [...b.taunt],
    };
    this.saveBindings();
  }

  resetBindings(): KeyBindings {
    this.bindings = {
      left: [...DEFAULT_BINDINGS.left],
      right: [...DEFAULT_BINDINGS.right],
      jump: [...DEFAULT_BINDINGS.jump],
      shoot: [...DEFAULT_BINDINGS.shoot],
      taunt: [...DEFAULT_BINDINGS.taunt],
    };
    this.saveBindings();
    return this.getBindings();
  }

  /** Check if either slot for an action is pressed. */
  private isPressed(action: BindAction): boolean {
    const [a, b] = this.bindings[action];
    return !!(a && this.keys[a]) || !!(b && this.keys[b]);
  }

  getPlayer1Input(_playerX: number, _playerY: number): PlayerInput {
    let buttons = 0;

    const left = this.isPressed("left");
    const right = this.isPressed("right");
    const jump = this.isPressed("jump");
    const shoot = this.isPressed("shoot");
    const taunt = this.isPressed("taunt");

    if (left) buttons |= Button.Left;
    if (right) buttons |= Button.Right;
    if (jump) buttons |= Button.Jump;
    if (shoot) buttons |= Button.Shoot;
    if (taunt) buttons |= Button.Taunt;

    let aimX = 0;
    if (left) aimX = -1;
    if (right) aimX = 1;

    return { buttons, aimX, aimY: 0 };
  }

  private loadBindings(): KeyBindings {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const p = JSON.parse(stored);
        // Support migration from old formats (crouch → taunt, single-key → pair)
        const migrate = (v: any, def: [string, string]): [string, string] => {
          if (Array.isArray(v) && v.length === 2) return [v[0] ?? "", v[1] ?? ""];
          if (typeof v === "string") return [v, def[1]];
          return [...def];
        };
        return {
          left: migrate(p.left, DEFAULT_BINDINGS.left),
          right: migrate(p.right, DEFAULT_BINDINGS.right),
          jump: migrate(p.jump, DEFAULT_BINDINGS.jump),
          shoot: migrate(p.shoot, DEFAULT_BINDINGS.shoot),
          taunt: migrate(p.taunt ?? p.crouch, DEFAULT_BINDINGS.taunt),
        };
      }
    } catch {
      // Corrupt data — use defaults
    }
    return {
      left: [...DEFAULT_BINDINGS.left],
      right: [...DEFAULT_BINDINGS.right],
      jump: [...DEFAULT_BINDINGS.jump],
      shoot: [...DEFAULT_BINDINGS.shoot],
      taunt: [...DEFAULT_BINDINGS.taunt],
    };
  }

  private saveBindings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings));
  }
}
