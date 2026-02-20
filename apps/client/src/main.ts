import Phaser from "phaser";
import { gameConfig, recalcDimensions } from "./game";
import { GameScene } from "./scenes/GameScene";
import { friendlyKeyName, type KeyBindings } from "./input/InputManager";

import { NetworkManager, type RoomInfo, type GameMode } from "./net/NetworkManager";

const NUM_CHARACTERS = 4;
/** Pick a random character index (0-3). */
function pickCharacter(): number {
  return Math.floor(Math.random() * NUM_CHARACTERS);
}
let pendingCharacter = 0; // character chosen for next match
import { initWalletKit, tryReconnectWallet, connectWallet, disconnectWallet, getConnectedAddress, settleMatch } from "./stellar";

interface MatchRecord {
  id: string;
  roomName: string;
  player1: string;
  player2: string;
  winner: number;
  scores: [number, number];
  timestamp: number;
  proofStatus: "none" | "pending" | "proving" | "verified" | "settled";
  roomId: string;
  mode?: GameMode;
}

// ── DOM elements ───────────────────────────────────────────────────────────────

// Top bar (read-only after gate)
const topBarAddress = document.getElementById("top-bar-address") as HTMLSpanElement;
const topBarUsername = document.getElementById("top-bar-username") as HTMLSpanElement;
const walletBtn = document.getElementById("btn-wallet") as HTMLButtonElement;

// Settings elements
const settingsBtn = document.getElementById("btn-settings") as HTMLButtonElement;
const settingsOverlay = document.getElementById("settings-overlay") as HTMLDivElement;
const settingsClose = document.getElementById("settings-close") as HTMLButtonElement;
const btnResetKeys = document.getElementById("btn-reset-keys") as HTMLButtonElement;
const sliderBGM = document.getElementById("slider-bgm") as HTMLInputElement;
const sliderSFX = document.getElementById("slider-sfx") as HTMLInputElement;
const valBGM = document.getElementById("val-bgm") as HTMLSpanElement;
const valSFX = document.getElementById("val-sfx") as HTMLSpanElement;
const checkDynamicZoom = document.getElementById("check-dynamic-zoom") as HTMLInputElement;
const checkMuteAll = document.getElementById("check-mute-all") as HTMLInputElement;
const settingsUsername = document.getElementById("settings-username") as HTMLInputElement;
const btnSaveUsername = document.getElementById("btn-save-username") as HTMLButtonElement;
const settingsUsernameError = document.getElementById("settings-username-error") as HTMLDivElement;
const muteBtn = document.getElementById("btn-mute") as HTMLButtonElement;
const fullscreenBtn = document.getElementById("btn-fullscreen") as HTMLButtonElement;

// Gate overlay elements
const gateOverlay = document.getElementById("gate-overlay") as HTMLDivElement;
const gateWalletSection = document.getElementById("gate-wallet-section") as HTMLDivElement;
const gateStep2 = document.getElementById("gate-step2") as HTMLDivElement;
const gateAddress = document.getElementById("gate-address") as HTMLDivElement;
const gateUsernameInput = document.getElementById("gate-username-input") as HTMLInputElement;
const gatePlayBtn = document.getElementById("gate-play-btn") as HTMLButtonElement;
const gateError = document.getElementById("gate-error") as HTMLDivElement;

// Lobby elements
const lobbyOverlay = document.getElementById("lobby-overlay") as HTMLDivElement;
const quickplayBtn = document.getElementById("btn-quickplay") as HTMLButtonElement;
const createPublicBtn = document.getElementById("btn-create-public") as HTMLButtonElement;
const createPrivateBtn = document.getElementById("btn-create-private") as HTMLButtonElement;
const joinCodeInput = document.getElementById("input-join-code") as HTMLInputElement;
const joinCodeBtn = document.getElementById("btn-join-code") as HTMLButtonElement;
const roomListEl = document.getElementById("room-list") as HTMLDivElement;
const lobbyStatus = document.getElementById("lobby-status") as HTMLDivElement;
const matchHistoryList = document.getElementById("match-history-list") as HTMLDivElement;
const leaderboardContent = document.getElementById("leaderboard-content") as HTMLDivElement;
const modeCasualBtn = document.getElementById("btn-mode-casual") as HTMLButtonElement;
const modeRankedBtn = document.getElementById("btn-mode-ranked") as HTMLButtonElement;

