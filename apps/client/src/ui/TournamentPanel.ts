import { escapeHtml } from "./format";
import type {
  TournamentBracket,
  BracketMatch,
  TournamentLobbyMessage,
  TournamentConfig,
} from "../net/NetworkManager";

export interface TournamentPanelDeps {
  tournamentOverlay: HTMLElement;
  bracketOverlay: HTMLElement;
  bracketGrid: HTMLElement;
  spectateOverlay: HTMLElement;
  tournamentResults: HTMLElement;
  standingsList: HTMLElement;
  tournamentCode: HTMLElement;
  tournamentStatus: HTMLElement;
  tournamentPlayers: HTMLElement;
  onToggleRole: () => void;
  onUpdateConfig: (config: Partial<TournamentConfig>) => void;
  onStartTournament: () => void;
  onCloseLobby: () => void;
}

export const tournamentTimers: ReturnType<typeof setTimeout>[] = [];

export function hideAllTournamentOverlays(deps: TournamentPanelDeps): void {
  deps.tournamentOverlay.classList.remove("visible");
  deps.bracketOverlay.classList.remove("visible");
  deps.spectateOverlay.classList.remove("visible");
  deps.tournamentResults.classList.remove("visible");
  // Clear any pending animation timers
  for (const t of tournamentTimers) clearTimeout(t);
  tournamentTimers.length = 0;
}

export function renderBracket(
  deps: TournamentPanelDeps,
  bracket: TournamentBracket,
  highlightMatchIndex?: number,
): void {
  deps.bracketGrid.innerHTML = "";

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

  deps.bracketGrid.innerHTML = html;

  // Auto-scale bracket to fit the overlay
  const canvasEl = deps.bracketGrid.querySelector(".bk-canvas") as HTMLElement;
  if (canvasEl) {
    requestAnimationFrame(() => {
      const parentW = deps.bracketGrid.clientWidth || 800;
      const parentH = deps.bracketGrid.clientHeight || 400;
      const scaleX = parentW / totalWidth;
      const scaleY = parentH / canvasH;
      const scale = Math.min(scaleX, scaleY, 1.4);
      canvasEl.style.transform = `scale(${scale})`;
      canvasEl.style.transformOrigin = "center center";
    });
  }
}

export function renderStandings(
  deps: TournamentPanelDeps,
  standings: { place: number; name: string }[],
): void {
  const ordinal = (n: number) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);
  // Count how many players share each place
  const placeCounts = new Map<number, number>();
  for (const s of standings) placeCounts.set(s.place, (placeCounts.get(s.place) || 0) + 1);

  deps.standingsList.innerHTML = "";
  for (const s of standings) {
    const el = document.createElement("div");
    el.className = "standing-row";
    const tied = (placeCounts.get(s.place) || 0) > 1;
    const label = (tied ? "=" : "") + ordinal(s.place);
    el.innerHTML = `<span class="place">${label}</span><span class="name">${escapeHtml(s.name)}</span>`;
    deps.standingsList.appendChild(el);
  }
}

export function renderTournamentLobby(
  deps: TournamentPanelDeps,
  msg: TournamentLobbyMessage,
  currentTournamentSlot: number,
): { tournamentId: string; hostSlot: number; mySlot: number } {
  const mySlot = msg.mySlot;
  const myRole = mySlot >= 0 ? msg.participants[mySlot]!.role : null;

  deps.onCloseLobby();
  hideAllTournamentOverlays(deps);
  deps.tournamentOverlay.classList.add("visible");
  deps.tournamentCode.textContent = msg.joinCode;

  const players = msg.participants.filter((p) => p.role === "player");
  const spectators = msg.participants.filter((p) => p.role === "spectator");
  const isWaiting = msg.status === "waiting";

  if (msg.status === "playing") {
    deps.tournamentStatus.textContent = "Tournament in progress...";
  } else if (msg.status === "ended") {
    deps.tournamentStatus.textContent = "Tournament ended";
  } else {
    deps.tournamentStatus.textContent = `${players.length}/8 players, ${spectators.length}/5 spectators`;
  }

  // ── Render slot grid ──
  deps.tournamentPlayers.innerHTML = "";

  // Player slots (8 max)
  const playerLabel = document.createElement("div");
  playerLabel.className = "slots-section-label";
  playerLabel.textContent = "PLAYERS";
  deps.tournamentPlayers.appendChild(playerLabel);

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
        el.addEventListener("click", () => deps.onToggleRole());
      }
    }
    playerGrid.appendChild(el);
  }
  deps.tournamentPlayers.appendChild(playerGrid);

  // Spectator slots (5 max)
  const spectatorLabel = document.createElement("div");
  spectatorLabel.className = "slots-section-label";
  spectatorLabel.textContent = "SPECTATORS";
  deps.tournamentPlayers.appendChild(spectatorLabel);

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
        el.addEventListener("click", () => deps.onToggleRole());
      }
    }
    spectatorGrid.appendChild(el);
  }
  deps.tournamentPlayers.appendChild(spectatorGrid);

  // ── Host controls ──
  let controlsEl = document.getElementById("tournament-host-controls");
  if (controlsEl) controlsEl.remove();

  if (mySlot === msg.hostSlot && isWaiting) {
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
    fmtBo3.addEventListener("click", () => deps.onUpdateConfig({ matchFormat: "bo3" }));
    const fmtBo5 = document.createElement("button");
    fmtBo5.className = "btn btn-sm" + (msg.config.matchFormat === "bo5" ? " active" : "");
    fmtBo5.textContent = "Bo5";
    fmtBo5.addEventListener("click", () => deps.onUpdateConfig({ matchFormat: "bo5" }));
    configRow.append(fmtLabel, fmtBo3, fmtBo5);

    const bracketLabel = document.createElement("span");
    bracketLabel.textContent = "Bracket:";
    bracketLabel.style.marginLeft = "12px";
    const btWinners = document.createElement("button");
    btWinners.className = "btn btn-sm" + (msg.config.bracketType === "winners_only" ? " active" : "");
    btWinners.textContent = "Winners";
    btWinners.addEventListener("click", () => deps.onUpdateConfig({ bracketType: "winners_only" }));
    const btPartial = document.createElement("button");
    btPartial.className = "btn btn-sm" + (msg.config.bracketType === "partial_consolation" ? " active" : "");
    btPartial.textContent = "4th Place";
    btPartial.addEventListener("click", () => deps.onUpdateConfig({ bracketType: "partial_consolation" }));
    const btFull = document.createElement("button");
    btFull.className = "btn btn-sm" + (msg.config.bracketType === "full_consolation" ? " active" : "");
    btFull.textContent = "Full";
    btFull.addEventListener("click", () => deps.onUpdateConfig({ bracketType: "full_consolation" }));
    configRow.append(bracketLabel, btWinners, btPartial, btFull);
    controlsEl.appendChild(configRow);

    const startBtn = document.createElement("button");
    startBtn.className = "btn btn-primary";
    startBtn.textContent = "START TOURNAMENT";
    startBtn.disabled = players.length < 2;
    startBtn.style.marginTop = "8px";
    startBtn.addEventListener("click", () => deps.onStartTournament());
    controlsEl.appendChild(startBtn);

    deps.tournamentOverlay.appendChild(controlsEl);
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

    deps.tournamentOverlay.appendChild(controlsEl);
  }

  return {
    tournamentId: msg.tournamentId,
    hostSlot: msg.hostSlot,
    mySlot: msg.mySlot,
  };
}
