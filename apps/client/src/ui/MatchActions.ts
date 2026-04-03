import type { GameScene } from "../scenes/GameScene";
import { session } from "../session";
import { renderMatchDetail } from "./MatchDetailView";
import { fetchMatchHistory, type MatchHistoryCallbacks, type TranscriptResponse } from "./MatchHistoryPanel";
import { getConnectedAddress, settleMatch } from "../stellar";
import type { MatchRecord } from "../types";

export interface MatchActionsDeps {
  getGameScene: () => GameScene | null;
  lobbyAPI: {
    close(): void;
    setButtons(enabled: boolean): void;
    getActiveTab(): string;
  };
  lobbyStatus: HTMLElement;
  matchDetailOverlay: HTMLElement;
  matchDetailBody: HTMLElement;
  matchHistoryList: HTMLElement;
}

export function initMatchActions(deps: MatchActionsDeps) {
  const { getGameScene, lobbyAPI, lobbyStatus, matchDetailOverlay, matchDetailBody, matchHistoryList } = deps;

  function startReplay(roomId: string, regionUrl?: string) {
    const origin = regionUrl || session.networkManager?.httpOrigin;
    if (!origin) return;
    fetch(`${origin}/transcript/${roomId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: TranscriptResponse) => {
        lobbyAPI.close();
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
    const origin = regionUrl || session.networkManager?.httpOrigin;
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

  function openMatchDetail(matchId: string, regionUrl?: string) {
    const origin = regionUrl || session.networkManager?.httpOrigin;
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

  async function handleSettleMatch(matchId: string, regionUrl?: string) {
    const origin = regionUrl || session.networkManager?.httpOrigin;
    if (!origin) return;
    const addr = getConnectedAddress();
    if (!addr) {
      lobbyStatus.textContent = "Connect wallet to settle on-chain.";
      return;
    }

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

      if (txHash) {
        await fetch(`${origin}/api/matches/${matchId}/settle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ txHash }),
        });
      }
      lobbyStatus.textContent = "Match settled on-chain!";
      if (lobbyAPI.getActiveTab() === "history") {
        fetchMatchHistory(matchHistoryList, buildCallbacks());
      }
    } catch (err) {
      lobbyStatus.textContent = `Settlement failed: ${(err as Error).message}`;
    } finally {
      if (settleBtn) settleBtn.disabled = false;
    }
  }

  function buildCallbacks(): MatchHistoryCallbacks {
    return {
      onReplay: (roomId, regionUrl) => startReplay(roomId, regionUrl),
      onDownload: (roomId, regionUrl) => downloadTranscript(roomId, regionUrl),
      onSettle: (matchId, regionUrl) => void handleSettleMatch(matchId, regionUrl),
      onDetail: (matchId, regionUrl) => openMatchDetail(matchId, regionUrl),
      onShare: (roomId, region, buttonEl) => {
        void navigator.clipboard
          .writeText(`${window.location.origin}/?replay=${roomId}&region=${region}`)
          .then(() => {
            buttonEl.textContent = "Copied!";
            setTimeout(() => {
              buttonEl.textContent = "Share";
            }, 1500);
          });
      },
      getActiveRegionId: () => session.activeRegionId,
      getConnectedAddress: () => getConnectedAddress(),
    };
  }

  return { startReplay, downloadTranscript, openMatchDetail, handleSettleMatch, buildCallbacks };
}