// ── Phaser ─────────────────────────────────────────────────────────────────────

const game = new Phaser.Game(gameConfig);

function getGameScene(): GameScene | null {
  return game.scene.getScene("GameScene") as GameScene | null;
}

// ── Resize handling ───────────────────────────────────────────────────────────
// Recalculate DPR/VIEW_W, resize the Phaser canvas, then reposition HUD/cameras.

let resizeTimer: ReturnType<typeof setTimeout> | null = null;
window.addEventListener("resize", () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const { canvasW, canvasH } = recalcDimensions();
    game.scale.resize(canvasW, canvasH);
    const scene = getGameScene();
    if (scene) scene.handleResize();
  }, 200);
});

// ── Session state ──────────────────────────────────────────────────────────────

let networkManager: NetworkManager | null = null;
let onlineRoomId: string | null = null;
let currentUsername = "";
let currentMode: GameMode = "casual";
let lastMatchMode: GameMode = "casual";
let proofPollTimer: ReturnType<typeof setInterval> | null = null;

// Auto-detect server: same host in production, localhost in dev
const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
const DEFAULT_SERVER = location.port === "5173" || location.port === "5174"
  ? "ws://localhost:3000/ws"
  : `${wsProto}//${location.host}/ws`;

// ── Gate: wallet required unless ?mode=casual ────────────────────────────────

const isCasual = new URLSearchParams(location.search).get("mode") === "casual";

// Auto-reconnect: if saved username exists, skip gate
{
  const savedName = localStorage.getItem("chickenz-username");
  if (savedName) {
    currentUsername = savedName;
    topBarUsername.textContent = savedName;
    gateOverlay.classList.add("hidden");
    connectToServer(DEFAULT_SERVER);
    // Deferred BGM start: Chrome blocks audio until first user interaction.
    // Wait for a click/keypress to satisfy autoplay policy, then start BGM.
    const startBGMOnce = () => {
      window.removeEventListener("click", startBGMOnce);
      window.removeEventListener("keydown", startBGMOnce);
      const scene = getGameScene();
      if (scene) {
        applyAudioSettings(scene);
        scene.startBGM();
      }
    };
    window.addEventListener("click", startBGMOnce, { once: false });
    window.addEventListener("keydown", startBGMOnce, { once: false });
  } else if (isCasual) {
    // Casual mode: skip wallet, show username input directly
    gateWalletSection.style.display = "none";
    gateStep2.classList.add("visible");
    gateUsernameInput.focus();
  } else {
    // Normal mode: show wallet connect button, step 2 hidden until connected
    const walletGateBtn = document.createElement("button");
    walletGateBtn.className = "btn btn-primary";
    walletGateBtn.textContent = "Connect Wallet";
    walletGateBtn.style.marginBottom = "12px";
    gateWalletSection.appendChild(walletGateBtn);

    walletGateBtn.addEventListener("click", async () => {
      try {
        await connectWallet();
        const addr = getConnectedAddress();
        if (addr) {
          gateAddress.textContent = addr;
          gateWalletSection.style.display = "none";
          gateStep2.classList.add("visible");
          gateUsernameInput.focus();
        }
      } catch {
        gateError.textContent = "Wallet connection failed. Try again.";
      }
    });

    // If already connected (e.g. page refresh), skip wallet step
    tryReconnectWallet().then(() => {
      const addr = getConnectedAddress();
      if (addr) {
        gateAddress.textContent = addr;
        gateWalletSection.style.display = "none";
        gateStep2.classList.add("visible");
        gateUsernameInput.focus();
      }
    }).catch(() => {});
  }
}

function submitGateUsername() {
  const name = gateUsernameInput.value.trim();
  if (!name || name.length > 7) {
    gateError.textContent = "Username must be 1-7 characters.";
    return;
  }
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    gateError.textContent = "Letters, numbers, underscore only.";
    return;
  }

  gateError.textContent = "";
  currentUsername = name;
  topBarUsername.textContent = name;
  localStorage.setItem("chickenz-username", name);

  // Hide gate, connect to server, open lobby
  gateOverlay.classList.add("hidden");
  connectToServer(DEFAULT_SERVER);

  // Start BGM — user just clicked (satisfies Chrome autoplay policy)
  const scene = getGameScene();
  if (scene) {
    applyAudioSettings(scene);
    scene.startBGM();
  }
}

