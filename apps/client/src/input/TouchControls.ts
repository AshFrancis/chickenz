import { Button } from "@chickenz/sim";

/**
 * Virtual touch controls for mobile.
 * - Left side: fixed circular joystick. Drag direction maps to movement + jump.
 *   Up = jump, up-left/right = move+jump, left/right = move, tap center = taunt.
 * - Right side: circular shoot button.
 */
export class TouchControls {
  private active = false;

  // Joystick state
  private joystickActive = false;
  private joystickTouchId: number | null = null;
  private knobX = 0; // current knob offset from base (canvas coords)
  private knobY = 0;
  private joystickRadius = 65;
  private knobRadius = 28;
  private deadZone = 0.18;

  // Tap detection for taunt
  private touchStartX = 0;
  private touchStartY = 0;
  private touchStartTime = 0;
  private taunting = false;
  private tauntTimer = 0;

  // Jump pulsing: periodically drop jump to 0 so sim sees rising edges for re-jumps
  private jumpFrameCount = 0;

  // Spin/shake detection for stomp escape
  private lastAngle = 0;
  private angularSpeed = 0; // smoothed rad/frame EMA
  private shakeTimer = 0; // frames remaining in shake mode
  private shakeFrame = 0; // cycle counter for L/R alternation

  // Shoot state
  private shootPressed = false;
  private shootTouchId: number | null = null;

  // DOM
  private joystickCanvas: HTMLCanvasElement | null = null;
  private joystickCtx: CanvasRenderingContext2D | null = null;
  private shootEl: HTMLElement | null = null;
  private container: HTMLElement | null = null;

  // Fixed joystick center in canvas coords (updated on resize)
  private baseCX = 0;
  private baseCY = 0;

  init() {
    this.container = document.getElementById("touch-controls");
    this.joystickCanvas = document.getElementById("touch-joystick") as HTMLCanvasElement | null;
    this.shootEl = document.getElementById("touch-shoot");

    if (!this.joystickCanvas || !this.shootEl || !this.container) return;

    this.joystickCtx = this.joystickCanvas.getContext("2d");

    this.joystickCanvas.addEventListener("touchstart", (e) => this.onJoystickStart(e), { passive: false });
    this.joystickCanvas.addEventListener("touchmove", (e) => this.onJoystickMove(e), { passive: false });
    this.joystickCanvas.addEventListener("touchend", (e) => this.onJoystickEnd(e), { passive: false });
    this.joystickCanvas.addEventListener("touchcancel", (e) => this.onJoystickEnd(e), { passive: false });

    this.shootEl.addEventListener("touchstart", (e) => this.onShootStart(e), { passive: false });
    this.shootEl.addEventListener("touchend", (e) => this.onShootEnd(e), { passive: false });
    this.shootEl.addEventListener("touchcancel", (e) => this.onShootEnd(e), { passive: false });

    window.addEventListener("resize", () => this.resizeCanvas());
  }

  private resizeCanvas() {
    if (!this.joystickCanvas) return;
    const rect = this.joystickCanvas.getBoundingClientRect();
    this.joystickCanvas.width = rect.width * window.devicePixelRatio;
    this.joystickCanvas.height = rect.height * window.devicePixelRatio;
    this.joystickCtx = this.joystickCanvas.getContext("2d");
    this.joystickCtx?.scale(window.devicePixelRatio, window.devicePixelRatio);
    // Fixed base: 110px from left, 110px from bottom of canvas display area
    this.baseCX = 110;
    this.baseCY = rect.height - 110;
  }

  show() {
    if (this.container) {
      this.container.style.display = "block";
      this.active = true;
      this.resizeCanvas();
      this.drawJoystick();
    }
  }

  hide() {
    if (this.container) {
      this.container.style.display = "none";
      this.active = false;
      this.reset();
    }
  }

