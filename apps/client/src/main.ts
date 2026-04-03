import Phaser from "phaser";
import { gameConfig, recalcDimensions } from "./game";
import { GameScene } from "./scenes/GameScene";
import { TouchControls } from "./input/TouchControls";
import { Tutorial } from "./tutorial/Tutorial";
import { initChickenzWasm } from "./wasm";

import { type GameMode } from "./net/NetworkManager";
import { RegionManager, type RegionPing } from "./net/RegionManager";
import { getRegions, type RegionConfig } from "./net/regions";
import {
  truncateAddress,
  formatPing,
  pingClass,
} from "./ui/format";
import { buildTiledFrame } from "./ui/TiledFrame";
import { getOrCreateUsername } from "./ui/AnimalNameGenerator";
import { fetchLeaderboard } from "./ui/LeaderboardPanel";
import { fetchMatchHistory } from "./ui/MatchHistoryPanel";
import { initMatchActions } from "./ui/MatchActions";
import {
  hideAllTournamentOverlays,
  type TournamentPanelDeps,
} from "./ui/TournamentPanel";
import { session } from "./session";
import { connectToServer, type ServerConnectorDeps } from "./net/ServerConnector";
import { initSettingsPanel } from "./ui/SettingsPanel";
import { initWalletController } from "./ui/WalletController";
import { initLobbyPanel } from "./ui/LobbyPanel";

const NUM_CHARACTERS = 4;

// ── Character preferences (home/away) ────────────────────────────────────────
{
  let h = parseInt(localStorage.getItem("chickenz-home-char") ?? "0", 10);
  let a = parseInt(localStorage.getItem("chickenz-away-char") ?? "1", 10);
  if (!Number.isFinite(h) || h < 0 || h >= NUM_CHARACTERS) h = 0;
  if (!Number.isFinite(a) || a < 0 || a >= NUM_CHARACTERS) a = 1;
  if (a === h) a = (h + 1) % NUM_CHARACTERS;
  session.homeCharacter = h;
  session.awayCharacter = a;
  session.pendingCharacter = h;
}
import {
  initPasskeyKit,
  connectWallet,
  getConnectedAddress,
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

// Assigned after lobbyAPI/settingsAPI are initialized below; called only from switchToRegion and init flow.
let connectorDeps: ServerConnectorDeps | undefined;

// Tournament panel dependency object (lazily captures session.networkManager via closures)
const tournamentDeps: TournamentPanelDeps = {
  tournamentOverlay,
  bracketOverlay,
  bracketGrid,
  spectateOverlay,
  tournamentResults,
  standingsList,
  tournamentCode,
  tournamentStatus,
  tournamentPlayers,
  spectateLabel,
  onToggleRole: () => session.networkManager?.sendToggleRole(),
  onUpdateConfig: (config) => session.networkManager?.sendUpdateTournamentConfig(config),
  onStartTournament: () => session.networkManager?.sendStartTournament(),
  onCloseLobby: () => lobbyAPI.close(),
};

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

// ── Session state lives in session.ts ─────────────────────────────────────────
// (session.networkManager, session.currentUsername, session.currentMode, session.currentTournamentId,
//  session.tournamentSpectating, session.inTutorialFlow, session.pendingQuickplay, session.activeRegionId,
//  session.lastVerifiedAddr, session.verifyInProgress, session.homeCharacter, session.awayCharacter, session.pendingCharacter)

// ── Region Manager ────────────────────────────────────────────────────────────

const regionManager = new RegionManager(getRegions(), {
  onRoomsChanged: (rooms) => lobbyAPI.renderMergedRooms(rooms),
  onPingsUpdated: (pings) => updateRegionUI(pings),
});

// (session.activeRegionId lives in session.session.activeRegionId)

// Region selector DOM elements
const regionBtn = document.getElementById("btn-region") as HTMLButtonElement;
const regionFlag = document.getElementById("region-flag") as HTMLSpanElement;
const regionName = document.getElementById("region-name") as HTMLSpanElement;
const regionPing = document.getElementById("region-ping") as HTMLSpanElement;
const regionDropdown = document.getElementById("region-dropdown") as HTMLDivElement;

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
  if (session.activeRegionId === region.id && session.networkManager?.connected) return Promise.resolve();
  session.activeRegionId = region.id;
  regionManager.activeRegionId = region.id;
  // Invalidate verification state — different server means new challenge
  session.lastVerifiedAddr = null;
  // Update region UI immediately
  regionFlag.textContent = region.flag;
  regionName.textContent = region.name;
  const ping = regionManager.getPing(region.id);
  regionPing.textContent = formatPing(ping);
  regionPing.className = `region-ping ${pingClass(ping)}`;
  // Reconnect lobby streams so the new active region is excluded from duplicate WS
  regionManager.connectLobbyStreams();
  return connectToServer(region.wsUrl, connectorDeps!);
}