// Pre-fill saved username
const savedUsername = localStorage.getItem("chickenz-username");
if (savedUsername) {
  gateUsernameInput.value = savedUsername;
}

gatePlayBtn.addEventListener("click", submitGateUsername);
gateUsernameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitGateUsername();
});

// ── Wallet Connect ──────────────────────────────────────────────────────────

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function updateWalletUI() {
  const addr = getConnectedAddress();
  if (addr) {
    topBarAddress.textContent = truncateAddress(addr);
    walletBtn.textContent = "Disconnect";
    walletBtn.classList.add("btn-warn");
    walletBtn.classList.remove("btn-primary");
    modeRankedBtn.classList.remove("locked");
    networkManager?.sendSetWallet(addr);
  } else {
    topBarAddress.textContent = "";
    walletBtn.textContent = "Connect Wallet";
    walletBtn.classList.remove("btn-warn");
    walletBtn.classList.add("btn-primary");
    if (currentMode === "ranked") {
      setMode("casual");
    }
    modeRankedBtn.classList.add("locked");
  }
}

walletBtn.addEventListener("click", async () => {
  if (getConnectedAddress()) {
    disconnectWallet();
  } else {
    await connectWallet();
  }
});

window.addEventListener("walletChanged", () => {
  updateWalletUI();
});

// Init kit and try silent reconnect
initWalletKit();
tryReconnectWallet().then(() => {
  updateWalletUI();
}).catch(() => {});

// ── Mode Toggle ───────────────────────────────────────────────────────────────

function setMode(mode: GameMode) {
  currentMode = mode;
  modeCasualBtn.classList.toggle("active", mode === "casual");
  modeRankedBtn.classList.toggle("active", mode === "ranked");
}

modeCasualBtn.addEventListener("click", () => {
  setMode("casual");
});

modeRankedBtn.addEventListener("click", () => {
  if (!getConnectedAddress()) {
    lobbyStatus.textContent = "Connect wallet to play ranked.";
    return;
  }
  setMode("ranked");
});

// ── Settings Panel ────────────────────────────────────────────────────────────

let settingsOpen = false;

// Build tiled border around settings card using terrain spritesheet
function buildSettingsFrame() {
  const frame = document.getElementById("settings-frame")!;
  const card = document.getElementById("settings-card")!;
  // Terrain spritesheet: 22 cols, 16x16 tiles
  const COLS = 22;
  const TILE = 16;
  // Frame indices: (col, row) → row * 22 + col
  const TOP_L = 4 * COLS + 12;   // (12,4)
  const TOP_M = 4 * COLS + 13;   // (13,4)
  const TOP_R = 4 * COLS + 14;   // (14,4)
  const SIDE_T = 4 * COLS + 15;  // (15,4)
  const SIDE_M = 5 * COLS + 15;  // (15,5)
  const SIDE_B = 6 * COLS + 15;  // (15,6)

  function makeTile(frameIdx: number, x: number, y: number): HTMLDivElement {
    const d = document.createElement("div");
    d.className = "frame-tile";
    const col = frameIdx % COLS;
    const row = Math.floor(frameIdx / COLS);
    d.style.backgroundPosition = `-${col * TILE}px -${row * TILE}px`;
    d.style.left = `${x}px`;
    d.style.top = `${y}px`;
    return d;
  }

  // Use ResizeObserver to rebuild tiles when card size changes
  const observer = new ResizeObserver(() => {
    // Remove old tiles
    frame.querySelectorAll(".frame-tile").forEach((t) => t.remove());

    const w = frame.offsetWidth;
    const h = frame.offsetHeight;

    // Top row: left cap at 0, right cap flush at w-TILE, fill middle
    frame.appendChild(makeTile(TOP_L, 0, 0));
    for (let x = TILE; x < w - TILE; x += TILE) {
      frame.appendChild(makeTile(TOP_M, x, 0));
    }
    frame.appendChild(makeTile(TOP_R, w - TILE, 0));

    // Bottom row: same layout at y = h - TILE
    frame.appendChild(makeTile(TOP_L, 0, h - TILE));
    for (let x = TILE; x < w - TILE; x += TILE) {
      frame.appendChild(makeTile(TOP_M, x, h - TILE));
    }
    frame.appendChild(makeTile(TOP_R, w - TILE, h - TILE));

    // Left column: between top and bottom rows
    frame.appendChild(makeTile(SIDE_T, 0, TILE));
    for (let y = 2 * TILE; y < h - 2 * TILE; y += TILE) {
      frame.appendChild(makeTile(SIDE_M, 0, y));
    }
    frame.appendChild(makeTile(SIDE_B, 0, h - 2 * TILE));

    // Right column: mirrored
    const addFlipped = (idx: number, x: number, y: number) => {
      const tile = makeTile(idx, x, y);
      tile.style.transform = "scaleX(-1)";
      frame.appendChild(tile);
    };
    addFlipped(SIDE_T, w - TILE, TILE);
    for (let y = 2 * TILE; y < h - 2 * TILE; y += TILE) {
      addFlipped(SIDE_M, w - TILE, y);
    }
    addFlipped(SIDE_B, w - TILE, h - 2 * TILE);
  });
  observer.observe(card);
}

