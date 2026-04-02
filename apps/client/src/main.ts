import Phaser from "phaser";
import { gameConfig, recalcDimensions } from "./game";
import { GameScene } from "./scenes/GameScene";
import { friendlyKeyName, type KeyBindings } from "./input/InputManager";
import { TouchControls } from "./input/TouchControls";
import { Tutorial } from "./tutorial/Tutorial";
import { initChickenzWasm } from "./wasm";

import {
  NetworkManager,
  type RoomInfo,
  type GameMode,
  type TournamentBracket,
  type BracketMatch,
  type TournamentLobbyMessage,
} from "./net/NetworkManager";
import { RegionManager, type RegionPing, type RegionRoomInfo } from "./net/RegionManager";
import { getRegions, type RegionConfig } from "./net/regions";
import type { MatchRecord } from "./types";
import {
  escapeHtml,
  truncateAddress,
  formatTimeAgo,
  proofStatusLabel,
} from "./ui/format";
import { renderMatchDetail } from "./ui/MatchDetailView";

const NUM_CHARACTERS = 4;
const CHARACTER_NAMES = ["NINJA FROG", "MASK DUDE", "PINK MAN", "VIRTUAL GUY"];

// ── Character preferences (home/away) ────────────────────────────────────────
let homeCharacter = parseInt(localStorage.getItem("chickenz-home-char") ?? "0", 10);
let awayCharacter = parseInt(localStorage.getItem("chickenz-away-char") ?? "1", 10);
if (!Number.isFinite(homeCharacter) || homeCharacter < 0 || homeCharacter >= NUM_CHARACTERS) homeCharacter = 0;
if (!Number.isFinite(awayCharacter) || awayCharacter < 0 || awayCharacter >= NUM_CHARACTERS) awayCharacter = 1;
if (awayCharacter === homeCharacter) awayCharacter = (homeCharacter + 1) % NUM_CHARACTERS;
let pendingCharacter = homeCharacter; // character chosen for next match
import {
  initPasskeyKit,
  connectWallet,
  createWallet,
  promptConnect,
  disconnectWallet,
  getConnectedAddress,
  getLastAuthProof,
  settleMatch,
} from "./stellar";

// Wallet verification state

// ── Touch detection ──────────────────────────────────────────────────────────
const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;
if (isTouchDevice) document.body.classList.add("touch");

const touchControls = new TouchControls();
const tutorial = new Tutorial();

// ── DOM elements ───────────────────────────────────────────────────────────────

// Top bar (read-only after gate)
const topBarAddress = document.getElementById("top-bar-address") as HTMLSpanElement;
const topBarUsername = document.getElementById("top-bar-username") as HTMLSpanElement;
const walletLoginBtn = document.getElementById("btn-wallet-login") as HTMLButtonElement;
const walletRegisterBtn = document.getElementById("btn-wallet-register") as HTMLButtonElement;

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
const checkMusic = document.getElementById("check-music") as HTMLInputElement;
const settingsUsername = document.getElementById("settings-username") as HTMLInputElement;
const btnSaveUsername = document.getElementById("btn-save-username") as HTMLButtonElement;
const settingsUsernameError = document.getElementById("settings-username-error") as HTMLDivElement;
const muteBtn = document.getElementById("btn-mute") as HTMLButtonElement;
const fullscreenBtn = document.getElementById("btn-fullscreen") as HTMLButtonElement;

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
const moreMenuBtn = document.getElementById("btn-more-menu") as HTMLButtonElement;
const moreMenuDropdown = document.getElementById("more-menu-dropdown") as HTMLDivElement;
const menuTournament = document.getElementById("menu-tournament") as HTMLDivElement;
const menuTutorial = document.getElementById("menu-tutorial") as HTMLDivElement;

// Tournament DOM elements
const tournamentOverlay = document.getElementById("tournament-overlay") as HTMLDivElement;
const tournamentCode = document.getElementById("tournament-code") as HTMLDivElement;
const tournamentPlayers = document.getElementById("tournament-players") as HTMLDivElement;
const tournamentStatus = document.getElementById("tournament-status") as HTMLDivElement;
const bracketOverlay = document.getElementById("bracket-overlay") as HTMLDivElement;
const bracketGrid = document.getElementById("bracket-grid") as HTMLDivElement;
const spectateOverlay = document.getElementById("spectate-overlay") as HTMLDivElement;
const spectateLabel = document.getElementById("spectate-label") as HTMLSpanElement;
const tournamentResults = document.getElementById("tournament-results") as HTMLDivElement;
const standingsList = document.getElementById("standings-list") as HTMLDivElement;
let currentTournamentSlot = -1; // our slot in the tournament
let _currentTournamentHostSlot = -1;

// Match detail overlay
const matchDetailOverlay = document.getElementById("match-detail-overlay") as HTMLDivElement;
const matchDetailBody = document.getElementById("match-detail-body") as HTMLDivElement;
const matchDetailClose = document.getElementById("match-detail-close") as HTMLButtonElement;

matchDetailClose.addEventListener("click", () => {
  matchDetailOverlay.classList.remove("visible");
});

// ── WASM init ─────────────────────────────────────────────────────────────────
await initChickenzWasm();

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
let currentUsername = "";
let currentMode: GameMode = "casual";
let currentTournamentId: string | null = null;
let tournamentSpectating = false;
let inTutorialFlow = false; // true while new user is in tutorial + username prompt

// ── Queued actions (executed once connected) ──────────────────────────────────
let pendingQuickplay = false; // true if user clicked Quick Play before connected

// ── Region Manager ────────────────────────────────────────────────────────────

const regionManager = new RegionManager(getRegions(), {
  onRoomsChanged: (rooms) => renderMergedRoomList(rooms),
  onPingsUpdated: (pings) => updateRegionUI(pings),
});

// Track which region the active game connection is to
let activeRegionId = "";

// Region selector DOM elements
const regionBtn = document.getElementById("btn-region") as HTMLButtonElement;
const regionFlag = document.getElementById("region-flag") as HTMLSpanElement;
const regionName = document.getElementById("region-name") as HTMLSpanElement;
const regionPing = document.getElementById("region-ping") as HTMLSpanElement;
const regionDropdown = document.getElementById("region-dropdown") as HTMLDivElement;

function formatPing(ms: number): string {
  if (ms === Infinity) return "---";
  return `${Math.round(ms)}ms`;
}

function pingClass(ms: number): string {
  if (ms === Infinity) return "unreachable";
  if (ms > 160) return "high";
  return "";
}

function updateRegionUI(pings: RegionPing[]) {
  const homeId = regionManager.homeRegionId;
  const home = pings.find((p) => p.region.id === homeId);
  if (home) {
    regionFlag.textContent = home.region.flag;
    regionName.textContent = home.region.name;
    regionPing.textContent = formatPing(home.pingMs);
    regionPing.className = `region-ping ${pingClass(home.pingMs)}`;
  }

  // Rebuild dropdown
  regionDropdown.innerHTML = "";
  for (const { region, pingMs } of pings) {
    const opt = document.createElement("div");
    opt.className = "region-option";
    if (region.id === homeId) opt.classList.add("active");
    if (pingMs > 160 && pingMs !== Infinity) opt.classList.add("dimmed");
    const pingCls = pingClass(pingMs);
    const homeTag = region.id === homeId ? `<span class="ro-home">HOME</span>` : "";
    opt.innerHTML = `
      <span class="ro-left">
        <span class="ro-flag">${region.flag}</span>
        <span class="ro-name">${region.name}</span>
        ${homeTag}
      </span>
      <span class="ro-ping region-ping ${pingCls}">${formatPing(pingMs)}</span>
    `;
    opt.addEventListener("click", () => {
      regionManager.homeRegionId = region.id;
      regionDropdown.classList.remove("visible");
      // Switch active connection to new home region
      void switchToRegion(region);
      // Re-measure and update UI
      void regionManager.measurePings();
    });
    regionDropdown.appendChild(opt);
  }
}

regionBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  regionDropdown.classList.toggle("visible");
});

// Close dropdowns on outside click
document.addEventListener("click", () => {
  regionDropdown.classList.remove("visible");
  moreMenuDropdown.classList.remove("visible");
});
regionDropdown.addEventListener("click", (e) => e.stopPropagation());

function switchToRegion(region: RegionConfig): Promise<void> {
  if (activeRegionId === region.id && networkManager?.connected) return Promise.resolve();
  activeRegionId = region.id;
  regionManager.activeRegionId = region.id;
  // Invalidate verification state — different server means new challenge
  lastVerifiedAddr = null;
  // Update region UI immediately
  regionFlag.textContent = region.flag;
  regionName.textContent = region.name;
  const ping = regionManager.getPing(region.id);
  regionPing.textContent = formatPing(ping);
  regionPing.className = `region-ping ${pingClass(ping)}`;
  // Reconnect lobby streams so the new active region is excluded from duplicate WS
  regionManager.connectLobbyStreams();
  return connectToServer(region.wsUrl);
}

// ── Queued action flush ──────────────────────────────────────────────────────

/** Execute any actions the user attempted before the server connection was ready. */
function flushPendingActions() {
  if (pendingQuickplay && networkManager?.connected) {
    pendingQuickplay = false;
    pendingCharacter = homeCharacter;
    networkManager.sendQuickplay(currentMode, pendingCharacter, awayCharacter);
    lobbyStatus.textContent = "";
    setLobbyButtons(false);
  }
}

// ── Animal name generator ────────────────────────────────────────────────────

const ANIMALS = [
  "Moose",
  "Fox",
  "Cat",
  "Dog",
  "Lion",
  "Monkey",
  "Zebra",
  "Bear",
  "Wolf",
  "Eagle",
  "Hawk",
  "Otter",
  "Panda",
  "Koala",
  "Raven",
  "Shark",
  "Whale",
  "Tiger",
  "Cobra",
  "Viper",
  "Gecko",
  "Lemur",
  "Bison",
  "Crane",
  "Heron",
  "Finch",
  "Robin",
  "Llama",
  "Goose",
  "Duck",
  "Deer",
  "Frog",
  "Toad",
  "Crab",
  "Crow",
  "Dove",
  "Lynx",
  "Mole",
  "Moth",
  "Wasp",
  "Wren",
  "Swan",
  "Yak",
  "Newt",
  "Puma",
  "Seal",
  "Slug",
  "Mink",
];

