import Phaser from "phaser";
import { gameConfig, recalcDimensions } from "./game";
import { GameScene } from "./scenes/GameScene";
import { friendlyKeyName, type KeyBindings } from "./input/InputManager";
import { TouchControls } from "./input/TouchControls";
import { Tutorial } from "./tutorial/Tutorial";
import { initChickenzWasm } from "./wasm";

import { NetworkManager, type RoomInfo, type GameMode, type TournamentBracket } from "./net/NetworkManager";
import { RegionManager, type RegionPing, type RegionRoomInfo } from "./net/RegionManager";
import { getRegions, type RegionConfig } from "./net/regions";

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

interface MatchRecord {
  id: string;
  roomName: string;
  player1: string;
  player2: string;
  wallet1?: string;
  wallet2?: string;
  wallet1Verified?: boolean;
  wallet2Verified?: boolean;
  winner: number;
  scores: [number, number];
  timestamp: number;
  proofStatus: "none" | "pending" | "proving" | "verified" | "settled";
  roomId: string;
  mode?: GameMode;
  matchStartTime?: number;
  proofRequestedAt?: number;
  proofCompletedAt?: number;
  proofSource?: string;
  startTxHash?: string;
  settleTxHash?: string;
  proofArtifacts?: { seal: string; journal: string; imageId: string };
  contractAddress?: string;
  verifierAddress?: string;
  gameHubAddress?: string;
  transcriptCid?: string;
  boundlessRequestId?: string;
  boundlessTxHash?: string;
  sessionId?: number;
}

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
  const name = generateAnimalName();
  localStorage.setItem("chickenz-username", name);
  return name;
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

