import type { GameScene } from "../scenes/GameScene";
import type { KeyBindings } from "../input/InputManager";
import { friendlyKeyName } from "../input/InputManager";
import { session } from "../session";

export interface SettingsPanelDeps {
  // DOM elements
  settingsBtn: HTMLButtonElement;
  settingsOverlay: HTMLDivElement;
  settingsClose: HTMLButtonElement;
  btnResetKeys: HTMLButtonElement;
  sliderBGM: HTMLInputElement;
  sliderSFX: HTMLInputElement;
  valBGM: HTMLSpanElement;
  valSFX: HTMLSpanElement;
  checkDynamicZoom: HTMLInputElement;
  checkMusic: HTMLInputElement;
  settingsUsername: HTMLInputElement;
  btnSaveUsername: HTMLButtonElement;
  settingsUsernameError: HTMLDivElement;
  muteBtn: HTMLButtonElement;
  fullscreenBtn: HTMLButtonElement;
  charHomeName: HTMLSpanElement;
  charAwayName: HTMLSpanElement;
  matchDetailOverlay: HTMLElement; // needed for Escape key handler in main.ts
  // Callbacks
  getGameScene: () => GameScene | null;
  getNetworkManager: () => import("../net/NetworkManager").NetworkManager | null;
  onSaveUsername: (name: string) => void; // called when username saved (updates topBarUsername etc)
}

export interface SettingsPanelAPI {
  open: () => void;
  close: () => void;
  applyAudioSettings: (scene: GameScene) => void;
  isOpen: () => boolean;
}

const NUM_CHARACTERS = 4;
const CHARACTER_NAMES = ["NINJA FROG", "MASK DUDE", "PINK MAN", "VIRTUAL GUY"];

// Music note icon (unmuted) / music note + strikethrough (muted)
const MUSIC_ICON_ON = '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>';
const MUSIC_ICON_OFF =
  '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/><line x1="2" y1="12" x2="22" y2="12" stroke="white" stroke-width="2.5" opacity="0.5"/>';