buildSettingsFrame();

function openSettings() {
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
  settingsUsername.value = currentUsername;
  settingsUsernameError.textContent = "";
}

function closeSettings() {
  settingsOpen = false;
  settingsOverlay.classList.remove("visible");
  // Cancel any active key listener
  if (listeningBtn) {
    listeningBtn.classList.remove("listening");
    listeningBtn = null;
    listeningAction = null;
  }
}

settingsBtn.addEventListener("click", () => {
  if (settingsOpen) closeSettings();
  else openSettings();
});
settingsClose.addEventListener("click", closeSettings);

// Close settings on Escape
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && settingsOpen) {
    closeSettings();
    e.preventDefault();
  }
});

// ── Change Username (Settings) ────────────────────────────────────────────────

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
  currentUsername = name;
  topBarUsername.textContent = name;
  localStorage.setItem("chickenz-username", name);
  if (networkManager?.connected) {
    networkManager.sendSetUsername(name);
  }
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

let listeningBtn: HTMLButtonElement | null = null;
let listeningAction: string | null = null;
let listeningSlot: number = 0;

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
  updateControlsHint(bindings);
}

function updateControlsHint(bindings: KeyBindings) {
  const scene = getGameScene();
  if (scene) {
    const left = friendlyKeyName(bindings.left[0]);
    const right = friendlyKeyName(bindings.right[0]);
    const jump = friendlyKeyName(bindings.jump[0]);
    const shoot = friendlyKeyName(bindings.shoot[0]);
    const taunt = friendlyKeyName(bindings.taunt[0]);
    scene.setControlsHint(`${left}/${right} move  ${jump} jump  ${shoot} shoot  ${taunt} taunt`);
  }
}

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

window.addEventListener("keydown", (e) => {
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
}, { capture: true });

// Capture mouse buttons during rebinding
window.addEventListener("mousedown", (e) => {
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
  window.addEventListener("click", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
  }, { capture: true, once: true });
}, { capture: true });

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

// ── Mute All ─────────────────────────────────────────────────────────────────

const MUTE_ICON_ON = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.08"/>';
const MUTE_ICON_OFF = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>';

function updateMuteIcon(muted: boolean) {
  const svg = document.getElementById("mute-icon");
  if (svg) svg.innerHTML = muted ? MUTE_ICON_OFF : MUTE_ICON_ON;
  muteBtn.title = muted ? "Unmute" : "Mute";
}

function setMuteAll(muted: boolean) {
  localStorage.setItem("chickenz-muted", String(muted));
  checkMuteAll.checked = muted;
  updateMuteIcon(muted);
  const scene = getGameScene();
  if (scene) scene.setMuted(muted);
}

checkMuteAll.addEventListener("change", () => setMuteAll(checkMuteAll.checked));
muteBtn.addEventListener("click", () => {
  setMuteAll(!checkMuteAll.checked);
  muteBtn.blur();
});