  getTouchButtons(): number {
    if (!this.active) return 0;
    let buttons = 0;

    if (this.taunting) {
      buttons |= Button.Taunt;
    } else if (this.joystickActive) {
      const dist = Math.sqrt(this.knobX * this.knobX + this.knobY * this.knobY);
      const norm = dist / this.joystickRadius;

      // Spin detection: track angular velocity for shake-off mechanic
      if (norm > 0.35) {
        const angle = Math.atan2(this.knobY, this.knobX);
        let delta = angle - this.lastAngle;
        if (delta > Math.PI) delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;
        this.angularSpeed = 0.7 * this.angularSpeed + 0.3 * Math.abs(delta);
        this.lastAngle = angle;
        if (this.angularSpeed > 0.12) this.shakeTimer = 25;
      } else {
        this.angularSpeed *= 0.85;
        this.lastAngle = Math.atan2(this.knobY, this.knobX);
      }

      if (this.shakeTimer > 0) {
        // Shake mode: rapid L/R alternation every 3 frames (~10 switches/sec)
        this.shakeTimer--;
        this.shakeFrame++;
        buttons |= this.shakeFrame % 6 < 3 ? Button.Left : Button.Right;
      } else if (norm > this.deadZone) {
        const nx = this.knobX / dist; // positive = right
        const ny = this.knobY / dist; // positive = down (screen coords)

        // Upward component: pulse jump every ~50 frames so sim sees rising edges on re-land
        if (ny < -0.2) {
          this.jumpFrameCount++;
          // Hold jump for 47 frames, release for 3 — ~1s cycle, long enough for full jump arc
          if (this.jumpFrameCount % 50 < 47) buttons |= Button.Jump;
        } else {
          this.jumpFrameCount = 0;
        }
        // Horizontal components
        if (nx > 0.3) buttons |= Button.Right;
        if (nx < -0.3) buttons |= Button.Left;
      }
    }

    if (this.shootPressed) buttons |= Button.Shoot;

    return buttons;
  }

  getAimX(): number {
    if (!this.active || !this.joystickActive) return 0;
    const dist = Math.abs(this.knobX);
    if (dist / this.joystickRadius < this.deadZone) return 0;
    return this.knobX > 0 ? 1 : -1;
  }

  private reset() {
    this.joystickActive = false;
    this.joystickTouchId = null;
    this.knobX = 0;
    this.knobY = 0;
    this.taunting = false;
    this.tauntTimer = 0;
    this.shootPressed = false;
    this.shootTouchId = null;
    this.updateShootVisual(false);
    this.drawJoystick();
  }

  private onJoystickStart(e: TouchEvent) {
    e.preventDefault();
    if (this.joystickTouchId !== null) return;
    const touch = e.changedTouches[0];
    if (!touch) return;
    this.joystickTouchId = touch.identifier;
    this.joystickActive = true;
    this.knobX = 0;
    this.knobY = 0;

    // Record start for tap detection
    const rect = this.joystickCanvas!.getBoundingClientRect();
    this.touchStartX = touch.clientX - rect.left;
    this.touchStartY = touch.clientY - rect.top;
    this.touchStartTime = Date.now();
    this.taunting = false;

    this.drawJoystick();
  }

  private onJoystickMove(e: TouchEvent) {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i]!;
      if (touch.identifier !== this.joystickTouchId) continue;

      const rect = this.joystickCanvas!.getBoundingClientRect();
      const cx = touch.clientX - rect.left;
      const cy = touch.clientY - rect.top;