function generateAnimalName(): string {
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]!;
  const maxDigits = 7 - animal.length;
  const num = Math.floor(Math.random() * Math.pow(10, maxDigits));
  return `${animal}${num}`;
}

function getOrCreateUsername(): string {
  const saved = localStorage.getItem("chickenz-username");
  if (saved) return saved;
  // New users get no name — they'll pick one after the tutorial.
  // Returning users who lost their username (cleared storage) get a random one.
  if (!Tutorial.shouldShow()) {
    const name = generateAnimalName();
    localStorage.setItem("chickenz-username", name);
    return name;
  }
  return "";
}

function saveUsername(name: string) {
  localStorage.setItem("chickenz-username", name);
  currentUsername = name;
  topBarUsername.textContent = name;
}

// ── Gate flow: instant play, wallet optional ────────────────────────────────

function deferBGMStart() {
  let started = false;
  const startBGMOnce = () => {
    if (started) return;
    started = true;
    window.removeEventListener("click", startBGMOnce);
    window.removeEventListener("keydown", startBGMOnce);
    const scene = getGameScene();
    if (scene) {
      applyAudioSettings(scene);
      scene.startBGM();
    }
  };
  window.addEventListener("click", startBGMOnce);
  window.addEventListener("keydown", startBGMOnce);
}

// Init gate — returning users go straight to lobby, new users get tutorial first
{
  const name = getOrCreateUsername();
  currentUsername = name;
  topBarUsername.textContent = name;

  // Init regions: connect to cached region instantly, measure pings in background
  // Check for join URL param BEFORE first await (URL gets cleared later by deep link code)
  const hasJoinParam = new URLSearchParams(window.location.search).has("join");

  void (async () => {
    // 1. Try cached home region for instant connect
    const cached = regionManager.getCachedHomeRegion();
    if (cached) {
      activeRegionId = cached.id;
      regionManager.activeRegionId = cached.id;
      await connectToServer(cached.wsUrl);
      flushPendingActions();
    }

    // 2. Measure pings in background (all regions in parallel)
    await regionManager.measurePings();

    // 3. If best region differs from cached (or no cache), switch —
    //    UNLESS a ?join= URL param is present (the deep link handler will
    //    switch to the correct region; switching here would kill the game connection)
    if (!hasJoinParam) {
      const bestRegion = regionManager.getBestRegion();
      if (bestRegion.id !== activeRegionId) {
        activeRegionId = bestRegion.id;
        regionManager.activeRegionId = bestRegion.id;
        await connectToServer(bestRegion.wsUrl);
        if (!cached) flushPendingActions();
      }
    }

    regionManager.connectLobbyStreams();
    regionManager.startPingRefresh();
  })();

  deferBGMStart();

  // Optimistic wallet UI from localStorage (avoids flash of Log In / Register)
  const cachedAddr = localStorage.getItem("chickenz-wallet-address");
  if (cachedAddr) {
    topBarAddress.textContent = truncateAddress(cachedAddr);
    walletLoginBtn.textContent = "Disconnect";
    walletLoginBtn.classList.add("btn-warn");
    walletLoginBtn.classList.remove("btn-primary");
    walletLoginBtn.style.display = "";
  }

  // Init passkey kit and try silent SDK session restore (non-disruptive).
  // Always call updateWalletUI at the end so Log In / Register buttons become visible.
  initPasskeyKit()
    .then(() => connectWallet())
    .catch((err) => console.warn("[wallet]", err))
    .finally(() => updateWalletUI());

  // Init touch controls + tutorial
  if (isTouchDevice) touchControls.init();
  tutorial.init(isTouchDevice);

  // New users: show tutorial prompt
  if (Tutorial.shouldShow()) {
    inTutorialFlow = true;
    const tutorialOverlay = document.getElementById("tutorial-overlay")!;
    const tutorialPrompt = document.getElementById("tutorial-prompt")!;
    tutorialOverlay.style.display = "block";
    tutorialPrompt.style.display = "flex";

    const launchTutorial = () => {
      tutorialPrompt.style.display = "none";
      closeLobby();
      const startWhenReady = () => {
        const scene = getGameScene();
        if (!scene) {
          requestAnimationFrame(startWhenReady);
          return;
        }
        scene.startTutorial(
          tutorial,
          () => {
            showUsernamePrompt();
          },
          pendingCharacter,
        );
        applyAudioSettings(scene);
        if (isTouchDevice) touchControls.show();
        tutorial.start(() => {
          scene.stopTutorial();
        });
      };
      requestAnimationFrame(startWhenReady);
    };

    document.getElementById("btn-tutorial-play")?.addEventListener("click", launchTutorial);

    document.getElementById("btn-tutorial-skip")?.addEventListener("click", () => {
      Tutorial.markDone();
      tutorialOverlay.style.display = "none";
      tutorialPrompt.style.display = "none";
      inTutorialFlow = false;
      showUsernamePrompt();
    });
  }
}

// ── Username prompt (shown after tutorial for new users) ─────────────────────

function showUsernamePrompt() {
  const overlay = document.getElementById("tutorial-overlay")!;
  const prompt = document.getElementById("username-prompt")!;
  const input = document.getElementById("username-prompt-input") as HTMLInputElement;
  const error = document.getElementById("username-prompt-error")!;
  const confirmBtn = document.getElementById("btn-username-confirm") as HTMLButtonElement;

  inTutorialFlow = true;
  overlay.style.display = "block";
  prompt.style.display = "flex";
  input.value = "";
  error.textContent = "";
  input.focus();

  const validate = (val: string): string | null => {
    if (val.length === 0) return "Username is required";
    if (val.length > 7) return "Max 7 characters";
    if (!/^[a-zA-Z0-9_]+$/.test(val)) return "Letters, numbers, underscore only";
    return null;
  };

  const submit = () => {
    const val = input.value.trim();
    const err = validate(val);
    if (err) {
      error.textContent = err;
      return;
    }
    saveUsername(val);
    prompt.style.display = "none";
    overlay.style.display = "none";
    inTutorialFlow = false;
    if (networkManager?.connected) {
      networkManager.sendSetUsername(val);
    }
    openLobby();
  };

  confirmBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

// Wallet disconnect just updates UI — user keeps playing as casual

// ── Wallet Connect ──────────────────────────────────────────────────────────

let verifyInProgress: string | null = null; // prevent duplicate verify popups
let lastVerifiedAddr: string | null = null;

/** Get the per-region wallet token storage key. */
function walletTokenKey(): string {
  return `chickenz-wallet-token-${activeRegionId || "default"}`;
}

/** Try to revalidate using a stored token (no passkey prompt). */
async function tryStoredToken(addr: string): Promise<boolean> {
  if (!networkManager) return false;
  try {
    const raw = localStorage.getItem(walletTokenKey());
    if (!raw) return false;
    const stored = JSON.parse(raw) as { address: string; token: string };
    if (stored.address !== addr || !stored.token) return false;
    const res = await fetch(`${networkManager.httpOrigin}/api/wallet/revalidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: addr, token: stored.token }),
    });
    const { verified } = await res.json();
    if (verified) {
      lastVerifiedAddr = addr;
      return true;
    }
    // Token rejected — clear stale entry
    localStorage.removeItem(walletTokenKey());
    return false;
  } catch {
    return false;
  }
}

/** Register wallet with server — sends passkey proof for cryptographic verification. */
async function verifyWallet(addr: string): Promise<boolean> {
  if (!networkManager) return false;
  if (lastVerifiedAddr === addr) return true;
  if (await tryStoredToken(addr)) return true;
  if (verifyInProgress === addr) return false;
  verifyInProgress = addr;
  const origin = networkManager.httpOrigin;
  try {
    const proof = getLastAuthProof();
    if (!proof || proof.address !== addr) {
      console.warn("[wallet] No auth proof available for", addr);
      return false;
    }
    const res = await fetch(`${origin}/api/wallet/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: addr,
        credentialId: proof.credentialId,
        ...(proof.publicKey ? { publicKey: proof.publicKey } : {}),
        ...(proof.publicKey && proof.assertion ? { assertion: proof.assertion } : {}),
      }),
    });
    const { verified, token } = await res.json();
    if (verified) {
      lastVerifiedAddr = addr;
      if (token) {
        localStorage.setItem(walletTokenKey(), JSON.stringify({ address: addr, token }));
      }
    }
    return !!verified;
  } catch (err) {
    console.error("[wallet] Registration failed:", err);
    return false;
  } finally {
    verifyInProgress = null;
  }
}

function updateWalletUI() {
  const addr = getConnectedAddress();
  if (addr) {
    topBarAddress.textContent = truncateAddress(addr);
    walletLoginBtn.textContent = "Disconnect";
    walletLoginBtn.classList.add("btn-warn");
    walletLoginBtn.classList.remove("btn-primary");
    walletLoginBtn.style.display = "";
    walletRegisterBtn.style.display = "none";
    modeRankedBtn.classList.remove("locked");
    localStorage.setItem("chickenz-wallet-address", addr);
    // Notify server of wallet address (verification deferred until ranked play)
    networkManager?.sendSetWallet(addr);
    // Re-render room list so ranked join buttons update
    renderMergedRoomList(regionManager.getMergedRooms());
  } else {
    topBarAddress.textContent = "";
    walletLoginBtn.textContent = "Log In";
    walletLoginBtn.classList.remove("btn-warn");
    walletLoginBtn.classList.add("btn-primary");
    walletLoginBtn.style.display = "";
    walletRegisterBtn.style.display = "";
    // Notify server to clear wallet address and verified state
    networkManager?.sendSetWallet("");
    lastVerifiedAddr = null;
    localStorage.removeItem(walletTokenKey());
    localStorage.removeItem("chickenz-wallet-address");
    // Leave ranked room/lobby if wallet disconnected
    if (currentMode === "ranked") {
      networkManager?.sendLeave();
      setMode("casual");
    }
    modeRankedBtn.classList.add("locked");
    // Re-render room list so ranked join buttons update
    renderMergedRoomList(regionManager.getMergedRooms());
  }
}

