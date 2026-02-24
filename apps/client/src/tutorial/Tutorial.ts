/**
 * Tutorial system: standalone local WASM session with 7 guided steps.
 * Teaches movement, jumping, weapon pickup, shooting, stomp escape, and killing.
 * Tutorial controls P2 behavior per step via TutorialTickResult.
 */

import { Button, PLAYER_HEIGHT } from "@chickenz/sim";
import type { PlayerInput } from "@chickenz/sim";
import type { StateMessage, SerializedPlayer } from "../../../../services/server/src/protocol";

type GameStateData = Omit<StateMessage, "type">;

const STORAGE_KEY = "chickenz-tutorial-done";

/** Result returned each tick to control P2 and modify state. */
export interface TutorialTickResult {
  p2Buttons: number;
  p2AimX: number;
  p2AimY: number;
  banishP2: boolean;
  modifyState?: (state: GameStateData) => void;
}

type StepCondition = "movement" | "jump" | "double_jump" | "weapon" | "shoot" | "stomp_escape" | "kill_p2" | "auto";

interface TutorialStep {
  text: string;
  mobileText: string;
  condition: StepCondition;
  autoAdvanceMs?: number;
}

const STEPS: TutorialStep[] = [
  {
    text: "Press A/D to move",
    mobileText: "Use joystick to move",
    condition: "movement",
  },
  {
    text: "Press W to jump",
    mobileText: "Push joystick up to jump",
    condition: "jump",
  },
  {
    text: "Press W again mid-air to double jump!\nReach the high platform!",
    mobileText: "Push joystick up again while airborne!\nReach the high platform!",
    condition: "double_jump",
  },
  {
    text: "Walk over a weapon to pick it up",
    mobileText: "Walk over a weapon to pick it up",
    condition: "weapon",
  },
  {
    text: "Press SPACE to shoot",
    mobileText: "Tap the red button to shoot",
    condition: "shoot",
  },
  {
    text: "You've been stomped!\nMash LEFT and RIGHT to escape!",
    mobileText: "You've been stomped!\nMash LEFT and RIGHT to escape!",
    condition: "stomp_escape",
  },
  {
    text: "Now take them out!",
    mobileText: "Now take them out!",
    condition: "kill_p2",
  },
  {
    text: "You're ready! Good luck!",
    mobileText: "You're ready! Good luck!",
    condition: "auto",
    autoAdvanceMs: 3000,
  },
];

export class Tutorial {
  private overlay: HTMLElement | null = null;
  private promptEl: HTMLElement | null = null;
  private stepEl: HTMLElement | null = null;
  private stepText: HTMLElement | null = null;
  private currentStep = -1;
  private active = false;
  private isMobile = false;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private onComplete: (() => void) | null = null;

  // Per-step tracking
  private moveTicks = 0;
  private hasJumped = false;
  private hasWeapon = false;
  private hasShot = false;
  private hasDoubleJumped = false;
  private stompSetup = false; // true once stomp step setup has been applied
  private killSetup = false; // true once kill step setup has been applied

  static shouldShow(): boolean {
    return !localStorage.getItem(STORAGE_KEY);
  }

  static markDone() {
    localStorage.setItem(STORAGE_KEY, "1");
  }

  init(isMobile: boolean) {
    this.isMobile = isMobile;
    this.overlay = document.getElementById("tutorial-overlay");
    this.promptEl = document.getElementById("tutorial-prompt");
    this.stepEl = document.getElementById("tutorial-step");
    this.stepText = document.getElementById("tutorial-step-text");

    // Skip button during steps (not prompt — prompt buttons handled by main.ts)
    document.getElementById("btn-tutorial-skip-step")?.addEventListener("click", () => {
      this.complete();
    });
  }