      // Knob offset from fixed base center
      let dx = cx - this.baseCX;
      let dy = cy - this.baseCY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > this.joystickRadius) {
        dx = (dx / dist) * this.joystickRadius;
        dy = (dy / dist) * this.joystickRadius;
      }
      this.knobX = dx;
      this.knobY = dy;
      this.drawJoystick();
      break;
    }
  }

  private onJoystickEnd(e: TouchEvent) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i]!.identifier !== this.joystickTouchId) continue;

      // Detect tap for taunt: small displacement + quick release
      const dx = this.knobX;
      const dy = this.knobY;
      const moved = Math.sqrt(dx * dx + dy * dy);
      const duration = Date.now() - this.touchStartTime;
      if (moved < this.joystickRadius * this.deadZone * 1.5 && duration < 250) {
        this.taunting = true;
        clearTimeout(this.tauntTimer);
        this.tauntTimer = window.setTimeout(() => {
          this.taunting = false;
        }, 150);
      }

      this.joystickActive = false;
      this.joystickTouchId = null;
      this.knobX = 0;
      this.knobY = 0;
      this.jumpFrameCount = 0;
      this.angularSpeed = 0;
      this.shakeTimer = 0;
      this.shakeFrame = 0;
      this.drawJoystick();
      break;
    }
  }

  private onShootStart(e: TouchEvent) {
    e.preventDefault();
    if (this.shootTouchId !== null) return;
    const touch = e.changedTouches[0];
    if (!touch) return;
    this.shootTouchId = touch.identifier;
    this.shootPressed = true;
    this.updateShootVisual(true);
  }

  private onShootEnd(e: TouchEvent) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i]!.identifier !== this.shootTouchId) continue;
      this.shootPressed = false;
      this.shootTouchId = null;
      this.updateShootVisual(false);
      break;
    }
  }

  private updateShootVisual(pressed: boolean) {
    if (!this.shootEl) return;
    if (pressed) {
      this.shootEl.style.background = "rgba(255,50,50,0.65)";
      this.shootEl.style.borderColor = "rgba(255,120,120,0.95)";
      this.shootEl.style.transform = "scale(0.93)";
    } else {
      this.shootEl.style.background = "rgba(255,50,50,0.25)";
      this.shootEl.style.borderColor = "rgba(255,50,50,0.55)";
      this.shootEl.style.transform = "scale(1)";
    }
  }

  private drawJoystick() {
    const ctx = this.joystickCtx;
    const canvas = this.joystickCanvas;
    if (!ctx || !canvas) return;

    const w = canvas.width / window.devicePixelRatio;
    const h = canvas.height / window.devicePixelRatio;
    ctx.clearRect(0, 0, w, h);

    const cx = this.baseCX;
    const cy = this.baseCY;
    const r = this.joystickRadius;

    // Outer base ring (always visible) — orange when shake mode active
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = this.shakeTimer > 0 ? "rgba(255,150,0,0.12)" : "rgba(255,255,255,0.06)";
    ctx.fill();
    ctx.strokeStyle = this.shakeTimer > 0 ? "rgba(255,180,0,0.8)" : "rgba(255,255,255,0.18)";
    ctx.lineWidth = this.shakeTimer > 0 ? 3.5 : 2.5;
    ctx.stroke();

    // Inner dead zone ring
    ctx.beginPath();
    ctx.arc(cx, cy, r * this.deadZone * 2, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.stroke();

    if (this.joystickActive) {
      // Highlight active direction zone
      const dist = Math.sqrt(this.knobX * this.knobX + this.knobY * this.knobY);
      const norm = dist / r;

      if (norm > this.deadZone) {
        const nx = this.knobX / dist;
        const ny = this.knobY / dist;
        const angle = Math.atan2(ny, nx);

        ctx.beginPath();
        // Arc segment showing active zone (~60° wide)
        ctx.arc(cx, cy, r - 8, angle - 0.55, angle + 0.55);
        ctx.strokeStyle = "rgba(255,255,100,0.35)";
        ctx.lineWidth = 8;
        ctx.stroke();
      }

      // Knob
      const kx = cx + this.knobX;
      const ky = cy + this.knobY;
      ctx.beginPath();
      ctx.arc(kx, ky, this.knobRadius, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.28)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 2.5;
      ctx.stroke();
    } else {
      // Resting knob at center
      ctx.beginPath();
      ctx.arc(cx, cy, this.knobRadius, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}