walletLoginBtn.addEventListener("click", () => {
  if (getConnectedAddress()) {
    void disconnectWallet();
  } else {
    void promptConnect().finally(() => updateWalletUI());
  }
});

walletRegisterBtn.addEventListener("click", () => {
  walletRegisterBtn.disabled = true;
  walletRegisterBtn.textContent = "Deploying...";
  walletLoginBtn.disabled = true;
  walletLoginBtn.textContent = "creating account...";
  walletLoginBtn.classList.add("pulsing");
  void createWallet(getOrCreateUsername()).finally(() => {
    walletRegisterBtn.disabled = false;
    walletRegisterBtn.textContent = "Register";
    walletLoginBtn.disabled = false;
    walletLoginBtn.classList.remove("pulsing");
    updateWalletUI();
  });
});

window.addEventListener("walletChanged", () => {
  updateWalletUI();
});

// ── Mode Toggle ───────────────────────────────────────────────────────────────

function setMode(mode: GameMode) {
  currentMode = mode;
  localStorage.setItem("chickenz-mode", mode);
  modeCasualBtn.classList.toggle("active", mode === "casual");
  modeRankedBtn.classList.toggle("active", mode === "ranked");
}

// Restore saved mode preference
{
  const saved = localStorage.getItem("chickenz-mode") as GameMode | null;
  if (saved === "ranked" || saved === "casual") {
    currentMode = saved;
    modeCasualBtn.classList.toggle("active", saved === "casual");
    modeRankedBtn.classList.toggle("active", saved === "ranked");
  }
}

modeCasualBtn.addEventListener("click", () => {
  setMode("casual");
});

modeRankedBtn.addEventListener("click", () => {
  const addr = getConnectedAddress();
  if (!addr) return;
  setMode("ranked");
});

// ── Settings Panel ────────────────────────────────────────────────────────────

let settingsOpen = false;