// ── Queued action flush ──────────────────────────────────────────────────────

/** Execute any actions the user attempted before the server connection was ready. */
function flushPendingActions() {
  if (session.pendingQuickplay && session.networkManager?.connected) {
    session.pendingQuickplay = false;
    session.pendingCharacter = session.homeCharacter;
    session.networkManager.sendQuickplay(session.currentMode, session.pendingCharacter, session.awayCharacter);
    lobbyStatus.textContent = "";
    lobbyAPI.setButtons(false);
  }
}

function saveUsername(name: string) {
  localStorage.setItem("chickenz-username", name);
  session.currentUsername = name;
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
      settingsAPI.applyAudioSettings(scene);
      scene.startBGM();
    }
  };
  window.addEventListener("click", startBGMOnce);
  window.addEventListener("keydown", startBGMOnce);
}

// Check for join URL param now (URL gets cleared later by deep link code)
const hasJoinParam = new URLSearchParams(window.location.search).has("join");

// Init gate — returning users go straight to lobby, new users get tutorial first
{
  const name = getOrCreateUsername();
  session.currentUsername = name;
  topBarUsername.textContent = name;

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
    .finally(() => walletAPI.updateWalletUI());

  // Init touch controls + tutorial
  if (isTouchDevice) touchControls.init();
  tutorial.init(isTouchDevice);

  // New users: show tutorial prompt
  if (Tutorial.shouldShow()) {
    session.inTutorialFlow = true;
    const tutorialOverlay = document.getElementById("tutorial-overlay")!;
    const tutorialPrompt = document.getElementById("tutorial-prompt")!;
    tutorialOverlay.style.display = "block";
    tutorialPrompt.style.display = "flex";

    const launchTutorial = () => {
      tutorialPrompt.style.display = "none";
      lobbyAPI.close();
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
          session.pendingCharacter,
        );
        settingsAPI.applyAudioSettings(scene);
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
      session.inTutorialFlow = false;
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

  session.inTutorialFlow = true;
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
    session.inTutorialFlow = false;
    if (session.networkManager?.connected) {
      session.networkManager.sendSetUsername(val);
    }
    lobbyAPI.open();
  };

  confirmBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

// Wallet disconnect just updates UI — user keeps playing as casual

// ── Mode Toggle ───────────────────────────────────────────────────────────────

function setMode(mode: GameMode) {
  session.currentMode = mode;
  localStorage.setItem("chickenz-mode", mode);
  modeCasualBtn.classList.toggle("active", mode === "casual");
  modeRankedBtn.classList.toggle("active", mode === "ranked");
}

// Restore saved mode preference
{
  const saved = localStorage.getItem("chickenz-mode") as GameMode | null;
  if (saved === "ranked" || saved === "casual") {
    session.currentMode = saved;
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

const settingsAPI = initSettingsPanel({
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
  charHomeName: document.getElementById("char-home-name") as HTMLSpanElement,
  charAwayName: document.getElementById("char-away-name") as HTMLSpanElement,
  matchDetailOverlay,
  getGameScene,
  getNetworkManager: () => session.networkManager,
  onSaveUsername: (name) => {
    session.currentUsername = name;
    topBarUsername.textContent = name;
  },
});

// Close settings/detail on Escape (multi-overlay handler stays in main.ts)
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (matchDetailOverlay.classList.contains("visible")) {
      matchDetailOverlay.classList.remove("visible");
      e.preventDefault();
      return;
    }
    if (settingsAPI.isOpen()) {
      settingsAPI.close();
      e.preventDefault();
    }
  }
});

// ── Back-to-lobby buttons ─────────────────────────────────────────────────────

document.getElementById("btn-warmup-back")!.addEventListener("click", () => {
  const scene = getGameScene();
  if (scene?.isWarmup) scene.stopWarmup();
  session.networkManager?.sendLeave();
  lobbyAPI.open();
});

document.getElementById("btn-add-bot")!.addEventListener("click", () => {
  session.networkManager?.sendAddBot();
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
  session.networkManager?.sendLeave();
  hideAllTournamentOverlays(tournamentDeps);
  session.currentTournamentId = null;
  session.currentTournamentSlot = -1;
  session.tournamentHostSlot = -1;
  session.tournamentSpectating = false;
  lobbyAPI.open();
});

