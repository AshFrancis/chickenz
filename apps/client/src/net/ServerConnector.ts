import { NetworkManager, type RoomInfo } from "./NetworkManager";
import type { RegionConfig } from "./regions";
import type { GameScene } from "../scenes/GameScene";
import { session } from "../session";
import { escapeHtml } from "../ui/format";
import {
  tournamentTimers,
  hideAllTournamentOverlays,
  renderBracket,
  renderStandings,
  renderTournamentLobby,
  type TournamentPanelDeps,
} from "../ui/TournamentPanel";
import { getConnectedAddress } from "../stellar";

export interface ServerConnectorDeps {
  getGameScene: () => GameScene | null;
  regionManager: {
    homeRegionId: string;
    getRegionById(id: string): RegionConfig | undefined;
    updateRoomsForRegion(regionId: string, rooms: RoomInfo[]): void;
  };
  lobbyAPI: {
    open(): void;
    close(): void;
    setButtons(enabled: boolean): void;
  };
  settingsAPI: {
    applyAudioSettings(scene: GameScene): void;
  };
  tournamentDeps: TournamentPanelDeps;
  lobbyStatus: HTMLElement;
  isTouchDevice: boolean;
  touchControls: { show(): void };
  switchToRegion: (region: RegionConfig) => Promise<void>;
}

