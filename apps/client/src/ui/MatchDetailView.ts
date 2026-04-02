import type { MatchRecord } from "../types";
import {
  escapeHtml,
  truncateAddress,
  proofStatusLabel,
  formatTimestamp,
  formatDuration,
  explorerTxUrl,
  explorerAccountUrl,
  explorerContractUrl,
  GUEST_IMAGE_ID,
} from "./format";

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

export interface MatchDetailCallbacks {
  onReplay: (roomId: string) => void;
  onDownload: (roomId: string) => void;
  onClose: () => void;
}

export function renderMatchDetail(m: MatchRecord, container: HTMLElement, callbacks: MatchDetailCallbacks) {
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

  container.innerHTML = `
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
  const replayBtn = container.querySelector(".btn-replay-detail");
  if (replayBtn) {
    replayBtn.addEventListener("click", () => {
      callbacks.onClose();
      callbacks.onReplay(m.roomId);
    });
  }
  const downloadBtn = container.querySelector(".btn-download-detail");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", () => {
      callbacks.onDownload(m.roomId);
    });
  }
}
