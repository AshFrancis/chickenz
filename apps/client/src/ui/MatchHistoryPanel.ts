import type { MatchRecord } from "../types";
import { escapeHtml, truncateAddress, formatTimeAgo, proofStatusLabel } from "./format";
import { getRegions } from "../net/regions";

export interface TranscriptInput {
  buttons: number;
  aimX?: number;
  aimY?: number;
  aim_x?: number;
  aim_y?: number;
}

export interface RoundTranscript {
  seed: number;
  mapIndex: number;
  transcript: [TranscriptInput, TranscriptInput][];
}

export interface TranscriptResponse {
  rounds: RoundTranscript[];
  usernames?: [string, string];
  characters?: [number, number];
}

export interface MatchHistoryCallbacks {
  onReplay: (roomId: string, regionUrl?: string) => void;
  onDownload: (roomId: string, regionUrl?: string) => void;
  onSettle: (matchId: string, regionUrl?: string) => void;
  onDetail: (matchId: string, regionUrl?: string) => void;
  onShare: (code: string, regionId: string, buttonEl: HTMLElement) => void;
  getActiveRegionId: () => string;
  getConnectedAddress: () => string | null;
}

let fetchingHistory = false;

export function fetchMatchHistory(container: HTMLElement, callbacks: MatchHistoryCallbacks): void {
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
      renderMatchHistory(container, merged, callbacks);
    })
    .catch(() => {
      container.innerHTML = `<div class="empty-state">Failed to load match history</div>`;
    })
    .finally(() => {
      fetchingHistory = false;
    });
}

export function renderMatchHistory(
  container: HTMLElement,
  matches: MatchRecord[],
  callbacks: MatchHistoryCallbacks,
): void {
  if (matches.length === 0) {
    container.innerHTML = `<div class="empty-state">No matches played yet</div>`;
    return;
  }
  // innerHTML replacement destroys all old elements and their listeners, so
  // per-element addEventListener in the loop below is safe (no leak). We still
  // use event delegation on the container for button actions to keep wiring simple.
  container.innerHTML = "";

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
    const showSettle = m.mode === "ranked" && m.proofStatus === "verified" && callbacks.getConnectedAddress();
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
        <button class="btn btn-sm btn-share" data-action="share" data-room-id="${escapeHtml(m.roomId)}" data-region="${escapeHtml(m._regionId || callbacks.getActiveRegionId())}">Share</button>
        <button class="btn btn-sm btn-download" data-action="download" data-room-id="${escapeHtml(m.roomId)}">DL</button>
      </div>
    `;
    container.appendChild(el);
  }

  // Single delegated listener for all button actions in match history list
  container.onclick = (e) => {
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
          callbacks.onReplay(m.roomId, m._regionUrl);
          break;
        case "share": {
          const region = target.dataset.region || callbacks.getActiveRegionId();
          callbacks.onShare(m.roomId, region, target);
          break;
        }
        case "download":
          callbacks.onDownload(m.roomId, m._regionUrl);
          break;
        case "settle":
          callbacks.onSettle(m.id, m._regionUrl);
          break;
      }
      return;
    }
    // Click on row (not a button) opens detail
    const row = (e.target as HTMLElement).closest<HTMLElement>(".match-item");
    if (row && row.dataset.matchId) {
      const m = matchById.get(row.dataset.matchId);
      if (m) callbacks.onDetail(m.id, m._regionUrl);
    }
  };
}
