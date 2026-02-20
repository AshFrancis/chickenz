import Phaser from "phaser";
import { gameConfig } from "./game";
import { GameScene } from "./scenes/GameScene";

import { NetworkManager, type RoomInfo, type GameMode } from "./net/NetworkManager";
import { initWalletKit, tryReconnectWallet, connectWallet, disconnectWallet, getConnectedAddress, settleMatch } from "./stellar";

interface MatchRecord {
  id: string;
  roomName: string;
  player1: string;
  player2: string;
  winner: number;
  scores: [number, number];
  timestamp: number;
  proofStatus: "pending" | "proving" | "verified" | "settled";
  roomId: string;
  mode?: GameMode;
}

// ── DOM elements ───────────────────────────────────────────────────────────────

// Top bar (read-only after gate)
const topBarAddress = document.getElementById("top-bar-address") as HTMLSpanElement;
const topBarUsername = document.getElementById("top-bar-username") as HTMLSpanElement;
const walletBtn = document.getElementById("btn-wallet") as HTMLButtonElement;
const muteBtn = document.getElementById("btn-mute") as HTMLButtonElement | null;

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

// ── Gate: username-only flow (wallet not required) ────────────────────────────

// Auto-reconnect: if saved username exists, skip gate
{
  const savedName = localStorage.getItem("chickenz-username");
  if (savedName) {
    currentUsername = savedName;
    topBarUsername.textContent = savedName;
    gateOverlay.classList.add("hidden");
    connectToServer(DEFAULT_SERVER);
  } else {
    // Show step 2 immediately (no wallet gate)
    gateStep2.classList.add("visible");
    gateUsernameInput.focus();
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

// ── Mute ──────────────────────────────────────────────────────────────────────

let isMuted = localStorage.getItem("chickenz-muted") === "true";
function updateMuteButton() {
  if (!muteBtn) return;
  muteBtn.innerHTML = isMuted ? "&#128264;" : "&#128266;";
  muteBtn.title = isMuted ? "Unmute" : "Mute";
}
updateMuteButton();

muteBtn?.addEventListener("click", () => {
  isMuted = !isMuted;
  localStorage.setItem("chickenz-muted", String(isMuted));
  updateMuteButton();
  const scene = getGameScene();
  if (scene) scene.setMuted(isMuted);
});

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
    
      networkManager.sendJoinRoom(room.id);
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
      closeLobby();
      const scene = getGameScene();
      if (scene) {
        scene.startWarmup(joinCode, currentUsername);
        scene.setMuted(isMuted);
      }
    },

    onMatched(playerId, seed, roomId, usernames, mapIndex, totalRounds, mode, characters) {
      onlineRoomId = roomId;
      lastMatchMode = mode;

      const scene = getGameScene();
      if (!scene) return;

      if (scene.isWarmup) {
        scene.stopWarmup();
      } else {
        closeLobby();
      }

      networkManager?.resetThrottle();
      scene.startOnlineMatch(playerId, seed, usernames, mapIndex, totalRounds, characters);
      scene.setMuted(isMuted);
      scene.onLocalInput = (input, tick) => {
        networkManager?.sendInput(input, tick);
      };
    },

    onState(state) {
      const scene = getGameScene();
      if (scene) scene.receiveState(state);
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

  networkManager.sendQuickplay(currentMode);
  lobbyStatus.textContent = `Finding a ${currentMode} match...`;
  setLobbyButtons(false);
});

createPublicBtn.addEventListener("click", () => {
  if (!networkManager?.connected) return;

  networkManager.sendCreate(false, currentMode);
  lobbyStatus.textContent = `Creating ${currentMode} public match...`;
  setLobbyButtons(false);
});

createPrivateBtn.addEventListener("click", () => {
  if (!networkManager?.connected) return;

  networkManager.sendCreate(true, currentMode);
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
  networkManager.sendJoinByCode(code);
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