// Restore saved mute state
{
  const savedMute = localStorage.getItem("chickenz-muted") === "true";
  checkMuteAll.checked = savedMute;
  updateMuteIcon(savedMute);
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
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen();
  }
  fullscreenBtn.blur();
});

document.addEventListener("fullscreenchange", () => {
  fullscreenBtn.textContent = document.fullscreenElement ? "\u2716" : "\u26F6";
  fullscreenBtn.title = document.fullscreenElement ? "Exit Fullscreen" : "Fullscreen";
});

/** Apply saved audio settings to the game scene. */
function applyAudioSettings(scene: GameScene) {
  const bgm = parseInt(localStorage.getItem("chickenz-bgm-volume") ?? "10", 10);
  const sfx = parseInt(localStorage.getItem("chickenz-sfx-volume") ?? "80", 10);
  const muted = localStorage.getItem("chickenz-muted") === "true";
  scene.setBGMVolume(bgm / 100);
  scene.setSFXVolume(sfx / 100);
  scene.setMuted(muted);
}

// Initialize controls hint after scene is ready
const hintTimer = setInterval(() => {
  const im = getInputManager();
  if (im) {
    clearInterval(hintTimer);
    updateControlsHint(im.getBindings());
  }
}, 200);
setTimeout(() => clearInterval(hintTimer), 5000);

// ── Lobby tabs ────────────────────────────────────────────────────────────────

let activeTab = "rooms";

document.querySelectorAll(".lobby-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const tabName = (tab as HTMLElement).dataset.tab!;
    switchTab(tabName);
  });
});

function switchTab(tabName: string) {
  activeTab = tabName;
  document.querySelectorAll(".lobby-tab").forEach((t) => {
    t.classList.remove("active");
    t.setAttribute("aria-selected", "false");
  });
  document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("visible"));
  const activeTabEl = document.querySelector(`.lobby-tab[data-tab="${tabName}"]`);
  activeTabEl?.classList.add("active");
  activeTabEl?.setAttribute("aria-selected", "true");
  document.getElementById(`tab-${tabName}`)?.classList.add("visible");

  if (tabName === "leaderboard") fetchLeaderboard();
  if (tabName === "history") fetchMatchHistory();
}

// ── Lobby UI ───────────────────────────────────────────────────────────────────

function openLobby() {
  lobbyOverlay.classList.add("visible");
  lobbyStatus.textContent = "";
  joinCodeInput.value = "";
  setLobbyButtons(true);

  if (networkManager?.connected) {
    networkManager.sendListRooms();
  }

  if (activeTab === "leaderboard") fetchLeaderboard();
  if (activeTab === "history") fetchMatchHistory();
}

function closeLobby() {
  lobbyOverlay.classList.remove("visible");
}

function setLobbyButtons(enabled: boolean) {
  quickplayBtn.disabled = !enabled;
  createPublicBtn.disabled = !enabled;
  createPrivateBtn.disabled = !enabled;
  joinCodeBtn.disabled = !enabled;
}

function renderRoomList(rooms: RoomInfo[]) {
  roomListEl.innerHTML = "";

  const joinable = rooms.filter((r) => r.status === "waiting");
  const playing = rooms.filter((r) => r.status === "playing");

  if (joinable.length === 0 && playing.length === 0) {
    roomListEl.innerHTML = `<div id="lobby-empty">No public rooms yet. Create one or hit Quick Play!</div>`;
    return;
  }

  for (const room of joinable) {
    roomListEl.appendChild(createRoomElement(room));
  }
  for (const room of playing) {
    roomListEl.appendChild(createRoomElement(room));
  }
}