// Always skip gate — generate name if needed, go straight to lobby
{
  const name = getOrCreateUsername();
  currentUsername = name;
  topBarUsername.textContent = name;

  // Init regions: connect to cached region instantly, measure pings in background
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
    const bestRegion = regionManager.getBestRegion();

    // 3. If best region differs from cached (or no cache), switch
    if (bestRegion.id !== activeRegionId) {
      activeRegionId = bestRegion.id;
      regionManager.activeRegionId = bestRegion.id;
      await connectToServer(bestRegion.wsUrl);
      if (!cached) flushPendingActions();
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
  // If cached address exists, user is already "logged in" — SDK restore is best-effort for signing.
  initPasskeyKit()
    .then(() =>
      connectWallet()
        .then((addr) => {
          if (addr) updateWalletUI();
          // If SDK restore failed but we have a cached address, don't disrupt the UI
        })
        .catch(() => {
          // SDK failed to connect — that's OK, cached address keeps user logged in
          if (!cachedAddr) updateWalletUI();
        }),
    )
    .catch(() => {
      if (!cachedAddr) updateWalletUI();
    });

  // Init touch controls + tutorial
  if (isTouchDevice) touchControls.init();
  tutorial.init(isTouchDevice);

  // Show tutorial prompt for first-time users (before lobby)
  if (Tutorial.shouldShow()) {
    const tutorialOverlay = document.getElementById("tutorial-overlay")!;
    const tutorialPrompt = document.getElementById("tutorial-prompt")!;
    tutorialOverlay.style.display = "block";
    tutorialPrompt.style.display = "block";

    document.getElementById("btn-tutorial-play")?.addEventListener("click", () => {
      tutorialPrompt.style.display = "none";
      closeLobby();
      const scene = getGameScene();
      if (scene) {
        // GameScene.stopTutorial() calls this callback when done
        scene.startTutorial(
          tutorial,
          () => {
            openLobby();
          },
          pendingCharacter,
        );
        applyAudioSettings(scene);
        if (isTouchDevice) touchControls.show();
        // Tutorial.complete() calls this callback when steps finish → triggers stopTutorial
        tutorial.start(() => {
          scene.stopTutorial();
        });
      }
    });

    document.getElementById("btn-tutorial-skip")?.addEventListener("click", () => {
      Tutorial.markDone();
      tutorialOverlay.style.display = "none";
      tutorialPrompt.style.display = "none";
    });
  }
}

// Wallet disconnect just updates UI — user keeps playing as casual

// ── Wallet Connect ──────────────────────────────────────────────────────────

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

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
  void createWallet(getOrCreateUsername()).finally(() => {
    walletRegisterBtn.disabled = false;
    walletRegisterBtn.textContent = "Register";
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

// Build tiled border around settings card using terrain spritesheet
function buildSettingsFrame() {
  const frame = document.getElementById("settings-frame")!;
  const card = document.getElementById("settings-card")!;
  // Terrain spritesheet: 22 cols, 16x16 tiles
  const COLS = 22;
  const TILE = 16;
  // Frame indices: (col, row) → row * 22 + col
  const TOP_L = 4 * COLS + 12; // (12,4)
  const TOP_M = 4 * COLS + 13; // (13,4)
  const TOP_R = 4 * COLS + 14; // (14,4)
  const SIDE_T = 4 * COLS + 15; // (15,4)
  const SIDE_M = 5 * COLS + 15; // (15,5)
  const SIDE_B = 6 * COLS + 15; // (15,6)

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── Leaderboard ──────────────────────────────────────────────────────────────

function fetchLeaderboard() {
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
  const regions = getRegions();
  const fetches = regions.map((r) =>
    fetch(`${r.httpUrl}/api/matches`)
      .then((res) => res.json() as Promise<MatchRecord[]>)
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
        ${showSettle ? `<button class="btn btn-sm btn-primary btn-settle" data-match-id="${escapeHtml(m.id)}">Settle</button>` : ""}
        <button class="btn btn-sm btn-replay" data-room-id="${escapeHtml(m.roomId)}">Replay</button>
        <button class="btn btn-sm btn-share" data-room-id="${escapeHtml(m.roomId)}" data-region="${escapeHtml(activeRegionId)}">Share</button>
        <button class="btn btn-sm btn-download" data-room-id="${escapeHtml(m.roomId)}">DL</button>
      </div>
    `;
    const replayBtn = el.querySelector(".btn-replay");
    if (replayBtn) {
      replayBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        startReplay(m.roomId);
      });
    }
    const shareBtn = el.querySelector(".btn-share");
    if (shareBtn) {
      shareBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const region = (shareBtn as HTMLElement).dataset.region || activeRegionId;
        void navigator.clipboard
          .writeText(`${window.location.origin}/?replay=${m.roomId}&region=${region}`)
          .then(() => {
            (shareBtn as HTMLElement).textContent = "Copied!";
            setTimeout(() => {
              (shareBtn as HTMLElement).textContent = "Share";
            }, 1500);
          });
      });
    }
    const downloadBtn = el.querySelector(".btn-download");
    if (downloadBtn) {
      downloadBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        downloadTranscript(m.roomId);
      });
    }
    const settleBtn = el.querySelector(".btn-settle");
    if (settleBtn) {
      settleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void handleSettleMatch(m.id);
      });
    }
    // Click row to open detail
    el.addEventListener("click", (e) => {
      // Don't open detail if clicking a button
      if ((e.target as HTMLElement).closest("button")) return;
      openMatchDetail(m.id);
    });
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

function startReplay(roomId: string) {
  if (!networkManager) return;
  const origin = networkManager.httpOrigin;
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

// ── Match Detail Modal ────────────────────────────────────────────────────────

function openMatchDetail(matchId: string) {
  if (!networkManager) return;
  const origin = networkManager.httpOrigin;
  fetch(`${origin}/api/matches/${matchId}/detail`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((m: MatchRecord) => {
      renderMatchDetail(m);
      matchDetailOverlay.classList.add("visible");
    })
    .catch((err) => {
      console.error("[detail] Failed to load match details:", err);
      lobbyStatus.textContent = "Failed to load match details.";
    });
}

function formatTimestamp(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(startMs: number, endMs: number): string {
  const s = Math.round((endMs - startMs) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function explorerTxUrl(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(hash)}`;
}

function explorerAccountUrl(addr: string): string {
  return `https://stellar.expert/explorer/testnet/account/${encodeURIComponent(addr)}`;
}

function explorerContractUrl(addr: string): string {
  return `https://stellar.expert/explorer/testnet/contract/${encodeURIComponent(addr)}`;
}

const GUEST_IMAGE_ID = "c69a2804afae47c1bee35e0a80013d9dad8a4f096d1b5bfa53d870c8e8d43746";

function renderDataAvailability(m: MatchRecord): string {
  const rows: string[] = [];
  if (m.transcriptCid) {
    const ipfsUrl = `https://gateway.pinata.cloud/ipfs/${m.transcriptCid}`;
    rows.push(
      `<div class="dpg-row"><span class="dpg-label">Input (IPFS)</span><span class="dpg-value"><a href="${ipfsUrl}" target="_blank" rel="noopener">${escapeHtml(m.transcriptCid.slice(0, 16))}...</a></span></div>`,
    );
  }
  // Program image ID (the zkVM guest binary hash)
  rows.push(
    `<div class="dpg-row"><span class="dpg-label">Program ID</span><span class="dpg-value" title="${GUEST_IMAGE_ID}">${GUEST_IMAGE_ID.slice(0, 16)}...</span></div>`,
  );
  if (m.boundlessTxHash) {
    const etherscanUrl = `https://sepolia.etherscan.io/tx/${encodeURIComponent(m.boundlessTxHash)}`;
    rows.push(
      `<div class="dpg-row"><span class="dpg-label">Proof Request TX</span><span class="dpg-value"><a href="${etherscanUrl}" target="_blank" rel="noopener">${escapeHtml(m.boundlessTxHash.slice(0, 16))}...</a></span></div>`,
    );
  }
  if (m.boundlessRequestId) {
    const boundlessExplorerUrl = `https://explorer.boundless.network/orders/0x${m.boundlessRequestId}`;
    rows.push(
      `<div class="dpg-row"><span class="dpg-label">Boundless Order</span><span class="dpg-value"><a href="${boundlessExplorerUrl}" target="_blank" rel="noopener">${escapeHtml(m.boundlessRequestId.slice(0, 16))}...</a></span></div>`,
    );
  }
  if (rows.length <= 1) return ""; // only program ID, no proof data
  return `
    <div class="detail-section">
      <h3>Data Availability</h3>
      <div class="detail-proof-grid">
        ${rows.join("")}
      </div>
    </div>
  `;
}

function renderMatchDetail(m: MatchRecord) {
  const winnerName = m.winner === 0 ? m.player1 : m.winner === 1 ? m.player2 : "Draw";
  const modeBadge =
    m.mode === "ranked"
      ? `<span class="mode-badge ranked">Ranked</span>`
      : `<span class="mode-badge casual">Casual</span>`;

  // Players section
  const renderPlayer = (name: string, wallet: string | undefined, verified: boolean | undefined, isWinner: boolean) => {
    const walletHtml = wallet
      ? `<div class="dp-wallet"><a href="${explorerAccountUrl(wallet)}" target="_blank" rel="noopener">${truncateAddress(wallet)}</a>${verified ? '<span class="dp-verified">&#10003; verified</span>' : ""}</div>`
      : `<div class="dp-wallet" style="color:#555">No wallet</div>`;
    return `
      <div class="detail-player${isWinner ? " winner" : ""}">
        <div class="dp-name">${escapeHtml(name)}${isWinner ? '<span class="dp-winner-tag">Winner</span>' : ""}</div>
        ${walletHtml}
      </div>
    `;
  };

  // Timeline steps
  const steps: string[] = [];
  const addStep = (label: string, ts: number | undefined, extra: string = "", status?: string) => {
    const st = status || (ts ? "done" : "pending");
    const timeStr = ts ? `<span class="tl-time">${formatTimestamp(ts)}</span>` : "";
    steps.push(`<div class="tl-step ${st}"><span class="tl-label">${label}</span>${timeStr}${extra}</div>`);
  };

  addStep("Match Started", m.matchStartTime);

  // On-chain start_match / start_game happen right after match starts
  if (m.mode === "ranked" && m.startTxHash) {
    addStep(
      "start_match TX",
      m.matchStartTime,
      `<span class="tl-badge">Chickenz</span><a class="tl-link" href="${explorerTxUrl(m.startTxHash)}" target="_blank" rel="noopener">View TX</a>`,
    );
    addStep(
      "start_game TX",
      m.matchStartTime,
      `<span class="tl-badge">Game Hub</span><a class="tl-link" href="${explorerTxUrl(m.startTxHash)}" target="_blank" rel="noopener">View TX</a>`,
    );
  }

  if (m.timestamp) {
    const duration = m.matchStartTime
      ? `<span class="tl-duration">${formatDuration(m.matchStartTime, m.timestamp)}</span>`
      : "";
    addStep("Match Ended", m.timestamp, duration);
  }

  if (m.mode === "ranked") {
    const boundlessTxLink = m.boundlessTxHash
      ? `<a class="tl-link" href="https://sepolia.etherscan.io/tx/${encodeURIComponent(m.boundlessTxHash)}" target="_blank" rel="noopener">View TX</a>`
      : "";
    addStep(
      "Proof Requested",
      m.proofRequestedAt,
      boundlessTxLink,
      m.proofRequestedAt ? "done" : m.proofStatus !== "none" ? "active" : "pending",
    );

    if (m.proofCompletedAt) {
      const proveDur = m.proofRequestedAt
        ? `<span class="tl-duration">${formatDuration(m.proofRequestedAt, m.proofCompletedAt)}</span>`
        : "";
      const sourceLabel =
        m.proofSource === "worker" ? "Self-Hosted" : m.proofSource === "boundless" ? "Boundless" : m.proofSource;
      const sourceBadge = sourceLabel ? `<span class="tl-badge">${escapeHtml(sourceLabel)}</span>` : "";
      addStep("Proof Generated", m.proofCompletedAt, `${sourceBadge}${proveDur}`);
      addStep("Proof Verified", m.proofCompletedAt, "", "done");
    } else if (m.proofStatus === "proving") {
      const boundlessExtra = m.boundlessRequestId
        ? `<a href="https://explorer.boundless.network/orders/0x${m.boundlessRequestId}" target="_blank" rel="noopener" class="tl-badge">Boundless: ${escapeHtml(m.boundlessRequestId.slice(0, 12))}...</a>`
        : "";
      addStep("Proof Generating...", undefined, boundlessExtra, "active");
    } else if (m.proofStatus === "pending") {
      addStep("Proof Generating...", undefined, "", "pending");
    }

    // On-chain settlement steps — always show as pending placeholders if not yet reached
    if (m.settleTxHash) {
      addStep(
        "settle_match TX",
        m.proofCompletedAt,
        `<span class="tl-badge">Chickenz</span><a class="tl-link" href="${explorerTxUrl(m.settleTxHash)}" target="_blank" rel="noopener">View TX</a>`,
      );
      addStep(
        "end_game TX",
        m.proofCompletedAt,
        `<span class="tl-badge">Game Hub</span><a class="tl-link" href="${explorerTxUrl(m.settleTxHash)}" target="_blank" rel="noopener">View TX</a>`,
      );
    } else if (m.proofStatus === "settled") {
      addStep("settle_match TX", undefined, "", "done");
      addStep("end_game TX", undefined, "", "done");
    } else if (m.proofStatus === "verified") {
      addStep("Settlement Pending...", undefined, "", "active");
      addStep("end_game TX", undefined, "", "pending");
    } else {
      // Proof not yet complete — show remaining steps as pending
      addStep("Proof Verified", undefined, "", "pending");
      addStep("settle_match TX", undefined, "", "pending");
      addStep("end_game TX", undefined, "", "pending");
    }
  }

  // Proof details section
  let proofHtml = "";
  if (m.proofArtifacts && m.mode === "ranked") {
    const { seal, journal, imageId } = m.proofArtifacts;
    proofHtml = `
      <div class="detail-section">
        <h3>Proof Details</h3>
        <div class="detail-proof-grid">
          <div class="dpg-row"><span class="dpg-label">Image ID</span><span class="dpg-value">${imageId ? escapeHtml(imageId.slice(0, 16)) + "..." : "N/A"}</span></div>
          <div class="dpg-row"><span class="dpg-label">Seal</span><span class="dpg-value">${seal.length / 2} bytes</span></div>
          <div class="dpg-row"><span class="dpg-label">Journal</span><span class="dpg-value">${journal.length / 2} bytes</span></div>
          <div class="dpg-row"><span class="dpg-label">Status</span><span class="dpg-value"><span class="proof-badge ${m.proofStatus}">${escapeHtml(proofStatusLabel(m.proofStatus))}</span></span></div>
        </div>
      </div>
    `;
  }

  // Contract links section
  let contractsHtml = "";
  if (m.mode === "ranked" && m.contractAddress) {
    contractsHtml = `
      <div class="detail-section">
        <h3>Contracts</h3>
        <div class="detail-proof-grid">
          <div class="dpg-row"><span class="dpg-label">Game</span><span class="dpg-value"><a href="${explorerContractUrl(m.contractAddress)}" target="_blank" rel="noopener">${truncateAddress(m.contractAddress)}</a></span></div>
          <div class="dpg-row"><span class="dpg-label">Verifier</span><span class="dpg-value"><a href="${explorerContractUrl(m.verifierAddress!)}" target="_blank" rel="noopener">${truncateAddress(m.verifierAddress!)}</a></span></div>
          <div class="dpg-row"><span class="dpg-label">Game Hub</span><span class="dpg-value"><a href="${explorerContractUrl(m.gameHubAddress!)}" target="_blank" rel="noopener">${truncateAddress(m.gameHubAddress!)}</a></span></div>
        </div>
      </div>
    `;
  }

  matchDetailBody.innerHTML = `
    <div class="detail-section">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="color:#888;font-size:10px">${escapeHtml(m.id)}</span>
        ${modeBadge}
      </div>
      <div style="font-size:13px;color:#fff;margin-bottom:4px">${escapeHtml(winnerName)} wins  <span style="color:#888">${m.scores[0]}-${m.scores[1]}</span></div>
    </div>

    <div class="detail-section">
      <h3>Players</h3>
      <div class="detail-players">
        ${renderPlayer(m.player1, m.wallet1, m.wallet1Verified, m.winner === 0)}
        ${renderPlayer(m.player2, m.wallet2, m.wallet2Verified, m.winner === 1)}
      </div>
    </div>

    <div class="detail-section">
      <h3>Settlement Timeline</h3>
      <div class="detail-timeline">
        ${steps.join("")}
      </div>
    </div>

    ${proofHtml}
    ${contractsHtml}
    ${renderDataAvailability(m)}

    <div class="detail-actions">
      <button class="btn btn-sm btn-replay-detail" data-room-id="${escapeHtml(m.roomId)}">Replay</button>
      <button class="btn btn-sm btn-download-detail" data-room-id="${escapeHtml(m.roomId)}">Download</button>
    </div>
  `;

  // Bind action buttons
  const replayBtn = matchDetailBody.querySelector(".btn-replay-detail");
  if (replayBtn) {
    replayBtn.addEventListener("click", () => {
      matchDetailOverlay.classList.remove("visible");
      startReplay(m.roomId);
    });
  }
  const downloadBtn = matchDetailBody.querySelector(".btn-download-detail");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", () => {
      downloadTranscript(m.roomId);
    });
  }
}

// ── Tournament UI helpers ──────────────────────────────────────────────────────

function hideAllTournamentOverlays() {
  tournamentOverlay.classList.remove("visible");
  bracketOverlay.classList.remove("visible");
  spectateOverlay.classList.remove("visible");
  tournamentResults.classList.remove("visible");
}

function renderBracket(bracket: TournamentBracket, currentMatchIndex?: number) {
  bracketGrid.innerHTML = "";
  for (const m of bracket.matches) {
    const el = document.createElement("div");
    el.className = "bracket-match";
    if (m.winnerSlot !== -1) el.classList.add("completed");
    else if (currentMatchIndex !== undefined && m.matchIndex === currentMatchIndex) el.classList.add("current");

    // Determine player names for this match
    let p1: string, p2: string;
    if (m.matchIndex < 2) {
      // Semi-finals: fixed slots
      const slots = m.matchIndex === 0 ? [0, 1] : [2, 3];
      p1 = bracket.playerNames[slots[0]!] || "???";
      p2 = bracket.playerNames[slots[1]!] || "???";
    } else if (m.matchIndex === 2) {
      // Winners final
      const w0 = bracket.matches[0]?.winnerSlot ?? -1;
      const w1 = bracket.matches[1]?.winnerSlot ?? -1;
      p1 = w0 >= 0 ? bracket.playerNames[w0] || "???" : "TBD";
      p2 = w1 >= 0 ? bracket.playerNames[w1] || "???" : "TBD";
    } else {
      // Losers final
      const l0 = bracket.matches[0]?.loserSlot ?? -1;
      const l1 = bracket.matches[1]?.loserSlot ?? -1;
      p1 = l0 >= 0 ? bracket.playerNames[l0] || "???" : "TBD";
      p2 = l1 >= 0 ? bracket.playerNames[l1] || "???" : "TBD";
    }

    const winnerName = m.winnerSlot >= 0 ? bracket.playerNames[m.winnerSlot] || "???" : "";
    el.innerHTML = `
      <span class="match-label">${escapeHtml(m.matchLabel)}</span>
      <span class="match-players-text">${escapeHtml(p1)} vs ${escapeHtml(p2)}</span>
      <span class="match-winner">${winnerName ? escapeHtml(winnerName) + " ✓" : ""}</span>
    `;
    bracketGrid.appendChild(el);
  }
}

function renderStandings(standings: string[]) {
  const labels = ["1st", "2nd", "3rd", "4th"];
  standingsList.innerHTML = "";
  for (let i = 0; i < standings.length; i++) {
    const el = document.createElement("div");
    el.className = "standing-row";
    el.innerHTML = `<span class="place">${labels[i]}</span><span class="name">${escapeHtml(standings[i] || "???")}</span>`;
    standingsList.appendChild(el);
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
        setTimeout(() => {
          if (scene) {
            scene.playTransition(() => openLobby());
          } else {
            openLobby();
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
      onTournamentLobby(tournamentId, joinCode, players, status) {
        currentTournamentId = tournamentId;
        closeLobby();
        hideAllTournamentOverlays();
        tournamentOverlay.classList.add("visible");
        tournamentCode.textContent = joinCode;
        tournamentStatus.textContent =
          status === "playing"
            ? "Tournament in progress..."
            : status === "ended"
              ? "Tournament ended"
              : `Waiting for players... (${players.length}/4)`;
        tournamentPlayers.innerHTML = "";
        for (let i = 0; i < 4; i++) {
          const slot = document.createElement("div");
          slot.className = "tournament-slot" + (i < players.length ? " filled" : "");
          slot.textContent = i < players.length ? players[i]! : "...";
          tournamentPlayers.appendChild(slot);
        }
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
      ) {
        hideAllTournamentOverlays();
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
            scene.endOnlineMatch(-1); // suppress generic win text — bracket shows it
          }
        }
        // Show bracket between matches
        hideAllTournamentOverlays();
        bracketOverlay.classList.add("visible");
        renderBracket(bracket, matchIndex + 1); // highlight next match
      },

      onTournamentEnd(standings, _bracket) {
        const scene = getGameScene();
        if (scene) {
          if (tournamentSpectating) scene.stopSpectating();
          else scene.endOnlineMatch(-1);
        }
        hideAllTournamentOverlays();
        tournamentResults.classList.add("visible");
        renderStandings(standings);

        // Return to lobby after 8s
        setTimeout(() => {
          hideAllTournamentOverlays();
          currentTournamentId = null;
          tournamentSpectating = false;
          openLobby();
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
        openLobby();
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
  const ok = await verifyWallet(addr);
  setLobbyButtons(true);
  if (ok) {
    lobbyStatus.textContent = "";
  } else {
    lobbyStatus.textContent = "Wallet registration failed. Try again or switch to Casual.";
    setLobbyButtons(true);
  }
  return ok;
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
  networkManager.sendCreateTournament();
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
