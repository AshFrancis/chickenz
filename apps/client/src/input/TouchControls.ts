import { Button } from "@chickenz/sim";

/**
 * Virtual touch controls for mobile: floating joystick (bottom-left) and shoot button (bottom-right).
 * Call init() once after the game canvas is created, then poll getTouchButtons() each frame.
 */
export class TouchControls {
  private active = false;
  private joystickActive = false;
  private joystickBaseX = 0;
  private joystickBaseY = 0;
  private joystickX = 0;
  private joystickY = 0;
  private joystickRadius = 60;
  private deadZone = 0.15;
  private joystickTouchId: number | null = null;

  private shootPressed = false;
  private shootTouchId: number | null = null;

  private joystickCanvas: HTMLCanvasElement | null = null;
  private joystickCtx: CanvasRenderingContext2D | null = null;
  private shootEl: HTMLElement | null = null;
  private container: HTMLElement | null = null;

  /** Initialize touch controls. Call once. */
  init() {
    this.container = document.getElementById("touch-controls");
    this.joystickCanvas = document.getElementById("touch-joystick") as HTMLCanvasElement | null;
    this.shootEl = document.getElementById("touch-shoot");

    if (!this.joystickCanvas || !this.shootEl || !this.container) return;

    this.joystickCtx = this.joystickCanvas.getContext("2d");

    // Joystick touch events
    this.joystickCanvas.addEventListener("touchstart", (e) => this.onJoystickStart(e), { passive: false });
    this.joystickCanvas.addEventListener("touchmove", (e) => this.onJoystickMove(e), { passive: false });
    this.joystickCanvas.addEventListener("touchend", (e) => this.onJoystickEnd(e), { passive: false });
    this.joystickCanvas.addEventListener("touchcancel", (e) => this.onJoystickEnd(e), { passive: false });

    // Shoot button touch events
    this.shootEl.addEventListener("touchstart", (e) => this.onShootStart(e), { passive: false });
    this.shootEl.addEventListener("touchend", (e) => this.onShootEnd(e), { passive: false });
    this.shootEl.addEventListener("touchcancel", (e) => this.onShootEnd(e), { passive: false });

    // Resize joystick canvas to match its display size
    const resizeCanvas = () => {
      if (!this.joystickCanvas) return;
      const rect = this.joystickCanvas.getBoundingClientRect();
      this.joystickCanvas.width = rect.width;
      this.joystickCanvas.height = rect.height;
    };
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
  }

  /** Show controls during gameplay. */
  show() {
    if (this.container) {
      this.container.style.display = "block";
      this.active = true;
    }
  }

  /** Hide controls (lobby, menus). */
  hide() {
    if (this.container) {
      this.container.style.display = "none";
      this.active = false;
      this.reset();
    }
  }

  /** Get current touch state as a buttons bitmask. */
  getTouchButtons(): number {
    if (!this.active) return 0;
    let buttons = 0;

    if (this.joystickActive) {
      const dx = this.joystickX - this.joystickBaseX;
      const dy = this.joystickY - this.joystickBaseY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const norm = dist / this.joystickRadius;

      if (norm > this.deadZone) {
        const angle = Math.atan2(dy, dx);
        const nx = Math.cos(angle);
        const ny = Math.sin(angle);

        // Horizontal: left/right
        if (nx < -0.3) buttons |= Button.Left;
        if (nx > 0.3) buttons |= Button.Right;
        // Vertical: up = jump, down = taunt
        if (ny < -0.5) buttons |= Button.Jump;
        if (ny > 0.7) buttons |= Button.Taunt;
      }
    }

    if (this.shootPressed) buttons |= Button.Shoot;

    return buttons;
  }

  /** Get aim direction from joystick. */
  getAimX(): number {
    if (!this.active || !this.joystickActive) return 0;
    const dx = this.joystickX - this.joystickBaseX;
    const dist = Math.abs(dx);
    if (dist / this.joystickRadius < this.deadZone) return 0;
    return dx > 0 ? 1 : -1;
  }

  private reset() {
    this.joystickActive = false;
    this.joystickTouchId = null;
    this.shootPressed = false;
    this.shootTouchId = null;
    this.clearJoystick();
    if (this.shootEl) {
      this.shootEl.style.background = "rgba(255,50,50,0.3)";
      this.shootEl.style.borderColor = "rgba(255,50,50,0.6)";
    }
  }

  private onJoystickStart(e: TouchEvent) {
    e.preventDefault();
    if (this.joystickTouchId !== null) return; // already tracking a touch
    const touch = e.changedTouches[0];
    if (!touch) return;
    this.joystickTouchId = touch.identifier;
    this.joystickActive = true;
    this.joystickBaseX = touch.clientX;
    this.joystickBaseY = touch.clientY;
    this.joystickX = touch.clientX;
    this.joystickY = touch.clientY;
    this.drawJoystick();
  }

  private onJoystickMove(e: TouchEvent) {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i]!;
      if (touch.identifier === this.joystickTouchId) {
        this.joystickX = touch.clientX;
        this.joystickY = touch.clientY;

        // Clamp to radius
        const dx = this.joystickX - this.joystickBaseX;
        const dy = this.joystickY - this.joystickBaseY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > this.joystickRadius) {
          this.joystickX = this.joystickBaseX + (dx / dist) * this.joystickRadius;
          this.joystickY = this.joystickBaseY + (dy / dist) * this.joystickRadius;
        }
        this.drawJoystick();
        break;
      }
    }
  }

  private onJoystickEnd(e: TouchEvent) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i]!.identifier === this.joystickTouchId) {
        this.joystickActive = false;
        this.joystickTouchId = null;
        this.clearJoystick();
        break;
      }
    }
  }

  private onShootStart(e: TouchEvent) {
    e.preventDefault();
    if (this.shootTouchId !== null) return;
    const touch = e.changedTouches[0];
    if (!touch) return;
    this.shootTouchId = touch.identifier;
    this.shootPressed = true;
    if (this.shootEl) {
      this.shootEl.style.background = "rgba(255,50,50,0.6)";
      this.shootEl.style.borderColor = "rgba(255,100,100,0.9)";
    }
  }

  private onShootEnd(e: TouchEvent) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i]!.identifier === this.shootTouchId) {
        this.shootPressed = false;
        this.shootTouchId = null;
        if (this.shootEl) {
          this.shootEl.style.background = "rgba(255,50,50,0.3)";
          this.shootEl.style.borderColor = "rgba(255,50,50,0.6)";
        }
        break;
      }
    }
  }

  private drawJoystick() {
    const ctx = this.joystickCtx;
    const canvas = this.joystickCanvas;
    if (!ctx || !canvas) return;
    this.clearJoystick();

    // Convert page coords to canvas coords
    const rect = canvas.getBoundingClientRect();
    const baseX = this.joystickBaseX - rect.left;
    const baseY = this.joystickBaseY - rect.top;
    const knobX = this.joystickX - rect.left;
    const knobY = this.joystickY - rect.top;

    // Draw base circle
    ctx.beginPath();
    ctx.arc(baseX, baseY, this.joystickRadius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw knob
    ctx.beginPath();
    ctx.arc(knobX, knobY, 22, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  private clearJoystick() {
    const ctx = this.joystickCtx;
    const canvas = this.joystickCanvas;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}