function createRoomElement(room: RoomInfo): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "room-item";
  const modeBadge = room.mode === "ranked"
    ? `<span class="mode-badge ranked">Ranked</span>`
    : `<span class="mode-badge casual">Casual</span>`;
  el.innerHTML = `
    <span>
      <span class="room-name">${escapeHtml(room.name)}</span>
      ${modeBadge}
      <span class="room-code">${room.joinCode}</span>
    </span>
    <div class="room-info">
      <span class="room-status ${room.status}">${room.status === "waiting" ? "Waiting (1/2)" : "In Progress (2/2)"}</span>
      ${room.status === "waiting" ? `<button class="btn btn-primary btn-join" data-room-id="${room.id}">Join</button>` : ""}
    </div>
  `;

  const joinBtn = el.querySelector(".btn-join");
  if (joinBtn) {
    joinBtn.addEventListener("click", () => {
      if (!networkManager?.connected) return;
    
      pendingCharacter = pickCharacter();
      networkManager.sendJoinRoom(room.id, pendingCharacter);
      lobbyStatus.textContent = "Joining...";
      setLobbyButtons(false);
    });
  }

  return el;
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ── Leaderboard ──────────────────────────────────────────────────────────────

function fetchLeaderboard() {
  if (!networkManager) return;
  const origin = networkManager.httpOrigin;
  fetch(`${origin}/api/leaderboard`)
    .then((r) => r.json())
    .then((data: { name: string; elo: number; wins: number; losses: number }[]) => {
      renderLeaderboard(data);
    })
    .catch(() => {
      leaderboardContent.innerHTML = `<div class="empty-state">Failed to load leaderboard</div>`;
    });
}

function renderLeaderboard(data: { name: string; elo: number; wins: number; losses: number }[]) {
  if (data.length === 0) {
    leaderboardContent.innerHTML = `<div class="empty-state">No ranked players yet</div>`;
    return;
  }
  let html = `<table><tr><th>#</th><th>Name</th><th>ELO</th><th>W</th><th>L</th></tr>`;
  data.forEach((entry, i) => {
    const highlight = entry.name === currentUsername ? ' class="highlight"' : "";
    html += `<tr${highlight}><td>${i + 1}</td><td>${escapeHtml(entry.name)}</td><td>${entry.elo}</td><td>${entry.wins}</td><td>${entry.losses}</td></tr>`;
  });
  html += `</table>`;
  leaderboardContent.innerHTML = html;
}

// ── Match History ──────────────────────────────────────────────────────────────

function fetchMatchHistory() {
  if (!networkManager) return;
  const origin = networkManager.httpOrigin;
  fetch(`${origin}/api/matches`)
    .then((r) => r.json())
    .then((data: MatchRecord[]) => {
      renderMatchHistory(data);
    })
    .catch(() => {
      matchHistoryList.innerHTML = `<div class="empty-state">Failed to load match history</div>`;
    });
}

function proofStatusLabel(status: string): string {
  switch (status) {
    case "none":
      return "Casual";
    case "pending":
    case "proving":
      return "Generating Proof";
    case "verified":
      return "Proof Verified";
    case "settled":
      return "Settled";
    default:
      return status;
  }
}

