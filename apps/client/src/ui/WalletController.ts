import { session } from "../session";
import { getConnectedAddress, disconnectWallet, promptConnect, createWallet, getLastAuthProof } from "../stellar";
import { truncateAddress } from "./format";
import { getOrCreateUsername } from "./AnimalNameGenerator";
import type { GameMode } from "../net/NetworkManager";

export interface WalletControllerDeps {
  topBarAddress: HTMLSpanElement;
  walletLoginBtn: HTMLButtonElement;
  walletRegisterBtn: HTMLButtonElement;
  modeRankedBtn: HTMLButtonElement;
  lobbyStatus: HTMLDivElement;
  matchHistoryList: HTMLDivElement; // for disabling settle buttons during settlement
  // Callbacks
  setMode: (mode: GameMode) => void;
  renderRoomList: () => void;
  setLobbyButtons: (enabled: boolean) => void;
}

export interface WalletControllerAPI {
  updateWalletUI: () => void;
  ensureRankedReady: (forceVerify?: boolean) => Promise<boolean>;
  verifyWallet: (addr: string) => Promise<boolean>;
}

export function initWalletController(deps: WalletControllerDeps): WalletControllerAPI {
  const {
    topBarAddress,
    walletLoginBtn,
    walletRegisterBtn,
    modeRankedBtn,
    lobbyStatus,
    setMode,
    renderRoomList,
    setLobbyButtons,
  } = deps;

  // ── Helpers ───────────────────────────────────────────────────────────────────

  /** Get the per-region wallet token storage key. */
  function walletTokenKey(): string {
    return `chickenz-wallet-token-${session.activeRegionId || "default"}`;
  }

  /** Try to revalidate using a stored token (no passkey prompt). */
  async function tryStoredToken(addr: string): Promise<boolean> {
    const nm = session.networkManager;
    if (!nm) return false;
    try {
      const raw = localStorage.getItem(walletTokenKey());
      if (!raw) return false;
      const stored = JSON.parse(raw) as { address: string; token: string };
      if (stored.address !== addr || !stored.token) return false;
      const res = await fetch(`${nm.httpOrigin}/api/wallet/revalidate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: addr, token: stored.token }),
      });
      const { verified } = await res.json();
      if (verified) {
        session.lastVerifiedAddr = addr;
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
    const nm = session.networkManager;
    if (!nm) return false;
    if (session.lastVerifiedAddr === addr) return true;
    if (await tryStoredToken(addr)) return true;
    if (session.verifyInProgress === addr) return false;
    session.verifyInProgress = addr;
    const origin = nm.httpOrigin;
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
        session.lastVerifiedAddr = addr;
        if (token) {
          localStorage.setItem(walletTokenKey(), JSON.stringify({ address: addr, token }));
        }
      }
      return !!verified;
    } catch (err) {
      console.error("[wallet] Registration failed:", err);
      return false;
    } finally {
      session.verifyInProgress = null;
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
      session.networkManager?.sendSetWallet(addr);
      // Re-render room list so ranked join buttons update
      renderRoomList();
    } else {
      topBarAddress.textContent = "";
      walletLoginBtn.textContent = "Log In";
      walletLoginBtn.classList.remove("btn-warn");
      walletLoginBtn.classList.add("btn-primary");
      walletLoginBtn.style.display = "";
      walletRegisterBtn.style.display = "";
      // Notify server to clear wallet address and verified state
      session.networkManager?.sendSetWallet("");
      session.lastVerifiedAddr = null;
      localStorage.removeItem(walletTokenKey());
      localStorage.removeItem("chickenz-wallet-address");
      // Leave ranked room/lobby if wallet disconnected
      if (session.currentMode === "ranked") {
        session.networkManager?.sendLeave();
        setMode("casual");
      }
      modeRankedBtn.classList.add("locked");
      // Re-render room list so ranked join buttons update
      renderRoomList();
    }
  }

  /** Verify wallet for ranked play. Returns true if verified or not needed (casual + not forced). */
  async function ensureRankedReady(forceVerify = false): Promise<boolean> {
    if (!forceVerify && session.currentMode !== "ranked") return true;
    const addr = getConnectedAddress();
    if (!addr) {
      lobbyStatus.textContent = "Connect a wallet to play ranked.";
      return false;
    }
    if (session.lastVerifiedAddr === addr) return true;
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

  // ── Event listeners ───────────────────────────────────────────────────────────

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

  return { updateWalletUI, ensureRankedReady, verifyWallet };
}