// Feed touch controls into InputManager each frame
if (isTouchDevice) {
  const feedTouch = () => {
    const scene = getGameScene();
    const im = scene ? scene.inputManager : null;
    if (im) {
      im.setTouchState(touchControls.getTouchButtons(), touchControls.getAimX());
    }
    requestAnimationFrame(feedTouch);
  };
  requestAnimationFrame(feedTouch);
}

// Tutorial is now driven by GameScene.update() — no separate rAF loop needed

// ── Wallet Controller ─────────────────────────────────────────────────────────

const walletAPI = initWalletController({
  topBarAddress,
  walletLoginBtn,
  walletRegisterBtn,
  modeRankedBtn,
  lobbyStatus,
  matchHistoryList,
  setMode,
  renderRoomList: () => lobbyAPI.renderMergedRooms(regionManager.getMergedRooms()),
  setLobbyButtons: (enabled) => lobbyAPI.setButtons(enabled),
});

// ── Lobby Panel ───────────────────────────────────────────────────────────────

const lobbyAPI = initLobbyPanel({
  lobbyOverlay,
  lobbyStatus,
  joinCodeInput,
  quickplayBtn,
  createPublicBtn,
  createPrivateBtn,
  joinCodeBtn,
  roomListEl,
  matchHistoryList,
  leaderboardContent,
  isTouchDevice,
  getRegionManager: () => regionManager,
  getTouchControls: () => touchControls,
  getTutorial: () => tutorial,
  switchToRegion,
  onFetchLeaderboard: (container) => fetchLeaderboard(container, session.currentUsername),
  onFetchMatchHistory: (container) => fetchMatchHistory(container, matchHistoryCallbacks()),
  onJoinRoom: (_roomId, _regionId) => {
    /* handled inside createRoomElement via sendJoinRoom */
  },
  ensureRankedReady: (force) => walletAPI.ensureRankedReady(force),
  getConnectedAddress,
});

// ── Server Connector deps (assigned after all API objects are ready) ──────────

connectorDeps = {
  getGameScene,
  regionManager,
  lobbyAPI,
  settingsAPI,
  tournamentDeps,
  lobbyStatus,
  isTouchDevice,
  touchControls,
  switchToRegion,
};

// ── Region connect flow (runs after all deps are ready) ──────────────────────

void (async () => {
  // 1. Try cached home region for instant connect
  const cached = regionManager.getCachedHomeRegion();
  if (cached) {
    session.activeRegionId = cached.id;
    regionManager.activeRegionId = cached.id;
    await connectToServer(cached.wsUrl, connectorDeps!);
    flushPendingActions();
  }

  // 2. Measure pings in background (all regions in parallel)
  await regionManager.measurePings();

  // 3. If best region differs from cached (or no cache), switch —
  //    UNLESS a ?join= URL param is present (the deep link handler will
  //    switch to the correct region; switching here would kill the game connection)
  if (!hasJoinParam) {
    const bestRegion = regionManager.getBestRegion();
    if (bestRegion.id !== session.activeRegionId) {
      session.activeRegionId = bestRegion.id;
      regionManager.activeRegionId = bestRegion.id;
      await connectToServer(bestRegion.wsUrl, connectorDeps!);
      if (!cached) flushPendingActions();
    }
  }

  regionManager.connectLobbyStreams();
  regionManager.startPingRefresh();
})();

// ── Match Actions (replay, download, detail, settle) ─────────────────────────

const matchActions = initMatchActions({
  getGameScene,
  lobbyAPI,
  lobbyStatus,
  matchDetailOverlay,
  matchDetailBody,
  matchHistoryList,
});

// ── Leaderboard ──────────────────────────────────────────────────────────────

// ── Match History ──────────────────────────────────────────────────────────────

function matchHistoryCallbacks() {
  return matchActions.buildCallbacks();
}


// ── Button handlers ────────────────────────────────────────────────────────────

quickplayBtn.addEventListener("click", () => {
  void walletAPI.ensureRankedReady().then(async (ok) => {
    if (!ok) return;
    // Check if another reachable region already has a waiting room
    const targetRegion = regionManager.findRegionWithWaitingRoom(session.currentMode);
    if (targetRegion && targetRegion.id !== session.activeRegionId) {
      await switchToRegion(targetRegion);
    }
    if (!session.networkManager?.connected) {
      // Queue for when connection is ready
      session.pendingQuickplay = true;
      lobbyStatus.textContent = "Connecting...";
      lobbyAPI.setButtons(false);
      return;
    }
    session.pendingCharacter = session.homeCharacter;
    session.networkManager.sendQuickplay(session.currentMode, session.pendingCharacter, session.awayCharacter);
    lobbyStatus.textContent = "";
    lobbyAPI.setButtons(false);
  });
});

