import { session } from "../session";
import { escapeHtml } from "./format";
import type { RoomInfo } from "../net/NetworkManager";
import type { RegionRoomInfo } from "../net/RegionManager";
import type { RegionManager } from "../net/RegionManager";
import type { RegionConfig } from "../net/regions";

export interface LobbyPanelDeps {
  lobbyOverlay: HTMLDivElement;
  lobbyStatus: HTMLDivElement;
  joinCodeInput: HTMLInputElement;
  quickplayBtn: HTMLButtonElement;
  createPublicBtn: HTMLButtonElement;
  createPrivateBtn: HTMLButtonElement;
  joinCodeBtn: HTMLButtonElement;
  roomListEl: HTMLDivElement;
  matchHistoryList: HTMLDivElement;
  leaderboardContent: HTMLDivElement;
  isTouchDevice: boolean;
  // Callbacks
  getRegionManager: () => RegionManager;
  getTouchControls: () => { hide: () => void };
  getTutorial: () => { isActive: boolean; hide: () => void };
  switchToRegion: (region: RegionConfig) => Promise<void>;
  onFetchLeaderboard: (container: HTMLElement) => void;
  onFetchMatchHistory: (container: HTMLElement) => void;
  onJoinRoom: (roomId: string, regionId?: string) => void;
  ensureRankedReady: (force?: boolean) => Promise<boolean>;
  getConnectedAddress: () => string | null;
}

export interface LobbyPanelAPI {
  open: () => void;
  close: () => void;
  setButtons: (enabled: boolean) => void;
  renderMergedRooms: (rooms: RegionRoomInfo[]) => void;
  switchTab: (tabName: string) => void;
  getActiveTab: () => string;
}

export function initLobbyPanel(deps: LobbyPanelDeps): LobbyPanelAPI {
  const {
    lobbyOverlay,
    lobbyStatus,
    joinCodeInput,
    quickplayBtn,
    createPublicBtn,
    createPrivateBtn,
    joinCodeBtn,
    roomListEl,
    leaderboardContent,
    matchHistoryList,
    isTouchDevice,
    getRegionManager,
    getTouchControls,
    getTutorial,
    onFetchLeaderboard,
    onFetchMatchHistory,
    ensureRankedReady,
    getConnectedAddress,
    switchToRegion,
    onJoinRoom,
  } = deps;

  // ── Local state ───────────────────────────────────────────────────────────────
  let activeTab = "rooms";

  // ── Tab switching ─────────────────────────────────────────────────────────────

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

    if (tabName === "leaderboard") onFetchLeaderboard(leaderboardContent);
    if (tabName === "history") onFetchMatchHistory(matchHistoryList);
  }

  document.querySelectorAll(".lobby-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const tabName = (tab as HTMLElement).dataset.tab!;
      switchTab(tabName);
    });
  });

  // ── Lobby open/close ──────────────────────────────────────────────────────────

  function open() {
    lobbyOverlay.classList.add("visible");
    lobbyStatus.textContent = "";
    joinCodeInput.value = "";
    setButtons(true);
    session.pendingQuickplay = false;

    // Clear join code from URL bar and localStorage
    history.replaceState(null, "", window.location.pathname);
    localStorage.removeItem("chickenz-last-join-code");

    // Hide touch controls and tutorial when returning to lobby
    if (isTouchDevice) getTouchControls().hide();
    const tut = getTutorial();
    if (tut.isActive) tut.hide();

    const nm = session.networkManager;
    if (nm?.connected) {
      nm.sendListRooms();
    }

    if (activeTab === "leaderboard") onFetchLeaderboard(leaderboardContent);
    if (activeTab === "history") onFetchMatchHistory(matchHistoryList);
  }

  function close() {
    lobbyOverlay.classList.remove("visible");
  }

  function setButtons(enabled: boolean) {
    quickplayBtn.disabled = !enabled;
    createPublicBtn.disabled = !enabled;
    createPrivateBtn.disabled = !enabled;
    joinCodeBtn.disabled = !enabled;
  }

  // ── Room list ─────────────────────────────────────────────────────────────────

  function createRoomElement(room: RoomInfo, roomRegionId?: string, roomRegionFlag?: string): HTMLDivElement {
    const regionManager = getRegionManager();
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
          const nm = session.networkManager;
          if (!nm?.connected) return;
          session.pendingCharacter = session.homeCharacter;
          nm.sendJoinRoom(room.id, session.pendingCharacter, session.awayCharacter);
          lobbyStatus.textContent = "Joining...";
          setButtons(false);
        };

        // Switch region if room is on a different server
        const needSwitch = targetRegion && roomRegionId !== session.activeRegionId;

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

  function renderMergedRooms(mergedRooms: RegionRoomInfo[]) {
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

  return {
    open,
    close,
    setButtons,
    renderMergedRooms,
    switchTab,
    getActiveTab: () => activeTab,
  };
}