function renderMatchHistory(matches: MatchRecord[]) {
  if (matches.length === 0) {
    matchHistoryList.innerHTML = `<div class="empty-state">No matches played yet</div>`;
    return;
  }
  matchHistoryList.innerHTML = "";
  for (const m of matches) {
    const el = document.createElement("div");
    el.className = "match-item";
    const ago = formatTimeAgo(m.timestamp);
    const modeBadge = m.mode === "ranked"
      ? `<span class="mode-badge ranked">Ranked</span>`
      : `<span class="mode-badge casual">Casual</span>`;
    const showSettle = m.mode === "ranked" && m.proofStatus === "verified" && getConnectedAddress();
    el.innerHTML = `
      <div>
        <span class="match-players">${escapeHtml(m.player1)} vs ${escapeHtml(m.player2)}</span>
        <span class="match-score">${m.scores[0]}-${m.scores[1]}</span>
        ${modeBadge}
      </div>
      <div class="match-item-meta">
        <span class="match-time">${ago}</span>
        <span class="proof-badge ${m.proofStatus}">${escapeHtml(proofStatusLabel(m.proofStatus))}</span>
        ${showSettle ? `<button class="btn btn-sm btn-primary btn-settle" data-match-id="${m.id}">Settle</button>` : ""}
        <button class="btn btn-sm btn-replay" data-room-id="${m.roomId}">Replay</button>
        <button class="btn btn-sm btn-download" data-room-id="${m.roomId}">DL</button>
      </div>
    `;
    const replayBtn = el.querySelector(".btn-replay");
    if (replayBtn) {
      replayBtn.addEventListener("click", () => {
        startReplay(m.roomId);
      });
    }
    const downloadBtn = el.querySelector(".btn-download");
    if (downloadBtn) {
      downloadBtn.addEventListener("click", () => {
        downloadTranscript(m.roomId);
      });
    }
    const settleBtn = el.querySelector(".btn-settle");
    if (settleBtn) {
      settleBtn.addEventListener("click", () => {
        handleSettleMatch(m.id);
      });
    }
    matchHistoryList.appendChild(el);
  }
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface TranscriptInput {
  buttons: number;
  aimX?: number;
  aimY?: number;
  aim_x?: number;
  aim_y?: number;
}

interface TranscriptResponse {
  transcript: [TranscriptInput, TranscriptInput][];
  config: { seed: number };
}

function startReplay(roomId: string) {
  if (!networkManager) return;
  const origin = networkManager.httpOrigin;
  fetch(`${origin}/transcript/${roomId}`)
    .then((r) => r.json())
    .then((data: TranscriptResponse) => {
      closeLobby();
      const scene = getGameScene();
      if (scene) {
        scene.startReplay(data.transcript, data.config.seed);
      }
    })
    .catch(() => {
      lobbyStatus.textContent = "Failed to load transcript for replay.";
    });
}

function downloadTranscript(roomId: string) {
  if (!networkManager) return;
  const origin = networkManager.httpOrigin;
  fetch(`${origin}/transcript/${roomId}`)
    .then((r) => r.json())
    .then((data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `chickenz-${roomId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    })
    .catch(() => {
      lobbyStatus.textContent = "Failed to download transcript.";
    });
}

// ── Network ────────────────────────────────────────────────────────────────────

function connectToServer(url: string) {
  if (networkManager) {
    networkManager.disconnect();
  }

  lobbyStatus.textContent = "Connecting...";

  networkManager = new NetworkManager({
    onLobby(rooms) {
      renderRoomList(rooms);
    },

    onWaiting(roomId, roomName, joinCode) {
      const scene = getGameScene();
      if (scene) {
        scene.startWarmup(joinCode, currentUsername, () => {
          closeLobby();
          applyAudioSettings(scene);
        }, pendingCharacter);
      }
    },

    onMatched(playerId, seed, roomId, usernames, mapIndex, totalRounds, mode, characters) {
      onlineRoomId = roomId;
      lastMatchMode = mode;

      const scene = getGameScene();
      if (!scene) return;

      if (!scene.isWarmup) {
        closeLobby();
      }

      networkManager?.resetThrottle();
      scene.startOnlineMatch(playerId, seed, usernames, mapIndex, totalRounds, characters);
      applyAudioSettings(scene);
      scene.onLocalInput = (input, tick) => {
        networkManager?.sendInput(input, tick);
      };
    },

    onState(state, lastButtons) {
      const scene = getGameScene();
      if (scene) scene.receiveState(state, lastButtons);
    },

    onRoundEnd(round, winner, roundWins) {
      const scene = getGameScene();
      if (scene) scene.handleRoundEnd(round, winner, roundWins);
    },

    onRoundStart(round, seed, mapIndex) {
      networkManager?.resetThrottle();
      const scene = getGameScene();
      if (scene) scene.startNewRound(seed, mapIndex, round);
    },

    onEnded(winner, scores, roundWins, roomId, mode) {
      onlineRoomId = roomId;
      lastMatchMode = mode;
      const scene = getGameScene();
      if (scene) scene.endOnlineMatch(winner);

      // Re-open lobby so they can play again
      setTimeout(() => openLobby(), 2000);
    },

    onError(message) {
      lobbyStatus.textContent = `Error: ${message}`;
      setLobbyButtons(true);
    },

    onDisconnect() {
      lobbyStatus.textContent = "Disconnected from server.";
      setLobbyButtons(true);
      networkManager = null;
    },
  });

  networkManager.connect(url);

  // Once connected, set username and open lobby
  const waitForConnect = setInterval(() => {
    if (networkManager?.connected) {
      clearInterval(waitForConnect);
      if (currentUsername) {
        networkManager.sendSetUsername(currentUsername);
      }
      const walletAddr = getConnectedAddress();
      if (walletAddr) {
        networkManager.sendSetWallet(walletAddr);
      }
      openLobby();
    }
  }, 100);

  // Safety timeout: stop polling after 10s
  setTimeout(() => clearInterval(waitForConnect), 10000);
}

// ── Button handlers ────────────────────────────────────────────────────────────

quickplayBtn.addEventListener("click", () => {
  if (!networkManager?.connected) return;
  pendingCharacter = pickCharacter();
  networkManager.sendQuickplay(currentMode, pendingCharacter);
  lobbyStatus.textContent = `Finding a ${currentMode} match...`;
  setLobbyButtons(false);
});

createPublicBtn.addEventListener("click", () => {
  if (!networkManager?.connected) return;
  pendingCharacter = pickCharacter();
  networkManager.sendCreate(false, currentMode, pendingCharacter);
  lobbyStatus.textContent = `Creating ${currentMode} public match...`;
  setLobbyButtons(false);
});

createPrivateBtn.addEventListener("click", () => {
  if (!networkManager?.connected) return;
  pendingCharacter = pickCharacter();
  networkManager.sendCreate(true, currentMode, pendingCharacter);
  lobbyStatus.textContent = `Creating ${currentMode} private match...`;
  setLobbyButtons(false);
});

joinCodeBtn.addEventListener("click", () => {
  if (!networkManager?.connected) return;

  const code = joinCodeInput.value.trim().toUpperCase();
  if (code.length !== 5) {
    lobbyStatus.textContent = "Join code must be 5 letters.";
    return;
  }
  pendingCharacter = pickCharacter();
  networkManager.sendJoinByCode(code, pendingCharacter);
  lobbyStatus.textContent = `Joining with code ${code}...`;
  setLobbyButtons(false);
});

joinCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    joinCodeBtn.click();
  }
});

// ── Settlement Flow (Ranked) ─────────────────────────────────────────────────

function startProofPolling(matchId: string) {
  if (proofPollTimer) clearInterval(proofPollTimer);
  if (!networkManager) return;
  const origin = networkManager.httpOrigin;

  proofPollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${origin}/api/matches/${matchId}/status`);
      const data = await res.json();
      if (data.proofStatus === "verified" || data.proofStatus === "settled") {
        if (proofPollTimer) clearInterval(proofPollTimer);
        proofPollTimer = null;
        // Refresh match history to show updated status
        if (activeTab === "history") fetchMatchHistory();
      }
    } catch {
      // Network error, keep polling
    }
  }, 10000);

  // Stop polling after 45 minutes
  setTimeout(() => {
    if (proofPollTimer) {
      clearInterval(proofPollTimer);
      proofPollTimer = null;
    }
  }, 45 * 60 * 1000);
}