export function connectToServer(url: string, deps: ServerConnectorDeps): Promise<void> {
  return new Promise<void>((resolveConnect) => {
    if (session.networkManager) {
      session.networkManager.disconnect();
    }

    const {
      getGameScene,
      regionManager,
      lobbyAPI,
      settingsAPI,
      tournamentDeps,
      lobbyStatus,
      isTouchDevice,
      touchControls,
      switchToRegion,
    } = deps;

    session.networkManager = new NetworkManager({
      onLobby(rooms) {
        regionManager.updateRoomsForRegion(session.activeRegionId, rooms);
      },

      onWaiting(roomId, roomName, joinCode) {
        if (session.currentTournamentId) return;
        history.replaceState(null, "", "?join=" + joinCode);
        localStorage.setItem("chickenz-last-join-code", joinCode);
        lobbyAPI.close();
        const botBtn = document.getElementById("btn-add-bot");
        if (botBtn) botBtn.style.display = session.currentMode === "ranked" ? "none" : "";
        const scene = getGameScene();
        if (scene) {
          scene.startWarmup(
            joinCode,
            session.currentUsername,
            () => {
              settingsAPI.applyAudioSettings(scene);
              if (isTouchDevice) touchControls.show();
            },
            session.pendingCharacter,
          );
        }
      },

      onMatched(playerId, seed, roomId, usernames, mapIndex, totalRounds, mode, characters) {
        if (session.currentTournamentId) return;

        const scene = getGameScene();
        if (!scene) {
          lobbyAPI.close();
          return;
        }

        session.networkManager?.resetThrottle();
        const needCloseLobby = !scene.isWarmup;
        scene.startOnlineMatch(
          playerId,
          seed,
          usernames,
          mapIndex,
          totalRounds,
          characters,
          needCloseLobby ? () => lobbyAPI.close() : undefined,
        );
        settingsAPI.applyAudioSettings(scene);
        if (isTouchDevice) touchControls.show();
        scene.onLocalInput = (input, tick) => {
          session.networkManager?.sendInput(input, tick);
        };
      },

      onState(state, lastButtons) {
        const scene = getGameScene();
        if (scene) {
          if (session.networkManager) scene.setNetworkRtt(session.networkManager.rtt);
          scene.receiveState(state, lastButtons);
        }
      },

      onRoundEnd(round, winner, roundWins) {
        const scene = getGameScene();
        if (scene) scene.handleRoundEnd(round, winner, roundWins);
      },

      onRoundStart(round, seed, mapIndex) {
        session.networkManager?.resetThrottle();
        const scene = getGameScene();
        if (scene) scene.startNewRound(seed, mapIndex, round);
      },

      onEnded(winner, _scores, _roundWins, _roomId, _mode) {
        if (session.currentTournamentId) return;

        const scene = getGameScene();
        if (scene) scene.endOnlineMatch(winner);

        const returnToLobby = async () => {
          const homeId = regionManager.homeRegionId;
          if (homeId && homeId !== session.activeRegionId) {
            const homeRegion = regionManager.getRegionById(homeId);
            if (homeRegion) await switchToRegion(homeRegion);
          }
          lobbyAPI.open();
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
        lobbyAPI.setButtons(true);
      },

      onDisconnect() {
        lobbyStatus.textContent = "Disconnected from server. Reconnecting...";
        lobbyAPI.setButtons(false);
        if (session.currentTournamentId) {
          hideAllTournamentOverlays(tournamentDeps);
          session.currentTournamentId = null;
          session.tournamentSpectating = false;
          const scene = getGameScene();
          if (scene?.isSpectating) scene.stopSpectating();
        }
      },

      onReconnect() {
        lobbyStatus.textContent = "";
        lobbyAPI.setButtons(true);
        if (session.currentUsername) session.networkManager?.sendSetUsername(session.currentUsername);
        const walletAddr = getConnectedAddress();
        if (walletAddr) session.networkManager?.sendSetWallet(walletAddr);
      },

      // ── Tournament callbacks ──────────────────────────────
      onTournamentLobby(msg) {
        const tlState = renderTournamentLobby(tournamentDeps, msg, session.currentTournamentSlot);
        session.currentTournamentId = tlState.tournamentId;
        session.tournamentHostSlot = tlState.hostSlot;
        session.currentTournamentSlot = tlState.mySlot;
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
        const scene = getGameScene();
        if (scene) {
          scene.clearVisuals();
          scene.endOnlineMatch(-1, true);
        }

        hideAllTournamentOverlays(tournamentDeps);
        tournamentDeps.bracketOverlay.classList.add("visible");
        renderBracket(tournamentDeps, bracket, matchIndex);

        // Stage 1: Bracket appears with scale-in
        const canvas = (tournamentDeps.bracketGrid as HTMLElement).querySelector(".bk-canvas") as HTMLElement;
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
            const matchEl = tournamentDeps.bracketGrid.querySelector(`[data-mi="${matchIndex}"]`) as HTMLElement;
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
            tournamentDeps.bracketOverlay.appendChild(vsOverlay);
            requestAnimationFrame(() => vsOverlay.classList.add("visible"));
          }, 1600),
        );

        // Stage 4: Start the game
        tournamentTimers.push(
          setTimeout(() => {
            hideAllTournamentOverlays(tournamentDeps);
            tournamentDeps.bracketOverlay.querySelectorAll(".bk-vs-overlay").forEach((el) => el.remove());

            const sc = getGameScene();
            if (!sc) return;

            if (role === "fighter" && playerId !== undefined) {
              session.tournamentSpectating = false;
              session.networkManager?.resetThrottle();
              sc.startOnlineMatch(playerId, seed, usernames, mapIndex, totalRounds, characters);
              settingsAPI.applyAudioSettings(sc);
              sc.onLocalInput = (input, tick) => {
                session.networkManager?.sendInput(input, tick);
              };
            } else {
              session.tournamentSpectating = true;
              sc.startSpectating(seed, usernames, mapIndex, totalRounds, characters);
              settingsAPI.applyAudioSettings(sc);
              tournamentDeps.spectateLabel.textContent = `SPECTATING • ${matchLabel}`;
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
          if (session.tournamentSpectating) {
            scene.stopSpectating();
          } else {
            scene.endOnlineMatch(-1, true);
          }
          scene.clearVisuals();
        }
        hideAllTournamentOverlays(tournamentDeps);
        tournamentDeps.bracketOverlay.classList.add("visible");
        renderBracket(tournamentDeps, bracket);
      },

      onTournamentEnd(standings, _bracket) {
        const scene = getGameScene();
        if (scene) {
          if (session.tournamentSpectating) scene.stopSpectating();
          else scene.endOnlineMatch(-1, true);
          scene.clearVisuals();
        }
        hideAllTournamentOverlays(tournamentDeps);
        tournamentDeps.tournamentResults.classList.add("visible");
        renderStandings(tournamentDeps, standings);

        setTimeout(() => {
          hideAllTournamentOverlays(tournamentDeps);
          session.currentTournamentId = null;
          session.currentTournamentSlot = -1;
          session.tournamentHostSlot = -1;
          session.tournamentSpectating = false;
          void (async () => {
            const homeId = regionManager.homeRegionId;
            if (homeId && homeId !== session.activeRegionId) {
              const homeRegion = regionManager.getRegionById(homeId);
              if (homeRegion) await switchToRegion(homeRegion);
            }
            lobbyAPI.open();
          })();
        }, 8000);
      },
    });

    session.networkManager.connect(url);

    let resolved = false;
    const waitForConnect = setInterval(() => {
      if (session.networkManager?.connected) {
        clearInterval(waitForConnect);
        if (session.currentUsername) {
          session.networkManager.sendSetUsername(session.currentUsername);
        }
        const walletAddr = getConnectedAddress();
        if (walletAddr) {
          session.networkManager.sendSetWallet(walletAddr);
        }
        if (!session.inTutorialFlow) lobbyAPI.open();
        if (!resolved) {
          resolved = true;
          resolveConnect();
        }
      }
    }, 100);

    setTimeout(() => {
      clearInterval(waitForConnect);
      if (!session.networkManager?.connected) {
        lobbyStatus.textContent = "Could not connect to server. Check your connection and try again.";
        lobbyAPI.setButtons(true);
      }
      if (!resolved) {
        resolved = true;
        resolveConnect();
      }
    }, 10000);
  });
}