// Build tiled border around a card using terrain spritesheet
function buildTiledFrame(frame: HTMLElement, card: HTMLElement) {
  const COLS = 22;
  const TILE = 16;
  const TOP_L = 4 * COLS + 12;
  const TOP_M = 4 * COLS + 13;
  const TOP_R = 4 * COLS + 14;
  const SIDE_T = 4 * COLS + 15;
  const SIDE_M = 5 * COLS + 15;
  const SIDE_B = 6 * COLS + 15;

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

  const observer = new ResizeObserver(() => {
    frame.querySelectorAll(".frame-tile").forEach((t) => t.remove());
    const w = frame.offsetWidth;
    const h = frame.offsetHeight;

    frame.appendChild(makeTile(TOP_L, 0, 0));
    for (let x = TILE; x < w - TILE; x += TILE) {
      frame.appendChild(makeTile(TOP_M, x, 0));
    }
    frame.appendChild(makeTile(TOP_R, w - TILE, 0));

    frame.appendChild(makeTile(TOP_L, 0, h - TILE));
    for (let x = TILE; x < w - TILE; x += TILE) {
      frame.appendChild(makeTile(TOP_M, x, h - TILE));
    }
    frame.appendChild(makeTile(TOP_R, w - TILE, h - TILE));

    frame.appendChild(makeTile(SIDE_T, 0, TILE));
    for (let y = 2 * TILE; y < h - 2 * TILE; y += TILE) {
      frame.appendChild(makeTile(SIDE_M, 0, y));
    }
    frame.appendChild(makeTile(SIDE_B, 0, h - 2 * TILE));

    const addFlipped = (idx: number, fx: number, fy: number) => {
      const tile = makeTile(idx, fx, fy);
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

buildTiledFrame(document.getElementById("settings-frame")!, document.getElementById("settings-card")!);
buildTiledFrame(document.getElementById("tutorial-prompt-frame")!, document.getElementById("tutorial-prompt-card")!);
buildTiledFrame(document.getElementById("username-prompt-frame")!, document.getElementById("username-prompt-card")!);

// Version display
declare const __COMMIT_HASH__: string;
declare const __COMMIT_DATE__: string;
const versionEl = document.getElementById("settings-version");
if (versionEl) {
  versionEl.textContent = `Version: ${__COMMIT_HASH__} | ${__COMMIT_DATE__}`;
}

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
  checkMusic.checked = localStorage.getItem("chickenz-music-muted") !== "true";
  settingsUsername.value = currentUsername;
  settingsUsernameError.textContent = "";
  updateCharUI();
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

// Click outside settings card to close
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

// Close settings/detail on Escape
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (matchDetailOverlay.classList.contains("visible")) {
      matchDetailOverlay.classList.remove("visible");
      e.preventDefault();
      return;
    }
    if (settingsOpen) {
      closeSettings();
      e.preventDefault();
    }
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

// Music note icon (unmuted) / music note + strikethrough (muted)
const MUSIC_ICON_ON = '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>';
const MUSIC_ICON_OFF =
  '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/><line x1="2" y1="12" x2="22" y2="12" stroke="white" stroke-width="2.5" opacity="0.5"/>';

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

const charHomeName = document.getElementById("char-home-name") as HTMLSpanElement;
const charAwayName = document.getElementById("char-away-name") as HTMLSpanElement;

function updateCharUI() {
  charHomeName.textContent = CHARACTER_NAMES[homeCharacter] ?? "???";
  charAwayName.textContent = CHARACTER_NAMES[awayCharacter] ?? "???";
}
updateCharUI();

function setHomeChar(idx: number) {
  homeCharacter = ((idx % NUM_CHARACTERS) + NUM_CHARACTERS) % NUM_CHARACTERS;
  if (homeCharacter === awayCharacter) awayCharacter = (homeCharacter + 1) % NUM_CHARACTERS;
  localStorage.setItem("chickenz-home-char", String(homeCharacter));
  localStorage.setItem("chickenz-away-char", String(awayCharacter));
  pendingCharacter = homeCharacter;
  updateCharUI();
}

function setAwayChar(idx: number) {
  awayCharacter = ((idx % NUM_CHARACTERS) + NUM_CHARACTERS) % NUM_CHARACTERS;
  if (awayCharacter === homeCharacter) awayCharacter = (awayCharacter + 1) % NUM_CHARACTERS;
  localStorage.setItem("chickenz-away-char", String(awayCharacter));
  updateCharUI();
}

document.getElementById("btn-home-prev")!.addEventListener("click", () => setHomeChar(homeCharacter - 1));
document.getElementById("btn-home-next")!.addEventListener("click", () => setHomeChar(homeCharacter + 1));
document.getElementById("btn-away-prev")!.addEventListener("click", () => setAwayChar(awayCharacter - 1));
document.getElementById("btn-away-next")!.addEventListener("click", () => setAwayChar(awayCharacter + 1));

// ── Back-to-lobby buttons ─────────────────────────────────────────────────────

document.getElementById("btn-warmup-back")!.addEventListener("click", () => {
  const scene = getGameScene();
  if (scene?.isWarmup) scene.stopWarmup();
  networkManager?.sendLeave();
  openLobby();
});

document.getElementById("btn-add-bot")!.addEventListener("click", () => {
  networkManager?.sendAddBot();
});

// Share/copy invite link button in warmup
document.getElementById("btn-warmup-share")?.addEventListener("click", () => {
  const codeEl = document.getElementById("warmup-code");
  const code = codeEl?.textContent?.trim();
  if (code) {
    void navigator.clipboard.writeText(`${window.location.origin}/?join=${code}`).then(() => {
      const btn = document.getElementById("btn-warmup-share");
      if (btn) {
        btn.textContent = "COPIED!";
        setTimeout(() => {
          btn.textContent = "COPY LINK";
        }, 1500);
      }
    });
  }
});

document.getElementById("btn-tournament-back")!.addEventListener("click", () => {
  networkManager?.sendLeave();
  hideAllTournamentOverlays();
  currentTournamentId = null;
  currentTournamentSlot = -1;
  _currentTournamentHostSlot = -1;
  tournamentSpectating = false;
  openLobby();
});

/** Apply saved audio settings to the game scene. */
function applyAudioSettings(scene: GameScene) {
  const bgm = parseInt(localStorage.getItem("chickenz-bgm-volume") ?? "10", 10);
  const sfx = parseInt(localStorage.getItem("chickenz-sfx-volume") ?? "80", 10);
  const musicMuted = localStorage.getItem("chickenz-music-muted") !== "false";
  scene.setBGMVolume(bgm / 100);
  scene.setSFXVolume(sfx / 100);
  scene.setMusicMuted(musicMuted);
}

// Feed touch controls into InputManager each frame
if (isTouchDevice) {
  const feedTouch = () => {
    const im = getInputManager();
    if (im) {
      im.setTouchState(touchControls.getTouchButtons(), touchControls.getAimX());
    }
    requestAnimationFrame(feedTouch);
  };
  requestAnimationFrame(feedTouch);
}

// Tutorial is now driven by GameScene.update() — no separate rAF loop needed

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
  pendingQuickplay = false;

  // Clear join code from URL bar and localStorage
  history.replaceState(null, "", window.location.pathname);
  localStorage.removeItem("chickenz-last-join-code");

  // Hide touch controls and tutorial when returning to lobby
  if (isTouchDevice) touchControls.hide();
  if (tutorial.isActive) tutorial.hide();

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

function renderMergedRoomList(mergedRooms: RegionRoomInfo[]) {
  roomListEl.innerHTML = "";

  if (mergedRooms.length === 0) {
    roomListEl.innerHTML = `<div id="lobby-empty">No public rooms yet. Create one or hit Quick Play!</div>`;
    return;
  }

  const joinable = mergedRooms.filter((r) => r.room.status === "waiting");
  const playing = mergedRooms.filter((r) => r.room.status === "playing");

  for (const rr of joinable) {
    roomListEl.appendChild(createRoomElement(rr.room, rr.regionId, rr.regionFlag));
  }
  for (const rr of playing) {
    roomListEl.appendChild(createRoomElement(rr.room, rr.regionId, rr.regionFlag));
  }
}

function createRoomElement(room: RoomInfo, roomRegionId?: string, roomRegionFlag?: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "room-item";
  const modeBadge =
    room.mode === "ranked"
      ? `<span class="mode-badge ranked">Ranked</span>`
      : `<span class="mode-badge casual">Casual</span>`;
  const isHome = roomRegionId === regionManager.homeRegionId;
  const regionBadge = roomRegionFlag
    ? `<span class="region-badge${isHome ? " home" : ""}">${escapeHtml(roomRegionFlag)}</span>`
    : "";
  const needsWalletTooltip = room.mode === "ranked" && room.status === "waiting" && !getConnectedAddress();
  const joinButton =
    room.status === "waiting"
      ? needsWalletTooltip
        ? `<span class="btn-join-wrapper"><button class="btn btn-primary btn-join" data-room-id="${escapeHtml(room.id)}">Join</button><span class="ranked-tooltip">Connect a wallet to play ranked</span></span>`
        : `<button class="btn btn-primary btn-join" data-room-id="${escapeHtml(room.id)}">Join</button>`
      : "";
  const names = (room.playerNames ?? []).filter(Boolean).map(escapeHtml).join(" vs ");
  const namesSpan = names ? `<span class="room-players">${names}</span>` : "";
  el.innerHTML = `
    <span>
      <span class="room-name">${escapeHtml(room.name)}</span>
      ${modeBadge}
      ${regionBadge}
      <span class="room-code">${escapeHtml(room.joinCode)}</span>
      ${namesSpan}
    </span>
    <div class="room-info">
      <span class="room-status ${room.status}">${room.status === "waiting" ? "Waiting (1/2)" : "In Progress (2/2)"}</span>
      ${joinButton}
    </div>
  `;

  const joinBtn = el.querySelector(".btn-join");
  if (joinBtn) {
    joinBtn.addEventListener("click", () => {
      const targetRegion = roomRegionId ? regionManager.getRegionById(roomRegionId) : undefined;

      const doJoin = () => {
        if (!networkManager?.connected) return;
        pendingCharacter = homeCharacter;
        networkManager.sendJoinRoom(room.id, pendingCharacter, awayCharacter);
        lobbyStatus.textContent = "Joining...";
        setLobbyButtons(false);
      };

      // Switch region if room is on a different server
      const needSwitch = targetRegion && roomRegionId !== activeRegionId;

      if (room.mode === "ranked") {
        void ensureRankedReady(true).then(async (ok) => {
          if (!ok) return;
          if (needSwitch) await switchToRegion(targetRegion);
          doJoin();
        });
        return;
      }

      if (needSwitch) {
        void switchToRegion(targetRegion).then(doJoin);
      } else {
        doJoin();
      }
    });
  }

  return el;
}

// ── Leaderboard ──────────────────────────────────────────────────────────────

let fetchingLeaderboard = false;
let fetchingHistory = false;

function fetchLeaderboard() {
  if (fetchingLeaderboard) return;
  fetchingLeaderboard = true;
  const regions = getRegions();
  const fetches = regions.map((r) =>
    fetch(`${r.httpUrl}/api/leaderboard`)
      .then((res) => res.json() as Promise<{ name: string; elo: number; wins: number; losses: number }[]>)
      .catch(() => [] as { name: string; elo: number; wins: number; losses: number }[]),
  );
  Promise.all(fetches)
    .then((results) => {
      // Merge by name: keep highest ELO, sum wins/losses across regions
      const merged = new Map<string, { name: string; elo: number; wins: number; losses: number }>();
      for (const entries of results) {
        for (const e of entries) {
          const existing = merged.get(e.name);
          if (existing) {
            existing.elo = Math.max(existing.elo, e.elo);
            existing.wins += e.wins;
            existing.losses += e.losses;
          } else {
            merged.set(e.name, { ...e });
          }
        }
      }
      const sorted = [...merged.values()].sort((a, b) => b.elo - a.elo);
      renderLeaderboard(sorted);
    })
    .catch(() => {
      leaderboardContent.innerHTML = `<div class="empty-state">Failed to load leaderboard</div>`;
    })
    .finally(() => {
      fetchingLeaderboard = false;
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
  if (fetchingHistory) return;
  fetchingHistory = true;
  const regions = getRegions();
  const fetches = regions.map((r) =>
    fetch(`${r.httpUrl}/api/matches`)
      .then((res) => res.json() as Promise<MatchRecord[]>)
      .then((matches) => matches.map((m) => ({ ...m, _regionUrl: r.httpUrl, _regionId: r.id })))
      .catch(() => [] as MatchRecord[]),
  );
  Promise.all(fetches)
    .then((results) => {
      // Merge all matches, dedupe by id, sort by timestamp descending
      const seen = new Set<string>();
      const merged: MatchRecord[] = [];
      for (const matches of results) {
        for (const m of matches) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            merged.push(m);
          }
        }
      }
      merged.sort((a, b) => b.timestamp - a.timestamp);
      renderMatchHistory(merged);
    })
    .catch(() => {
      matchHistoryList.innerHTML = `<div class="empty-state">Failed to load match history</div>`;
    })
    .finally(() => {
      fetchingHistory = false;
    });
}

function renderMatchHistory(matches: MatchRecord[]) {
  if (matches.length === 0) {
    matchHistoryList.innerHTML = `<div class="empty-state">No matches played yet</div>`;
    return;
  }
  // innerHTML replacement destroys all old elements and their listeners, so
  // per-element addEventListener in the loop below is safe (no leak). We still
  // use event delegation on the container for button actions to keep wiring simple.
  matchHistoryList.innerHTML = "";

  // Store matches by roomId / matchId for delegation lookups
  const matchByRoom = new Map<string, MatchRecord>();
  const matchById = new Map<string, MatchRecord>();
  for (const m of matches) {
    matchByRoom.set(m.roomId, m);
    matchById.set(m.id, m);
  }

  for (const m of matches) {
    const el = document.createElement("div");
    el.className = "match-item";
    el.dataset.matchId = m.id;
    el.dataset.regionUrl = m._regionUrl || "";
    const ago = formatTimeAgo(m.timestamp);
    const modeBadge =
      m.mode === "ranked"
        ? `<span class="mode-badge ranked">Ranked</span>`
        : `<span class="mode-badge casual">Casual</span>`;
    const showSettle = m.mode === "ranked" && m.proofStatus === "verified" && getConnectedAddress();
    el.innerHTML = `
      <div>
        <span class="match-players">${escapeHtml(m.player1)}${m.wallet1 ? ` <span class="match-wallet">${truncateAddress(m.wallet1)}</span>` : ""} vs ${escapeHtml(m.player2)}${m.wallet2 ? ` <span class="match-wallet">${truncateAddress(m.wallet2)}</span>` : ""}</span>
        <span class="match-score">${m.scores[0]}-${m.scores[1]}</span>
        ${modeBadge}
      </div>
      <div class="match-item-meta">
        <span class="match-time">${ago}</span>
        <span class="proof-badge ${m.proofStatus}">${escapeHtml(proofStatusLabel(m.proofStatus))}</span>
        ${showSettle ? `<button class="btn btn-sm btn-primary btn-settle" data-action="settle" data-match-id="${escapeHtml(m.id)}">Settle</button>` : ""}
        <button class="btn btn-sm btn-replay" data-action="replay" data-room-id="${escapeHtml(m.roomId)}">Replay</button>
        <button class="btn btn-sm btn-share" data-action="share" data-room-id="${escapeHtml(m.roomId)}" data-region="${escapeHtml(m._regionId || activeRegionId)}">Share</button>
        <button class="btn btn-sm btn-download" data-action="download" data-room-id="${escapeHtml(m.roomId)}">DL</button>
      </div>
    `;
    matchHistoryList.appendChild(el);
  }

  // Single delegated listener for all button actions in match history list
  matchHistoryList.onclick = (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (target) {
      e.stopPropagation();
      const action = target.dataset.action;
      const roomId = target.dataset.roomId || "";
      const matchId = target.dataset.matchId || "";
      const m = roomId ? matchByRoom.get(roomId) : matchById.get(matchId);
      if (!m) return;
      switch (action) {
        case "replay":
          startReplay(m.roomId, m._regionUrl);
          break;
        case "share": {
          const region = target.dataset.region || activeRegionId;
          void navigator.clipboard
            .writeText(`${window.location.origin}/?replay=${m.roomId}&region=${region}`)
            .then(() => {
              target.textContent = "Copied!";
              setTimeout(() => {
                target.textContent = "Share";
              }, 1500);
            });
          break;
        }
        case "download":
          downloadTranscript(m.roomId, m._regionUrl);
          break;
        case "settle":
          void handleSettleMatch(m.id, m._regionUrl);
          break;
      }
      return;
    }
    // Click on row (not a button) opens detail
    const row = (e.target as HTMLElement).closest<HTMLElement>(".match-item");
    if (row && row.dataset.matchId) {
      const m = matchById.get(row.dataset.matchId);
      if (m) openMatchDetail(m.id, m._regionUrl);
    }
  };
}

interface TranscriptInput {
  buttons: number;
  aimX?: number;
  aimY?: number;
  aim_x?: number;
  aim_y?: number;
}

interface RoundTranscript {
  seed: number;
  mapIndex: number;
  transcript: [TranscriptInput, TranscriptInput][];
}

interface TranscriptResponse {
  rounds: RoundTranscript[];
  usernames?: [string, string];
  characters?: [number, number];
}

function startReplay(roomId: string, regionUrl?: string) {
  const origin = regionUrl || networkManager?.httpOrigin;
  if (!origin) return;
  fetch(`${origin}/transcript/${roomId}`)
    .then((r) => r.json())
    .then((data: TranscriptResponse) => {
      closeLobby();
      const scene = getGameScene();
      if (scene) {
        scene.startMultiRoundReplay(data.rounds, data.usernames, data.characters);
      }
    })
    .catch(() => {
      lobbyStatus.textContent = "Failed to load transcript for replay.";
    });
}

function downloadTranscript(roomId: string, regionUrl?: string) {
  const origin = regionUrl || networkManager?.httpOrigin;
  if (!origin) return;
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

// ── Match Detail Modal ────────────────────────────────────────────────────────

function openMatchDetail(matchId: string, regionUrl?: string) {
  const origin = regionUrl || networkManager?.httpOrigin;
  if (!origin) return;
  fetch(`${origin}/api/matches/${matchId}/detail`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((m: MatchRecord) => {
      renderMatchDetail(m, matchDetailBody, {
        onReplay: (roomId) => startReplay(roomId),
        onDownload: (roomId) => downloadTranscript(roomId),
        onClose: () => matchDetailOverlay.classList.remove("visible"),
      });
      matchDetailOverlay.classList.add("visible");
    })
    .catch((err) => {
      console.error("[detail] Failed to load match details:", err);
      lobbyStatus.textContent = "Failed to load match details.";
    });
}


// ── Tournament UI helpers ──────────────────────────────────────────────────────

const tournamentTimers: ReturnType<typeof setTimeout>[] = [];

function hideAllTournamentOverlays() {
  tournamentOverlay.classList.remove("visible");
  bracketOverlay.classList.remove("visible");
  spectateOverlay.classList.remove("visible");
  tournamentResults.classList.remove("visible");
  // Clear any pending animation timers
  for (const t of tournamentTimers) clearTimeout(t);
  tournamentTimers.length = 0;
}

function renderBracket(bracket: TournamentBracket, highlightMatchIndex?: number) {
  bracketGrid.innerHTML = "";

  // Separate winners/final vs consolation matches; skip pure bye matches (no real players)
  const allWinners = bracket.matches.filter(
    (m) => (m.bracketSide === "winners" || m.bracketSide === "final") && m.status !== "bye",
  );
  const consolationMatches = bracket.matches.filter(
    (m) => (m.bracketSide === "consolation" || m.bracketSide === "third_place") && m.status !== "bye",
  );

  if (allWinners.length === 0) return;

  // Group by round
  const maxRound = Math.max(...allWinners.map((m) => m.round));
  const roundGroups: BracketMatch[][] = [];
  for (let r = 0; r <= maxRound; r++) {
    roundGroups.push(allWinners.filter((m) => m.round === r).sort((a, b) => a.matchIndex - b.matchIndex));
  }

  // Classify matches into left/right side
  const r0 = roundGroups[0] || [];
  const halfR0 = Math.ceil(r0.length / 2);
  const leftR0Set = new Set(r0.slice(0, halfR0).map((m) => m.matchIndex));
  const side = new Map<number, "left" | "right">();
  for (const m of r0) side.set(m.matchIndex, leftR0Set.has(m.matchIndex) ? "left" : "right");
  for (let r = 1; r <= maxRound; r++) {
    for (const m of roundGroups[r]!) {
      const sA = m.sourceA.type === "winner" || m.sourceA.type === "loser" ? side.get(m.sourceA.matchIndex) : undefined;
      const sB = m.sourceB.type === "winner" || m.sourceB.type === "loser" ? side.get(m.sourceB.matchIndex) : undefined;
      // Final is center, not a side
      if (m.bracketSide === "final")
        side.set(m.matchIndex, "left"); // placeholder
      else side.set(m.matchIndex, sA === "left" || sB === "left" ? "left" : "right");
    }
  }

  // Layout constants
  const MW = 150; // match width
  const MH = 52; // match height (2 rows × 26)
  const COL_GAP = 60; // horizontal gap between rounds (for connector lines)
  const FINAL_GAP = 70; // extra gap around final
  const VPAD = 16; // vertical padding

  const numSideRounds = maxRound;
  const isFinalOnly = maxRound === 0;

  const leftRound = (r: number) =>
    (roundGroups[r] || []).filter((m) => side.get(m.matchIndex) === "left" && m.bracketSide !== "final");
  const rightRound = (r: number) =>
    (roundGroups[r] || []).filter((m) => side.get(m.matchIndex) === "right" && m.bracketSide !== "final");
  const finalMatches = allWinners.filter((m) => m.bracketSide === "final");

  const leftR0Count = leftRound(0).length || 1;
  const rightR0Count = rightRound(0).length || 1;
  const maxR0 = Math.max(leftR0Count, rightR0Count);
  const baseSpacing = MH + VPAD * 2;
  const totalHeight = isFinalOnly ? MH + 60 : Math.max(maxR0 * baseSpacing + VPAD * 2, 240);

  const totalWidth = isFinalOnly
    ? MW + 40
    : numSideRounds * (MW + COL_GAP) + MW + FINAL_GAP * 2 + numSideRounds * (MW + COL_GAP);

  // Position each match. Track positions by matchIndex for line drawing.
  const pos = new Map<number, { x: number; y: number; w: number; h: number }>();

  function placeRound(matches: BracketMatch[], colX: number, availTop: number, availHeight: number) {
    const n = matches.length;
    if (n === 0) return;
    const spacing = availHeight / n;
    for (let i = 0; i < n; i++) {
      const y = availTop + spacing * i + (spacing - MH) / 2;
      pos.set(matches[i]!.matchIndex, { x: colX, y, w: MW, h: MH });
    }
  }

  if (isFinalOnly) {
    // Just the final centered
    const fm = r0[0];
    if (fm) pos.set(fm.matchIndex, { x: 20, y: 30, w: MW, h: MH });
  } else {
    // Left side: round 0 is leftmost, increasing rounds go right
    for (let r = 0; r < numSideRounds; r++) {
      const colX = r * (MW + COL_GAP);
      placeRound(leftRound(r), colX, 0, totalHeight);
    }

    // Final in center
    const centerX = totalWidth / 2 - MW / 2;
    for (const fm of finalMatches) {
      pos.set(fm.matchIndex, { x: centerX, y: totalHeight / 2 - MH / 2, w: MW, h: MH });
    }

    // Right side: round 0 is rightmost, increasing rounds go left (mirror)
    for (let r = 0; r < numSideRounds; r++) {
      const colX = totalWidth - (r + 1) * (MW + COL_GAP) + COL_GAP;
      placeRound(rightRound(r), colX, 0, totalHeight);
    }
  }

  // Build match HTML helper
  function matchHtml(m: BracketMatch): string {
    const p = pos.get(m.matchIndex);
    if (!p) return "";
    const p1Name = m.playerA?.name || "TBD";
    const p2Name = m.playerB?.name || "TBD";
    const winSlot = m.winner;
    const p1Won = winSlot !== undefined && m.playerA && winSlot === m.playerA.slot;
    const p2Won = winSlot !== undefined && m.playerB && winSlot === m.playerB.slot;
    let cls = "bk-match";
    if (m.status === "done") cls += " done";
    else if (m.status === "playing") cls += " playing";
    else if (m.status === "ready") cls += " ready";
    if (m.bracketSide === "final") cls += " final-match";
    if (highlightMatchIndex === m.matchIndex) cls += " playing";
    return `<div class="${cls}" data-mi="${m.matchIndex}" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px;">
      <div class="bk-seed${p1Won ? " won" : ""}">${escapeHtml(p1Name)}</div>
      <div class="bk-seed${p2Won ? " won" : ""}">${escapeHtml(p2Name)}</div>
    </div>`;
  }

  // Build SVG connector lines
  let lines = "";
  for (const m of allWinners) {
    if (m.status === "bye") continue;
    const mPos = pos.get(m.matchIndex);
    if (!mPos) continue;
    const _mSide = side.get(m.matchIndex);
    const isFinal = m.bracketSide === "final";

    // Draw line from each source match to this match
    for (const src of [m.sourceA, m.sourceB]) {
      if (src.type !== "winner" && src.type !== "loser") continue;
      // Find actual source — skip through byes
      let srcIdx = src.matchIndex;
      let srcMatch = bracket.matches.find((mm) => mm.matchIndex === srcIdx);
      while (srcMatch && srcMatch.status === "bye") {
        // Follow the winning source of the bye
        const byeSrc = srcMatch.winner === srcMatch.playerA?.slot ? srcMatch.sourceA : srcMatch.sourceB;
        if (!byeSrc || byeSrc.type === "seed" || byeSrc.type === "bye") break;
        srcIdx = byeSrc.matchIndex;
        srcMatch = bracket.matches.find((mm) => mm.matchIndex === srcIdx);
      }
      const srcPos = pos.get(srcIdx);
      if (!srcPos) continue;

      const srcSide = side.get(srcIdx);
      // Source output point: right edge if left side, left edge if right side
      let x1: number, y1: number, x2: number, y2: number;

      if (srcSide === "left" || isFinal) {
        x1 = srcPos.x + srcPos.w; // right edge of source
        y1 = srcPos.y + srcPos.h / 2;
        x2 = mPos.x; // left edge of target
        y2 = mPos.y + mPos.h / 2;
      } else {
        x1 = srcPos.x; // left edge of source
        y1 = srcPos.y + srcPos.h / 2;
        x2 = mPos.x + mPos.w; // right edge of target
        y2 = mPos.y + mPos.h / 2;
      }

      // Draw L-shaped connector: horizontal from source, then vertical, then horizontal to target
      const midX = (x1 + x2) / 2;
      lines += `<line x1="${x1}" y1="${y1}" x2="${midX}" y2="${y1}"/>`;
      lines += `<line x1="${midX}" y1="${y1}" x2="${midX}" y2="${y2}"/>`;
      lines += `<line x1="${midX}" y1="${y2}" x2="${x2}" y2="${y2}"/>`;
    }
  }

  // Consolation rows (rendered below the bracket canvas)
  let consolationHeight = 0;
  let consolationHtml = "";
  if (consolationMatches.length > 0) {
    consolationHeight = 80;
    consolationHtml = `<div class="bk-consolation-section" style="position:absolute;left:0;top:${totalHeight}px;width:${totalWidth}px;">`;
    consolationHtml += `<div class="bk-consolation-title">CONSOLATION</div><div class="bk-consolation-row">`;
    for (const m of consolationMatches) {
      const p1 = m.playerA?.name || "TBD";
      const p2 = m.playerB?.name || "TBD";
      const p1Won = m.winner !== undefined && m.playerA && m.winner === m.playerA.slot;
      const p2Won = m.winner !== undefined && m.playerB && m.winner === m.playerB.slot;
      let cls = "bk-match";
      if (m.status === "done") cls += " done";
      else if (m.status === "playing") cls += " playing";
      else if (m.status === "ready") cls += " ready";
      consolationHtml += `<div class="${cls}" data-mi="${m.matchIndex}">
        <div class="bk-seed${p1Won ? " won" : ""}">${escapeHtml(p1)}</div>
        <div class="bk-seed${p2Won ? " won" : ""}">${escapeHtml(p2)}</div>
      </div>`;
    }
    consolationHtml += `</div></div>`;
  }

  const canvasH = totalHeight + consolationHeight;

  // Assemble
  let html = `<div class="bk-canvas" style="width:${totalWidth}px;height:${canvasH}px;">`;
  html += `<svg class="bk-lines" viewBox="0 0 ${totalWidth} ${totalHeight}" style="height:${totalHeight}px;">${lines}</svg>`;

  // Final label
  if (!isFinalOnly && finalMatches.length > 0) {
    const fp = pos.get(finalMatches[0]!.matchIndex);
    if (fp) {
      html += `<div class="bk-final-label" style="left:${fp.x}px;top:${fp.y - 20}px;width:${fp.w}px;">FINAL</div>`;
    }
  }

  // All match boxes
  for (const m of allWinners) {
    if (m.status === "bye") continue;
    html += matchHtml(m);
  }

  html += consolationHtml;
  html += `</div>`;

  bracketGrid.innerHTML = html;

  // Auto-scale bracket to fit the overlay
  const canvasEl = bracketGrid.querySelector(".bk-canvas") as HTMLElement;
  if (canvasEl) {
    requestAnimationFrame(() => {
      const parentW = bracketGrid.clientWidth || 800;
      const parentH = bracketGrid.clientHeight || 400;
      const scaleX = parentW / totalWidth;
      const scaleY = parentH / canvasH;
      const scale = Math.min(scaleX, scaleY, 1.4);
      canvasEl.style.transform = `scale(${scale})`;
      canvasEl.style.transformOrigin = "center center";
    });
  }
}

function renderStandings(standings: { place: number; name: string }[]) {
  const ordinal = (n: number) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);
  // Count how many players share each place
  const placeCounts = new Map<number, number>();
  for (const s of standings) placeCounts.set(s.place, (placeCounts.get(s.place) || 0) + 1);

  standingsList.innerHTML = "";
  for (const s of standings) {
    const el = document.createElement("div");
    el.className = "standing-row";
    const tied = (placeCounts.get(s.place) || 0) > 1;
    const label = (tied ? "=" : "") + ordinal(s.place);
    el.innerHTML = `<span class="place">${label}</span><span class="name">${escapeHtml(s.name)}</span>`;
    standingsList.appendChild(el);
  }
}

function renderTournamentLobby(msg: TournamentLobbyMessage) {
  currentTournamentId = msg.tournamentId;
  _currentTournamentHostSlot = msg.hostSlot;

  currentTournamentSlot = msg.mySlot;
  const myRole = currentTournamentSlot >= 0 ? msg.participants[currentTournamentSlot]!.role : null;

  closeLobby();
  hideAllTournamentOverlays();
  tournamentOverlay.classList.add("visible");
  tournamentCode.textContent = msg.joinCode;

  const players = msg.participants.filter((p) => p.role === "player");
  const spectators = msg.participants.filter((p) => p.role === "spectator");
  const isWaiting = msg.status === "waiting";

  if (msg.status === "playing") {
    tournamentStatus.textContent = "Tournament in progress...";
  } else if (msg.status === "ended") {
    tournamentStatus.textContent = "Tournament ended";
  } else {
    tournamentStatus.textContent = `${players.length}/8 players, ${spectators.length}/5 spectators`;
  }

  // ── Render slot grid ──
  tournamentPlayers.innerHTML = "";

  // Player slots (8 max)
  const playerLabel = document.createElement("div");
  playerLabel.className = "slots-section-label";
  playerLabel.textContent = "PLAYERS";
  tournamentPlayers.appendChild(playerLabel);

  const playerGrid = document.createElement("div");
  playerGrid.className = "slots-grid";
  for (let i = 0; i < 8; i++) {
    const p = players[i];
    const el = document.createElement("div");
    if (p) {
      el.className = "tournament-slot filled";
      if (p.slot === msg.hostSlot) el.classList.add("host");
      if (!p.connected) el.classList.add("disconnected");
      el.innerHTML = `<span class="slot-name">${escapeHtml(p.name)}</span>`;
      if (p.slot === msg.hostSlot)
        el.insertAdjacentHTML("beforeend", `<span class="slot-badge host-badge">HOST</span>`);
    } else {
      el.className = "tournament-slot empty";
      el.textContent = "---";
      // If I'm a spectator, clicking an empty player slot switches me to player
      if (isWaiting && myRole === "spectator") {
        el.style.cursor = "pointer";
        el.addEventListener("click", () => networkManager?.sendToggleRole());
      }
    }
    playerGrid.appendChild(el);
  }
  tournamentPlayers.appendChild(playerGrid);

  // Spectator slots (5 max)
  const spectatorLabel = document.createElement("div");
  spectatorLabel.className = "slots-section-label";
  spectatorLabel.textContent = "SPECTATORS";
  tournamentPlayers.appendChild(spectatorLabel);

  const spectatorGrid = document.createElement("div");
  spectatorGrid.className = "slots-grid";
  for (let i = 0; i < 5; i++) {
    const s = spectators[i];
    const el = document.createElement("div");
    if (s) {
      el.className = "tournament-slot filled spectator-slot";
      if (!s.connected) el.classList.add("disconnected");
      el.innerHTML = `<span class="slot-name">${escapeHtml(s.name)}</span>`;
    } else {
      el.className = "tournament-slot empty spectator-slot";
      el.textContent = "---";
      // If I'm a player, clicking an empty spectator slot switches me to spectator
      if (isWaiting && myRole === "player") {
        el.style.cursor = "pointer";
        el.addEventListener("click", () => networkManager?.sendToggleRole());
      }
    }
    spectatorGrid.appendChild(el);
  }
  tournamentPlayers.appendChild(spectatorGrid);

  // ── Host controls ──
  let controlsEl = document.getElementById("tournament-host-controls");
  if (controlsEl) controlsEl.remove();

  if (currentTournamentSlot === msg.hostSlot && isWaiting) {
    controlsEl = document.createElement("div");
    controlsEl.id = "tournament-host-controls";

    // Config row
    const configRow = document.createElement("div");
    configRow.className = "tournament-config-row";

    const fmtLabel = document.createElement("span");
    fmtLabel.textContent = "Format:";
    const fmtBo3 = document.createElement("button");
    fmtBo3.className = "btn btn-sm" + (msg.config.matchFormat === "bo3" ? " active" : "");
    fmtBo3.textContent = "Bo3";
    fmtBo3.addEventListener("click", () => networkManager?.sendUpdateTournamentConfig({ matchFormat: "bo3" }));
    const fmtBo5 = document.createElement("button");
    fmtBo5.className = "btn btn-sm" + (msg.config.matchFormat === "bo5" ? " active" : "");
    fmtBo5.textContent = "Bo5";
    fmtBo5.addEventListener("click", () => networkManager?.sendUpdateTournamentConfig({ matchFormat: "bo5" }));
    configRow.append(fmtLabel, fmtBo3, fmtBo5);

    const bracketLabel = document.createElement("span");
    bracketLabel.textContent = "Bracket:";
    bracketLabel.style.marginLeft = "12px";
    const btWinners = document.createElement("button");
    btWinners.className = "btn btn-sm" + (msg.config.bracketType === "winners_only" ? " active" : "");
    btWinners.textContent = "Winners";
    btWinners.addEventListener("click", () =>
      networkManager?.sendUpdateTournamentConfig({ bracketType: "winners_only" }),
    );
    const btPartial = document.createElement("button");
    btPartial.className = "btn btn-sm" + (msg.config.bracketType === "partial_consolation" ? " active" : "");
    btPartial.textContent = "4th Place";
    btPartial.addEventListener("click", () =>
      networkManager?.sendUpdateTournamentConfig({ bracketType: "partial_consolation" }),
    );
    const btFull = document.createElement("button");
    btFull.className = "btn btn-sm" + (msg.config.bracketType === "full_consolation" ? " active" : "");
    btFull.textContent = "Full";
    btFull.addEventListener("click", () =>
      networkManager?.sendUpdateTournamentConfig({ bracketType: "full_consolation" }),
    );
    configRow.append(bracketLabel, btWinners, btPartial, btFull);
    controlsEl.appendChild(configRow);

    const startBtn = document.createElement("button");
    startBtn.className = "btn btn-primary";
    startBtn.textContent = "START TOURNAMENT";
    startBtn.disabled = players.length < 2;
    startBtn.style.marginTop = "8px";
    startBtn.addEventListener("click", () => networkManager?.sendStartTournament());
    controlsEl.appendChild(startBtn);

    tournamentOverlay.appendChild(controlsEl);
  } else if (isWaiting) {
    controlsEl = document.createElement("div");
    controlsEl.id = "tournament-host-controls";
    controlsEl.classList.add("readonly");

    const configRow = document.createElement("div");
    configRow.className = "tournament-config-row";

    const fmtLabel = document.createElement("span");
    fmtLabel.textContent = "Format:";
    for (const [val, label] of [
      ["bo3", "Bo3"],
      ["bo5", "Bo5"],
    ] as const) {
      const btn = document.createElement("span");
      btn.className = "btn btn-sm" + (msg.config.matchFormat === val ? " active" : " inactive");
      btn.textContent = label;
      configRow.appendChild(btn);
    }

    const bracketLabel = document.createElement("span");
    bracketLabel.textContent = "Bracket:";
    bracketLabel.style.marginLeft = "12px";
    configRow.appendChild(fmtLabel);
    configRow.appendChild(bracketLabel);
    for (const [val, label] of [
      ["winners_only", "Winners"],
      ["partial_consolation", "4th Place"],
      ["full_consolation", "Full"],
    ] as const) {
      const btn = document.createElement("span");
      btn.className = "btn btn-sm" + (msg.config.bracketType === val ? " active" : " inactive");
      btn.textContent = label;
      configRow.appendChild(btn);
    }

    controlsEl.appendChild(configRow);

    const waitText = document.createElement("div");
    waitText.style.cssText = "font-size:11px;color:#888;margin-top:4px;";
    waitText.textContent = "Waiting for host to start...";
    controlsEl.appendChild(waitText);

    tournamentOverlay.appendChild(controlsEl);
  }
}

// ── Network ────────────────────────────────────────────────────────────────────

function connectToServer(url: string): Promise<void> {
  return new Promise<void>((resolveConnect) => {
    if (networkManager) {
      networkManager.disconnect();
    }

    networkManager = new NetworkManager({
      onLobby(rooms) {
        // Feed into RegionManager for cross-region merged room list
        regionManager.updateRoomsForRegion(activeRegionId, rooms);
      },

      onWaiting(roomId, roomName, joinCode) {
        // Suppress when in tournament (GameRoom sends "waiting" internally)
        if (currentTournamentId) return;
        // Show join code in URL bar so the address is a shareable link
        history.replaceState(null, "", "?join=" + joinCode);
        // Remember our own join code so refresh doesn't show "room not found"
        localStorage.setItem("chickenz-last-join-code", joinCode);
        // Hide bot button in ranked mode
        const botBtn = document.getElementById("btn-add-bot");
        if (botBtn) botBtn.style.display = currentMode === "ranked" ? "none" : "";
        const scene = getGameScene();
        if (scene) {
          scene.startWarmup(
            joinCode,
            currentUsername,
            () => {
              closeLobby();
              applyAudioSettings(scene);
              // Show touch controls during gameplay
              if (isTouchDevice) touchControls.show();
            },
            pendingCharacter,
          );
        }
      },

      onMatched(playerId, seed, roomId, usernames, mapIndex, totalRounds, mode, characters) {
        // Suppress when in tournament (tournament_match_start handles this)
        if (currentTournamentId) return;

        const scene = getGameScene();
        if (!scene) return;

        networkManager?.resetThrottle();
        // Don't close lobby yet — let the transition overlay cover the screen first
        // to prevent a flash of the uninitialized game scene
        const needCloseLobby = !scene.isWarmup;
        scene.startOnlineMatch(
          playerId,
          seed,
          usernames,
          mapIndex,
          totalRounds,
          characters,
          needCloseLobby ? closeLobby : undefined,
        );
        applyAudioSettings(scene);
        if (isTouchDevice) touchControls.show();
        scene.onLocalInput = (input, tick) => {
          networkManager?.sendInput(input, tick);
        };
      },

      onState(state, lastButtons) {
        const scene = getGameScene();
        if (scene) {
          if (networkManager) scene.setNetworkRtt(networkManager.rtt);
          scene.receiveState(state, lastButtons);
        }
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

      onEnded(winner, _scores, _roundWins, _roomId, _mode) {
        // Suppress when in tournament (tournament_match_end handles this)
        if (currentTournamentId) return;

        const scene = getGameScene();
        if (scene) scene.endOnlineMatch(winner);

        // Show result screen, then transition to lobby
        // If we're on a foreign region (cross-region join), switch back to home
        const returnToLobby = async () => {
          const homeId = regionManager.homeRegionId;
          if (homeId && homeId !== activeRegionId) {
            const homeRegion = regionManager.getRegionById(homeId);
            if (homeRegion) await switchToRegion(homeRegion);
          }
          openLobby();
        };
        setTimeout(() => {
          if (scene) {
            scene.playTransition(() => void returnToLobby());
          } else {
            void returnToLobby();
          }
        }, 2500);
      },

      onError(message) {
        lobbyStatus.textContent = `Error: ${message}`;
        setLobbyButtons(true);
      },

      onDisconnect() {
        lobbyStatus.textContent = "Disconnected from server. Reconnecting...";
        setLobbyButtons(false);
        // Clean up tournament state
        if (currentTournamentId) {
          hideAllTournamentOverlays();
          currentTournamentId = null;
          tournamentSpectating = false;
          const scene = getGameScene();
          if (scene?.isSpectating) scene.stopSpectating();
        }
      },

      onReconnect() {
        lobbyStatus.textContent = "";
        setLobbyButtons(true);
        // Re-send identity so the server knows who we are
        if (currentUsername) networkManager?.sendSetUsername(currentUsername);
        const walletAddr = getConnectedAddress();
        if (walletAddr) networkManager?.sendSetWallet(walletAddr);
      },

      // ── Tournament callbacks ──────────────────────────────
      onTournamentLobby(msg) {
        renderTournamentLobby(msg);
      },

      onTournamentMatchStart(
        matchLabel,
        matchIndex,
        role,
        playerId,
        seed,
        usernames,
        mapIndex,
        totalRounds,
        characters,
        bracket,
      ) {
        // Clear previous match visuals immediately to prevent flash
        const scene = getGameScene();
        if (scene) {
          scene.clearVisuals();
          scene.endOnlineMatch(-1, true);
        }

        // Animation flow:
        // 1. Show full bracket (0.4s fade in)
        // 2. Zoom into highlighted match (0.6s)
        // 3. VS overlay with names (1s)
        // 4. Fade out → start game
        // Total: ~2.8s (server MATCH_INTRO_MS = 3s gives buffer)

        hideAllTournamentOverlays();
        bracketOverlay.classList.add("visible");
        renderBracket(bracket, matchIndex);

        // Stage 1: Bracket appears with scale-in
        const canvas = bracketGrid.querySelector(".bk-canvas") as HTMLElement;
        if (canvas) {
          canvas.style.transition = "none";
          canvas.style.opacity = "0";
          canvas.style.transform = "scale(0.8)";
          requestAnimationFrame(() => {
            canvas.style.transition = "opacity 0.3s, transform 0.4s ease-out";
            canvas.style.opacity = "1";
            canvas.style.transform = "scale(1)";
          });
        }

        // Stage 2: After 0.8s, zoom into the highlighted match
        tournamentTimers.push(
          setTimeout(() => {
            const matchEl = bracketGrid.querySelector(`[data-mi="${matchIndex}"]`) as HTMLElement;
            if (matchEl && canvas) {
              const canvasRect = canvas.getBoundingClientRect();
              const matchRect = matchEl.getBoundingClientRect();
              const cx = matchRect.left + matchRect.width / 2 - canvasRect.left;
              const cy = matchRect.top + matchRect.height / 2 - canvasRect.top;
              const ox = (cx / canvasRect.width) * 100;
              const oy = (cy / canvasRect.height) * 100;
              canvas.style.transformOrigin = `${ox}% ${oy}%`;
              canvas.style.transition = "transform 0.6s ease-in-out, opacity 0.6s";
              canvas.style.transform = "scale(2.5)";
              canvas.style.opacity = "0.3";
            }
          }, 800),
        );

        // Stage 3: VS overlay
        tournamentTimers.push(
          setTimeout(() => {
            const vsOverlay = document.createElement("div");
            vsOverlay.className = "bk-vs-overlay";
            vsOverlay.innerHTML = `
            <div class="bk-vs-label">${escapeHtml(matchLabel.toUpperCase())}</div>
            <div class="bk-vs-names">
              <span class="bk-vs-p1">${escapeHtml(usernames[0])}</span>
              <span class="bk-vs-vs">VS</span>
              <span class="bk-vs-p2">${escapeHtml(usernames[1])}</span>
            </div>
          `;
            bracketOverlay.appendChild(vsOverlay);
            requestAnimationFrame(() => vsOverlay.classList.add("visible"));
          }, 1600),
        );

        // Stage 4: Start the game
        tournamentTimers.push(
          setTimeout(() => {
            hideAllTournamentOverlays();
            bracketOverlay.querySelectorAll(".bk-vs-overlay").forEach((el) => el.remove());

            const scene = getGameScene();
            if (!scene) return;

            if (role === "fighter" && playerId !== undefined) {
              tournamentSpectating = false;
              networkManager?.resetThrottle();
              scene.startOnlineMatch(playerId, seed, usernames, mapIndex, totalRounds, characters);
              applyAudioSettings(scene);
              scene.onLocalInput = (input, tick) => {
                networkManager?.sendInput(input, tick);
              };
            } else {
              tournamentSpectating = true;
              scene.startSpectating(seed, usernames, mapIndex, totalRounds, characters);
              applyAudioSettings(scene);
              spectateLabel.textContent = `SPECTATING • ${matchLabel}`;
            }
          }, 2800),
        );
      },

      onSpectateState(state, lastButtons) {
        const scene = getGameScene();
        if (scene) scene.receiveSpectateState(state, lastButtons);
      },

      onSpectateRoundEnd(round, winner, roundWins) {
        const scene = getGameScene();
        if (scene) scene.handleRoundEnd(round, winner, roundWins);
      },

      onSpectateRoundStart(round, seed, mapIndex) {
        const scene = getGameScene();
        if (scene) scene.startNewRound(seed, mapIndex, round);
      },

      onTournamentMatchEnd(matchIndex, matchLabel, winnerName, bracket) {
        const scene = getGameScene();
        if (scene) {
          if (tournamentSpectating) {
            scene.stopSpectating();
          } else {
            scene.endOnlineMatch(-1, true); // silent — bracket overlay shows result
          }
          scene.clearVisuals(); // prevent flash of old match
        }
        // Show bracket between matches
        hideAllTournamentOverlays();
        bracketOverlay.classList.add("visible");
        renderBracket(bracket);
      },

      onTournamentEnd(standings, _bracket) {
        const scene = getGameScene();
        if (scene) {
          if (tournamentSpectating) scene.stopSpectating();
          else scene.endOnlineMatch(-1, true);
          scene.clearVisuals();
        }
        hideAllTournamentOverlays();
        tournamentResults.classList.add("visible");
        renderStandings(standings);

        // Return to lobby (and home region if cross-region) after 8s
        setTimeout(() => {
          hideAllTournamentOverlays();
          currentTournamentId = null;
          currentTournamentSlot = -1;
          _currentTournamentHostSlot = -1;
          tournamentSpectating = false;
          void (async () => {
            const homeId = regionManager.homeRegionId;
            if (homeId && homeId !== activeRegionId) {
              const homeRegion = regionManager.getRegionById(homeId);
              if (homeRegion) await switchToRegion(homeRegion);
            }
            openLobby();
          })();
        }, 8000);
      },
    });

    networkManager.connect(url);

    // Once connected, set username and open lobby
    let resolved = false;
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
        if (!inTutorialFlow) openLobby();
        if (!resolved) {
          resolved = true;
          resolveConnect();
        }
      }
    }, 100);

    // Safety timeout: stop polling after 10s and show error
    setTimeout(() => {
      clearInterval(waitForConnect);
      if (!networkManager?.connected) {
        lobbyStatus.textContent = "Could not connect to server. Check your connection and try again.";
        setLobbyButtons(true);
      }
      if (!resolved) {
        resolved = true;
        resolveConnect();
      }
    }, 10000);
  }); // end Promise
}

// ── Button handlers ────────────────────────────────────────────────────────────

/** Verify wallet for ranked play. Returns true if verified or not needed (casual + not forced). */
async function ensureRankedReady(forceVerify = false): Promise<boolean> {
  if (!forceVerify && currentMode !== "ranked") return true;
  const addr = getConnectedAddress();
  if (!addr) {
    lobbyStatus.textContent = "Connect a wallet to play ranked.";
    return false;
  }
  if (lastVerifiedAddr === addr) return true;
  lobbyStatus.textContent = "Registering wallet...";
  setLobbyButtons(false);
  try {
    const ok = await verifyWallet(addr);
    setLobbyButtons(true);
    if (ok) {
      lobbyStatus.textContent = "";
    } else {
      lobbyStatus.textContent = "Wallet registration failed. Try again or switch to Casual.";
    }
    return ok;
  } catch (err) {
    console.warn("[wallet] ensureRankedReady error:", err);
    lobbyStatus.textContent = "Wallet registration failed. Please try again.";
    setLobbyButtons(true);
    return false;
  }
}

quickplayBtn.addEventListener("click", () => {
  void ensureRankedReady().then(async (ok) => {
    if (!ok) return;
    // Check if another reachable region already has a waiting room
    const targetRegion = regionManager.findRegionWithWaitingRoom(currentMode);
    if (targetRegion && targetRegion.id !== activeRegionId) {
      await switchToRegion(targetRegion);
    }
    if (!networkManager?.connected) {
      // Queue for when connection is ready
      pendingQuickplay = true;
      lobbyStatus.textContent = "Connecting...";
      setLobbyButtons(false);
      return;
    }
    pendingCharacter = homeCharacter;
    networkManager.sendQuickplay(currentMode, pendingCharacter, awayCharacter);
    lobbyStatus.textContent = "";
    setLobbyButtons(false);
  });
});

createPublicBtn.addEventListener("click", () => {
  if (!networkManager?.connected) return;
  void ensureRankedReady().then((ok) => {
    if (!ok || !networkManager?.connected) return;
    pendingCharacter = homeCharacter;
    networkManager.sendCreate(false, currentMode, pendingCharacter, awayCharacter);
    lobbyStatus.textContent = `Creating ${currentMode} public match...`;
    setLobbyButtons(false);
  });
});

createPrivateBtn.addEventListener("click", () => {
  if (!networkManager?.connected) return;
  void ensureRankedReady().then((ok) => {
    if (!ok || !networkManager?.connected) return;
    pendingCharacter = homeCharacter;
    networkManager.sendCreate(true, currentMode, pendingCharacter, awayCharacter);
    lobbyStatus.textContent = `Creating ${currentMode} private match...`;
    setLobbyButtons(false);
  });
});

joinCodeBtn.addEventListener("click", () => {
  const code = joinCodeInput.value.trim().toUpperCase();
  if (code.length !== 5) {
    lobbyStatus.textContent = "Join code must be 5 letters.";
    return;
  }

  void (async () => {
    // Room mode unknown from code alone — verify wallet if connected but not yet
    // verified, so ranked rooms work. No-op if already verified or no wallet.
    const addr = getConnectedAddress();
    if (addr && lastVerifiedAddr !== addr) {
      const ok = await ensureRankedReady(true);
      if (!ok) return;
    }

    // Check if we can see this code in any region's room list (public rooms)
    let targetRegion = regionManager.findRegionWithCode(code);
    // Fallback: query all servers via HTTP (finds private rooms + tournaments)
    if (!targetRegion) {
      targetRegion = await regionManager.resolveCodeAcrossRegions(code);
    }
    if (targetRegion && targetRegion.id !== activeRegionId) {
      await switchToRegion(targetRegion);
    }

    if (!networkManager?.connected) return;
    pendingCharacter = homeCharacter;
    networkManager.sendJoinByCode(code, pendingCharacter, awayCharacter);
    lobbyStatus.textContent = `Joining with code ${code}...`;
    setLobbyButtons(false);
  })();
});

joinCodeInput.addEventListener("keydown", (e) => {
  e.stopPropagation(); // prevent game keybinds while typing
  if (e.key === "Enter") {
    joinCodeBtn.click();
  }
});
joinCodeInput.addEventListener("keyup", (e) => e.stopPropagation());

// ── More menu (⋯) dropdown ───────────────────────────────────────────────────

moreMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  moreMenuDropdown.classList.toggle("visible");
});
moreMenuDropdown.addEventListener("click", (e) => e.stopPropagation());

menuTournament.addEventListener("click", () => {
  moreMenuDropdown.classList.remove("visible");
  if (!networkManager?.connected) return;
  networkManager.sendCreateTournament({ bracketType: "partial_consolation", matchFormat: "bo5" });
  lobbyStatus.textContent = "Creating tournament...";
});

menuTutorial.addEventListener("click", () => {
  moreMenuDropdown.classList.remove("visible");
  closeLobby();
  const scene = getGameScene();
  if (scene) {
    scene.startTutorial(
      tutorial,
      () => {
        openLobby();
      },
      pendingCharacter,
    );
    applyAudioSettings(scene);
    if (isTouchDevice) touchControls.show();
    tutorial.start(() => {
      scene.stopTutorial();
    });
  }
});

// ── Settlement Flow (Ranked) ─────────────────────────────────────────────────

async function handleSettleMatch(matchId: string, regionUrl?: string) {
  const origin = regionUrl || networkManager?.httpOrigin;
  if (!origin) return;
  const addr = getConnectedAddress();
  if (!addr) {
    lobbyStatus.textContent = "Connect wallet to settle on-chain.";
    return;
  }

  // Disable settle button to prevent double-clicks
  const settleBtn = matchHistoryList.querySelector<HTMLButtonElement>(
    `[data-action="settle"][data-match-id="${matchId}"]`,
  );
  if (settleBtn) settleBtn.disabled = true;

  try {
    lobbyStatus.textContent = "Fetching proof...";
    const proofRes = await fetch(`${origin}/api/matches/${matchId}/proof`);
    if (!proofRes.ok) {
      lobbyStatus.textContent = "Proof not available yet.";
      return;
    }
    const proof = await proofRes.json();

    lobbyStatus.textContent = "Fetching match details...";
    const detailRes = await fetch(`${origin}/api/matches/${matchId}/detail`);
    if (!detailRes.ok) {
      lobbyStatus.textContent = "Could not load match details.";
      return;
    }
    const detail = await detailRes.json();
    const numericId = detail.sessionId as number;
    if (numericId === null || numericId === undefined) {
      lobbyStatus.textContent = "Session ID not available.";
      return;
    }
    lobbyStatus.textContent = "Signing settlement transaction...";
    const hexToBytes = (hex: string) => {
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
      }
      return bytes;
    };
    const seal = hexToBytes(proof.seal);
    const journal = hexToBytes(proof.journal);

    const txHash = await settleMatch(numericId, seal, journal);

    // Notify server with the on-chain tx hash
    if (txHash) {
      await fetch(`${origin}/api/matches/${matchId}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash }),
      });
    }
    lobbyStatus.textContent = "Match settled on-chain!";
    if (activeTab === "history") fetchMatchHistory();
  } catch (err) {
    lobbyStatus.textContent = `Settlement failed: ${(err as Error).message}`;
  } finally {
    if (settleBtn) settleBtn.disabled = false;
  }
}

// ── Replay exit handler ──────────────────────────────────────────────────────

window.addEventListener("replayEnded", () => {
  openLobby();
});

// ── URL Deep Links ────────────────────────────────────────────────────────────

{
  const params = new URLSearchParams(window.location.search);
  const joinCode = params.get("join");
  const replayId = params.get("replay");
  const replayRegion = params.get("region");

  // Clear params from URL
  if (joinCode || replayId) {
    history.replaceState(null, "", window.location.pathname);
  }

  if (joinCode) {
    // Skip if this was the user's own room (e.g. page refresh) — room is gone
    const lastOwnCode = localStorage.getItem("chickenz-last-join-code");
    if (lastOwnCode && lastOwnCode.toUpperCase() === joinCode.toUpperCase()) {
      localStorage.removeItem("chickenz-last-join-code");
    } else {
      // Auto-join via code after connection is ready
      const waitJoin = setInterval(() => {
        if (networkManager?.connected) {
          clearInterval(waitJoin);
          pendingCharacter = homeCharacter;
          const upperCode = joinCode.toUpperCase();
          lobbyStatus.textContent = `Joining with code ${upperCode}...`;
          setLobbyButtons(false);
          void (async () => {
            // Check lobby cache first (public rooms), then HTTP resolve (private/tournaments)
            let targetRegion = regionManager.findRegionWithCode(upperCode);
            if (!targetRegion) {
              targetRegion = await regionManager.resolveCodeAcrossRegions(upperCode);
            }
            if (targetRegion && targetRegion.id !== activeRegionId) {
              await switchToRegion(targetRegion);
            }
            networkManager?.sendJoinByCode(upperCode, pendingCharacter, awayCharacter);
          })();
        }
      }, 200);
      setTimeout(() => clearInterval(waitJoin), 10000);
    } // end else (not own room)
  } else if (replayId) {
    // Auto-load replay after connection is ready
    const waitReplay = setInterval(() => {
      if (networkManager?.connected) {
        clearInterval(waitReplay);
        // If region specified and different from current, switch first
        if (replayRegion) {
          const targetRegion = regionManager.getRegionById(replayRegion);
          if (targetRegion && replayRegion !== activeRegionId) {
            void switchToRegion(targetRegion).then(() => startReplay(replayId));
            return;
          }
        }
        startReplay(replayId);
      }
    }, 200);
    setTimeout(() => clearInterval(waitReplay), 10000);
  }
}