export function initSettingsPanel(deps: SettingsPanelDeps): SettingsPanelAPI {
  const {
    settingsBtn,
    settingsOverlay,
    settingsClose,
    btnResetKeys,
    sliderBGM,
    sliderSFX,
    valBGM,
    valSFX,
    checkDynamicZoom,
    checkMusic,
    settingsUsername,
    btnSaveUsername,
    settingsUsernameError,
    muteBtn,
    fullscreenBtn,
    charHomeName,
    charAwayName,
    getGameScene,
    getNetworkManager,
    onSaveUsername,
  } = deps;

  // ── Local settings state ──────────────────────────────────────────────────────
  let settingsOpen = false;
  let listeningBtn: HTMLButtonElement | null = null;
  let listeningAction: string | null = null;
  let listeningSlot: number = 0;

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function getInputManager() {
    const scene = getGameScene();
    return scene ? scene.inputManager : null;
  }

  function refreshKeyBindingUI() {
    const im = getInputManager();
    if (!im) return;
    const bindings = im.getBindings();
    document.querySelectorAll<HTMLButtonElement>(".key-btn").forEach((btn) => {
      const action = btn.dataset.action as keyof KeyBindings | undefined;
      const slot = parseInt(btn.dataset.slot ?? "0", 10) as 0 | 1;
      if (action && bindings[action]) {
        btn.textContent = friendlyKeyName(bindings[action][slot]);
      }
    });
  }

  function updateCharUI() {
    charHomeName.textContent = CHARACTER_NAMES[session.homeCharacter] ?? "???";
    charAwayName.textContent = CHARACTER_NAMES[session.awayCharacter] ?? "???";
  }

  function updateMusicIcon(muted: boolean) {
    const svg = document.getElementById("mute-icon");
    if (svg) svg.innerHTML = muted ? MUSIC_ICON_OFF : MUSIC_ICON_ON;
    muteBtn.title = muted ? "Music Off" : "Mute Music";
  }

  function setMusicMuted(muted: boolean) {
    localStorage.setItem("chickenz-music-muted", String(muted));
    checkMusic.checked = !muted;
    updateMusicIcon(muted);
    const scene = getGameScene();
    if (scene) scene.setMusicMuted(muted);
  }

  function applyAudioSettings(scene: GameScene) {
    const bgm = parseInt(localStorage.getItem("chickenz-bgm-volume") ?? "10", 10);
    const sfx = parseInt(localStorage.getItem("chickenz-sfx-volume") ?? "80", 10);
    const musicMuted = localStorage.getItem("chickenz-music-muted") !== "false";
    scene.setBGMVolume(bgm / 100);
    scene.setSFXVolume(sfx / 100);
    scene.setMusicMuted(musicMuted);
  }

  function open() {
    settingsOpen = true;
    settingsOverlay.classList.add("visible");
    refreshKeyBindingUI();
    // Sync slider/checkbox values from localStorage
    const bgm = parseInt(localStorage.getItem("chickenz-bgm-volume") ?? "10", 10);
    const sfx = parseInt(localStorage.getItem("chickenz-sfx-volume") ?? "80", 10);
    sliderBGM.value = String(bgm);
    valBGM.textContent = String(bgm);
    sliderSFX.value = String(sfx);
    valSFX.textContent = String(sfx);
    checkDynamicZoom.checked = localStorage.getItem("chickenz-dynamic-zoom") !== "false";
    checkMusic.checked = localStorage.getItem("chickenz-music-muted") !== "true";
    settingsUsername.value = session.currentUsername;
    settingsUsernameError.textContent = "";
    updateCharUI();
  }

  function close() {
    settingsOpen = false;
    settingsOverlay.classList.remove("visible");
    // Cancel any active key listener
    if (listeningBtn) {
      listeningBtn.classList.remove("listening");
      listeningBtn = null;
      listeningAction = null;
    }
  }

  // ── Settings open/close listeners ─────────────────────────────────────────────

  settingsBtn.addEventListener("click", () => {
    if (settingsOpen) close();
    else open();
  });
  settingsClose.addEventListener("click", close);

  // Click outside settings card to close
  settingsOverlay.addEventListener("click", (e) => {
    if (e.target === settingsOverlay) close();
  });

  // ── Change Username ────────────────────────────────────────────────────────────

  function saveSettingsUsername() {
    const name = settingsUsername.value.trim();
    if (!name || name.length > 7) {
      settingsUsernameError.textContent = "Username must be 1-7 characters.";
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
      settingsUsernameError.textContent = "Letters, numbers, underscore only.";
      return;
    }
    settingsUsernameError.textContent = "";
    localStorage.setItem("chickenz-username", name);
    const nm = getNetworkManager();
    if (nm?.connected) {
      nm.sendSetUsername(name);
    }
    onSaveUsername(name);
    settingsUsernameError.style.color = "#66bb6a";
    settingsUsernameError.textContent = "Saved!";
    setTimeout(() => {
      settingsUsernameError.textContent = "";
      settingsUsernameError.style.color = "#ef5350";
    }, 1500);
  }

  btnSaveUsername.addEventListener("click", saveSettingsUsername);
  settingsUsername.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveSettingsUsername();
    e.stopPropagation(); // prevent game keybinds while typing
  });
  settingsUsername.addEventListener("keyup", (e) => e.stopPropagation());

  // ── Key Rebinding ─────────────────────────────────────────────────────────────

  document.querySelectorAll<HTMLButtonElement>(".key-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      // Cancel any previous listener
      if (listeningBtn) listeningBtn.classList.remove("listening");

      listeningBtn = btn;
      listeningAction = btn.dataset.action ?? null;
      listeningSlot = parseInt(btn.dataset.slot ?? "0", 10);
      btn.classList.add("listening");
      btn.textContent = "...";
    });
  });

  window.addEventListener(
    "keydown",
    (e) => {
      if (!listeningBtn || !listeningAction) return;
      e.preventDefault();
      e.stopPropagation();

      // Ignore modifier-only keys
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;

      const im = getInputManager();
      if (!im) return;

      const bindings = im.getBindings();
      const newCode = e.code;
      const actions: (keyof KeyBindings)[] = ["left", "right", "jump", "shoot", "taunt"];

      // Duplicate detection: if another slot already has this key, clear it
      for (const action of actions) {
        for (let s = 0; s < 2; s++) {
          if (bindings[action][s] === newCode) {
            // Don't clear the slot we're about to set
            if (action === listeningAction && s === listeningSlot) continue;
            bindings[action][s] = "";
          }
        }
      }

      bindings[listeningAction as keyof KeyBindings][listeningSlot] = newCode;
      im.setBindings(bindings);

      listeningBtn.classList.remove("listening");
      listeningBtn = null;
      listeningAction = null;
      refreshKeyBindingUI();
    },
    { capture: true },
  );

  // Capture mouse buttons during rebinding
  window.addEventListener(
    "mousedown",
    (e) => {
      if (!listeningBtn || !listeningAction) return;
      e.preventDefault();
      e.stopPropagation();

      const im = getInputManager();
      if (!im) return;

      const bindings = im.getBindings();
      const newCode = `Mouse${e.button}`;
      const actions: (keyof KeyBindings)[] = ["left", "right", "jump", "shoot", "taunt"];

      for (const action of actions) {
        for (let s = 0; s < 2; s++) {
          if (bindings[action][s] === newCode) {
            if (action === listeningAction && s === listeningSlot) continue;
            bindings[action][s] = "";
          }
        }
      }

      bindings[listeningAction as keyof KeyBindings][listeningSlot] = newCode;
      im.setBindings(bindings);

      listeningBtn.classList.remove("listening");
      listeningBtn = null;
      listeningAction = null;
      refreshKeyBindingUI();

      // Eat the follow-up click so it doesn't re-enter listen mode on the button
      window.addEventListener(
        "click",
        (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
        },
        { capture: true, once: true },
      );
    },
    { capture: true },
  );

  btnResetKeys.addEventListener("click", () => {
    const im = getInputManager();
    if (!im) return;
    im.resetBindings();
    refreshKeyBindingUI();
  });

  // ── Volume Sliders ────────────────────────────────────────────────────────────

  sliderBGM.addEventListener("input", () => {
    const val = parseInt(sliderBGM.value, 10);
    valBGM.textContent = String(val);
    localStorage.setItem("chickenz-bgm-volume", String(val));
    const scene = getGameScene();
    if (scene) scene.setBGMVolume(val / 100);
  });

  sliderSFX.addEventListener("input", () => {
    const val = parseInt(sliderSFX.value, 10);
    valSFX.textContent = String(val);
    localStorage.setItem("chickenz-sfx-volume", String(val));
    const scene = getGameScene();
    if (scene) scene.setSFXVolume(val / 100);
  });

  // ── Music Toggle ──────────────────────────────────────────────────────────────

  // Audio migration: old "chickenz-muted" → separate "chickenz-music-muted"
  {
    if (!localStorage.getItem("chickenz-audio-migrated")) {
      const oldMuted = localStorage.getItem("chickenz-muted");
      // If old key was explicitly "false" (user unmuted), keep music ON
      if (oldMuted === "false") {
        localStorage.setItem("chickenz-music-muted", "false");
      } else {
        // Default: music OFF for new users
        localStorage.setItem("chickenz-music-muted", "true");
      }
      localStorage.removeItem("chickenz-muted");
      localStorage.setItem("chickenz-audio-migrated", "1");
    }
  }

  checkMusic.addEventListener("change", () => setMusicMuted(!checkMusic.checked));
  muteBtn.addEventListener("click", () => {
    const currentlyMuted = localStorage.getItem("chickenz-music-muted") !== "false";
    setMusicMuted(!currentlyMuted);
    // If unmuting and BGM volume was 0, set a reasonable default
    if (currentlyMuted) {
      const bgm = parseInt(localStorage.getItem("chickenz-bgm-volume") ?? "10", 10);
      if (bgm === 0) {
        localStorage.setItem("chickenz-bgm-volume", "10");
        sliderBGM.value = "10";
        valBGM.textContent = "10";
        const scene = getGameScene();
        if (scene) scene.setBGMVolume(0.1);
      }
    }
    muteBtn.blur();
  });

  // Restore saved music state
  {
    const musicMuted = localStorage.getItem("chickenz-music-muted") !== "false";
    checkMusic.checked = !musicMuted;
    updateMusicIcon(musicMuted);
  }

  // ── Display Settings ──────────────────────────────────────────────────────────

  checkDynamicZoom.addEventListener("change", () => {
    localStorage.setItem("chickenz-dynamic-zoom", String(checkDynamicZoom.checked));
    const scene = getGameScene();
    if (scene) scene.setDynamicZoom(checkDynamicZoom.checked);
  });

  // ── Fullscreen ────────────────────────────────────────────────────────────────

  fullscreenBtn.addEventListener("click", () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen();
    }
    fullscreenBtn.blur();
  });

  document.addEventListener("fullscreenchange", () => {
    fullscreenBtn.textContent = document.fullscreenElement ? "\u2716" : "\u26F6";
    fullscreenBtn.title = document.fullscreenElement ? "Exit Fullscreen" : "Fullscreen";
  });

  // ── Character Preference Buttons ─────────────────────────────────────────────

  updateCharUI();

  function setHomeChar(idx: number) {
    session.homeCharacter = ((idx % NUM_CHARACTERS) + NUM_CHARACTERS) % NUM_CHARACTERS;
    if (session.homeCharacter === session.awayCharacter)
      session.awayCharacter = (session.homeCharacter + 1) % NUM_CHARACTERS;
    localStorage.setItem("chickenz-home-char", String(session.homeCharacter));
    localStorage.setItem("chickenz-away-char", String(session.awayCharacter));
    session.pendingCharacter = session.homeCharacter;
    updateCharUI();
  }

  function setAwayChar(idx: number) {
    session.awayCharacter = ((idx % NUM_CHARACTERS) + NUM_CHARACTERS) % NUM_CHARACTERS;
    if (session.awayCharacter === session.homeCharacter)
      session.awayCharacter = (session.awayCharacter + 1) % NUM_CHARACTERS;
    localStorage.setItem("chickenz-away-char", String(session.awayCharacter));
    updateCharUI();
  }

  document.getElementById("btn-home-prev")!.addEventListener("click", () => setHomeChar(session.homeCharacter - 1));
  document.getElementById("btn-home-next")!.addEventListener("click", () => setHomeChar(session.homeCharacter + 1));
  document.getElementById("btn-away-prev")!.addEventListener("click", () => setAwayChar(session.awayCharacter - 1));
  document.getElementById("btn-away-next")!.addEventListener("click", () => setAwayChar(session.awayCharacter + 1));

  return { open, close, applyAudioSettings, isOpen: () => settingsOpen };
}