async function handleSettleMatch(matchId: string) {
  if (!networkManager) return;
  const origin = networkManager.httpOrigin;
  const addr = getConnectedAddress();
  if (!addr) {
    lobbyStatus.textContent = "Connect wallet to settle on-chain.";
    return;
  }

  try {
    lobbyStatus.textContent = "Fetching proof...";
    const proofRes = await fetch(`${origin}/api/matches/${matchId}/proof`);
    if (!proofRes.ok) {
      lobbyStatus.textContent = "Proof not available yet.";
      return;
    }
    const proof = await proofRes.json();

    lobbyStatus.textContent = "Signing settlement transaction...";
    const numericId = parseInt(matchId.replace("match-", ""), 10);
    const seal = new Uint8Array(Buffer.from(proof.seal, "hex"));
    const journal = new Uint8Array(Buffer.from(proof.journal, "hex"));

    await settleMatch(numericId, seal, journal);

    // Notify server
    await fetch(`${origin}/api/matches/${matchId}/settle`, { method: "POST" });
    lobbyStatus.textContent = "Match settled on-chain!";
    if (activeTab === "history") fetchMatchHistory();
  } catch (err) {
    lobbyStatus.textContent = `Settlement failed: ${(err as Error).message}`;
  }
}

// ── Replay exit handler ──────────────────────────────────────────────────────

window.addEventListener("replayEnded", () => {
  openLobby();
});