createPublicBtn.addEventListener("click", () => {
  if (!session.networkManager?.connected) return;
  void walletAPI.ensureRankedReady().then((ok) => {
    if (!ok || !session.networkManager?.connected) return;
    session.pendingCharacter = session.homeCharacter;
    session.networkManager.sendCreate(false, session.currentMode, session.pendingCharacter, session.awayCharacter);
    lobbyStatus.textContent = `Creating ${session.currentMode} public match...`;
    lobbyAPI.setButtons(false);
  });
});

createPrivateBtn.addEventListener("click", () => {
  if (!session.networkManager?.connected) return;
  void walletAPI.ensureRankedReady().then((ok) => {
    if (!ok || !session.networkManager?.connected) return;
    session.pendingCharacter = session.homeCharacter;
    session.networkManager.sendCreate(true, session.currentMode, session.pendingCharacter, session.awayCharacter);
    lobbyStatus.textContent = `Creating ${session.currentMode} private match...`;
    lobbyAPI.setButtons(false);
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
    if (addr && session.lastVerifiedAddr !== addr) {
      const ok = await walletAPI.ensureRankedReady(true);
      if (!ok) return;
    }

    // Check if we can see this code in any region's room list (public rooms)
    let targetRegion = regionManager.findRegionWithCode(code);
    // Fallback: query all servers via HTTP (finds private rooms + tournaments)
    if (!targetRegion) {
      targetRegion = await regionManager.resolveCodeAcrossRegions(code);
    }
    if (targetRegion && targetRegion.id !== session.activeRegionId) {
      await switchToRegion(targetRegion);
    }

    if (!session.networkManager?.connected) return;
    session.pendingCharacter = session.homeCharacter;
    session.networkManager.sendJoinByCode(code, session.pendingCharacter, session.awayCharacter);
    lobbyStatus.textContent = `Joining with code ${code}...`;
    lobbyAPI.setButtons(false);
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
  if (!session.networkManager?.connected) return;
  session.networkManager.sendCreateTournament({ bracketType: "partial_consolation", matchFormat: "bo5" });
  lobbyStatus.textContent = "Creating tournament...";
});

menuTutorial.addEventListener("click", () => {
  moreMenuDropdown.classList.remove("visible");
  lobbyAPI.close();
  const scene = getGameScene();
  if (scene) {
    scene.startTutorial(
      tutorial,
      () => {
        lobbyAPI.open();
      },
      session.pendingCharacter,
    );
    settingsAPI.applyAudioSettings(scene);
    if (isTouchDevice) touchControls.show();
    tutorial.start(() => {
      scene.stopTutorial();
    });
  }
});


// ── Replay exit handler ──────────────────────────────────────────────────────

window.addEventListener("replayEnded", () => {
  lobbyAPI.open();
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
        if (session.networkManager?.connected) {
          clearInterval(waitJoin);
          session.pendingCharacter = session.homeCharacter;
          const upperCode = joinCode.toUpperCase();
          lobbyStatus.textContent = `Joining with code ${upperCode}...`;
          lobbyAPI.setButtons(false);
          void (async () => {
            // Check lobby cache first (public rooms), then HTTP resolve (private/tournaments)
            let targetRegion = regionManager.findRegionWithCode(upperCode);
            if (!targetRegion) {
              targetRegion = await regionManager.resolveCodeAcrossRegions(upperCode);
            }
            if (targetRegion && targetRegion.id !== session.activeRegionId) {
              await switchToRegion(targetRegion);
            }
            session.networkManager?.sendJoinByCode(upperCode, session.pendingCharacter, session.awayCharacter);
          })();
        }
      }, 200);
      setTimeout(() => clearInterval(waitJoin), 10000);
    } // end else (not own room)
  } else if (replayId) {
    // Auto-load replay after connection is ready
    const waitReplay = setInterval(() => {
      if (session.networkManager?.connected) {
        clearInterval(waitReplay);
        // If region specified and different from current, switch first
        if (replayRegion) {
          const targetRegion = regionManager.getRegionById(replayRegion);
          if (targetRegion && replayRegion !== session.activeRegionId) {
            void switchToRegion(targetRegion).then(() => matchActions.startReplay(replayId));
            return;
          }
        }
        matchActions.startReplay(replayId);
      }
    }, 200);
    setTimeout(() => clearInterval(waitReplay), 10000);
  }
}