  /** Start the tutorial steps (called externally after scene setup). */
  start(onComplete: () => void) {
    this.onComplete = onComplete;
    if (!this.stepEl || !this.overlay) return;
    this.overlay.style.display = "block";
    this.overlay.style.pointerEvents = "none";
    this.active = true;
    this.currentStep = 0;
    this.moveTicks = 0;
    this.hasJumped = false;
    this.hasDoubleJumped = false;
    this.hasWeapon = false;
    this.hasShot = false;
    this.stompSetup = false;
    this.killSetup = false;
    this.showCurrentStep();
  }

  /**
   * Called each WASM tick by GameScene. Returns P2 input + state modifiers.
   * The caller steps WASM with P1+P2 input, exports state, applies modifiers,
   * then imports the modified state back into WASM.
   */
  tick(state: GameStateData, p1Input: PlayerInput): TutorialTickResult {
    if (!this.active || this.currentStep < 0) {
      return { p2Buttons: 0, p2AimX: 0, p2AimY: 0, banishP2: true };
    }

    const step = STEPS[this.currentStep];
    if (!step) {
      return { p2Buttons: 0, p2AimX: 0, p2AimY: 0, banishP2: true };
    }

    const p0 = state.players[0];
    const p1 = state.players[1];

    switch (step.condition) {
      case "movement":
        if (p1Input.buttons & (Button.Left | Button.Right)) this.moveTicks++;
        if (this.moveTicks >= 30) this.advanceStep();
        return { p2Buttons: 0, p2AimX: 0, p2AimY: 0, banishP2: true };

      case "jump":
        if (p1Input.buttons & Button.Jump) this.hasJumped = true;
        if (this.hasJumped) this.advanceStep();
        return { p2Buttons: 0, p2AimX: 0, p2AimY: 0, banishP2: true };

      case "double_jump":
        // Detect double jump: player used both jumps (jumpsLeft === 0) and is airborne
        if (p0 && p0.jumpsLeft === 0 && !p0.grounded) this.hasDoubleJumped = true;
        if (this.hasDoubleJumped) this.advanceStep();
        return { p2Buttons: 0, p2AimX: 0, p2AimY: 0, banishP2: true };

      case "weapon":
        if (p0 && p0.weapon !== null && p0.weapon >= 0) this.hasWeapon = true;
        if (this.hasWeapon) this.advanceStep();
        return { p2Buttons: 0, p2AimX: 0, p2AimY: 0, banishP2: true };

      case "shoot":
        if (p1Input.buttons & Button.Shoot) this.hasShot = true;
        if (this.hasShot) this.advanceStep();
        return { p2Buttons: 0, p2AimX: 0, p2AimY: 0, banishP2: true };

      case "stomp_escape": {
        // First tick of this step: set up stomp state
        const needSetup = !this.stompSetup;
        this.stompSetup = true;

        // Check completion: player 0 is no longer being stomped
        if (this.stompSetup && p0 && (p0.stompedBy === null || p0.stompedBy < 0)) {
          // Only advance if we've been in stomp at least once (not on the setup tick)
          if (!needSetup) {
            this.advanceStep();
            return { p2Buttons: 0, p2AimX: 0, p2AimY: 0, banishP2: true };
          }
        }

        return {
          p2Buttons: 0,
          p2AimX: 0,
          p2AimY: 0,
          banishP2: false,
          modifyState: (s: GameStateData) => {
            const sp0 = s.players[0] as SerializedPlayer & Record<string, number>;
            const sp1 = s.players[1] as SerializedPlayer & Record<string, number>;
            if (!sp0 || !sp1) return;
            // Keep P0 health at 100 so stomp doesn't kill
            sp0.health = 100;
            if (needSetup) {
              // Position P2 on P0's head
              sp1.x = sp0.x;
              sp1.y = sp0.y - PLAYER_HEIGHT;
              sp1.vx = 0;
              sp1.vy = 0;
              sp1.grounded = true;
              sp1.stateFlags = 1; // Alive
              sp1.health = 100;
              sp1.lives = 99;
              // Set stomp state
              sp0.stompedBy = 1;
              sp1.stompingOn = 0;
              sp0.stompShakeProgress = 0;
              sp0.stompCooldown = 0;
              sp0["stompLastShakeDir"] = 0;
              sp0["stompAutoRunDir"] = 1;
              sp0["stompAutoRunTimer"] = 40;
            }
          },
        };
      }

      case "kill_p2": {
        // First tick: set up P2 standing nearby at low HP
        const needSetup = !this.killSetup;
        this.killSetup = true;

        // Check completion: P2 is dead
        if (p1 && !(p1.stateFlags & 1)) {
          this.advanceStep();
          return { p2Buttons: 0, p2AimX: 0, p2AimY: 0, banishP2: true };
        }

        return {
          p2Buttons: 0,
          p2AimX: 0,
          p2AimY: 0,
          banishP2: false,
          modifyState: needSetup
            ? (s: GameStateData) => {
                const sp0 = s.players[0] as SerializedPlayer & Record<string, number>;
                const sp1 = s.players[1] as SerializedPlayer & Record<string, number>;
                if (!sp0 || !sp1) return;
                // Clear stomp fields from both players
                sp0.stompedBy = -1;
                sp0.stompingOn = -1;
                sp0.stompShakeProgress = 0;
                sp0.stompCooldown = 0;
                sp0["stompLastShakeDir"] = 0;
                sp0["stompAutoRunDir"] = 1;
                sp0["stompAutoRunTimer"] = 0;
                sp1.stompedBy = -1;
                sp1.stompingOn = -1;
                sp1.stompShakeProgress = 0;
                sp1.stompCooldown = 99999;
                sp1["stompLastShakeDir"] = 0;
                sp1["stompAutoRunDir"] = 1;
                sp1["stompAutoRunTimer"] = 0;
                // Position P2 nearby (120px in front of P0, same surface)
                const facing = sp0.facing ?? 1;
                sp1.x = sp0.x + facing * 120;
                sp1.y = sp0.y;
                sp1.vx = 0;
                sp1.vy = 0;
                sp1.stateFlags = 1; // Alive
                sp1.health = 15;
                sp1.lives = 1;
                sp1.grounded = true;
              }
            : undefined,
        };
      }

      case "auto":
        // Auto-advance handled by timer in showCurrentStep
        return { p2Buttons: 0, p2AimX: 0, p2AimY: 0, banishP2: true };

      default:
        return { p2Buttons: 0, p2AimX: 0, p2AimY: 0, banishP2: true };
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  hide() {
    if (this.autoTimer) {
      clearTimeout(this.autoTimer);
      this.autoTimer = null;
    }
    if (this.overlay) this.overlay.style.display = "none";
    if (this.promptEl) this.promptEl.style.display = "none";
    if (this.stepEl) this.stepEl.style.display = "none";
    this.active = false;
    this.currentStep = -1;
  }

  private showCurrentStep() {
    const step = STEPS[this.currentStep];
    if (!step || !this.stepEl || !this.stepText) {
      this.complete();
      return;
    }

    this.stepEl.style.display = "block";
    this.stepText.textContent = this.isMobile ? step.mobileText : step.text;

    if (step.condition === "auto" && step.autoAdvanceMs) {
      if (this.autoTimer) clearTimeout(this.autoTimer);
      this.autoTimer = setTimeout(() => {
        this.autoTimer = null;
        this.advanceStep();
      }, step.autoAdvanceMs);
    }
  }

  private advanceStep() {
    if (this.autoTimer) {
      clearTimeout(this.autoTimer);
      this.autoTimer = null;
    }
    this.currentStep++;
    if (this.currentStep >= STEPS.length) {
      this.complete();
    } else {
      this.showCurrentStep();
    }
  }

  private complete() {
    Tutorial.markDone();
    this.hide();
    this.onComplete?.();
    this.onComplete = null;
  }
}
