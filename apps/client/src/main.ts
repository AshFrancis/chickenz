import Phaser from "phaser";
import { gameConfig } from "./game";
import { GameScene } from "./scenes/GameScene";
import {
  connectWallet,
  disconnectWallet,
  getConnectedAddress,
  startMatch as contractStartMatch,
  settleMatch as contractSettleMatch,
  hashSeed,
  CHICKENZ_CONTRACT,
} from "./stellar";

// DOM elements
const walletBtn = document.getElementById("btn-wallet") as HTMLButtonElement;
const walletAddr = document.getElementById("wallet-addr") as HTMLSpanElement;
const newMatchBtn = document.getElementById("btn-new-match") as HTMLButtonElement;
const downloadBtn = document.getElementById("btn-download") as HTMLButtonElement;
const settleBtn = document.getElementById("btn-settle") as HTMLButtonElement;
const statusText = document.getElementById("status-text") as HTMLSpanElement;

// Create Phaser game
const game = new Phaser.Game(gameConfig);

function getGameScene(): GameScene | null {
  return game.scene.getScene("GameScene") as GameScene | null;
}

function setStatus(msg: string) {
  statusText.textContent = msg;
}

function shortenAddr(addr: string): string {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

// Track session ID for on-chain settlement
let currentSessionId = 0;
let matchRegisteredOnChain = false;

// ── Wallet ──────────────────────────────────────────────────────────────────

walletBtn.addEventListener("click", async () => {
  if (getConnectedAddress()) {
    await disconnectWallet();
    walletBtn.textContent = "Connect Wallet";
    walletAddr.textContent = "";
    setStatus("Wallet disconnected.");
    return;
  }

  try {
    walletBtn.disabled = true;
    walletBtn.textContent = "Connecting...";
    const addr = await connectWallet();
    walletBtn.textContent = "Disconnect";
    walletAddr.textContent = shortenAddr(addr);
    setStatus(`Connected: ${shortenAddr(addr)}`);
  } catch (err: any) {
    walletBtn.textContent = "Connect Wallet";
    setStatus(`Wallet error: ${err.message}`);
  } finally {
    walletBtn.disabled = false;
  }
});

// ── New Match ───────────────────────────────────────────────────────────────

newMatchBtn.addEventListener("click", async () => {
  const scene = getGameScene();
  if (!scene) return;

  const seed = Date.now() >>> 0;
  currentSessionId = seed; // Use seed as session ID for simplicity
  matchRegisteredOnChain = false;

  // Register on-chain if wallet connected
  const addr = getConnectedAddress();
  if (addr) {
    try {
      newMatchBtn.disabled = true;
      setStatus("Registering match on-chain...");
      const seedCommit = await hashSeed(seed);
      // For local 2-player, both players use same address
      await contractStartMatch(currentSessionId, addr, addr, seedCommit);
      matchRegisteredOnChain = true;
      setStatus("Match registered on-chain. Playing...");
    } catch (err: any) {
      setStatus(`On-chain registration failed: ${err.message}. Playing locally.`);
    } finally {
      newMatchBtn.disabled = false;
    }
  } else {
    setStatus("Playing locally (connect wallet for on-chain settlement).");
  }

  scene.startMatch(seed);
  downloadBtn.disabled = true;
  settleBtn.disabled = true;
});

// ── Match End ───────────────────────────────────────────────────────────────

window.addEventListener("matchEnd", ((e: CustomEvent) => {
  const { winner, scores, ticks, seed } = e.detail;
  const winnerStr = winner === -1 ? "Draw" : `Player ${winner + 1}`;
  setStatus(
    `Match over! ${winnerStr} wins. ${scores[0]}-${scores[1]}, ${ticks} ticks, seed=${seed}`,
  );
  downloadBtn.disabled = false;
  settleBtn.disabled = !matchRegisteredOnChain;
}) as EventListener);

// ── Download Transcript ─────────────────────────────────────────────────────

downloadBtn.addEventListener("click", () => {
  const scene = getGameScene();
  if (!scene) return;
  scene.transcript.download();
  setStatus("Transcript downloaded. Run the prover, then settle on-chain.");
});

// ── Settle On-Chain ─────────────────────────────────────────────────────────

settleBtn.addEventListener("click", async () => {
  if (!matchRegisteredOnChain) {
    setStatus("Match not registered on-chain.");
    return;
  }

  // For the hackathon MVP, settlement requires proof artifacts from the prover.
  // Prompt user to upload proof_artifacts.json.
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;

    try {
      settleBtn.disabled = true;
      setStatus("Reading proof artifacts...");
      const text = await file.text();
      const artifacts = JSON.parse(text);

      const seal = hexToBytes(artifacts.seal);
      const journal = hexToBytes(artifacts.journal);

      setStatus("Submitting proof to Soroban...");
      await contractSettleMatch(currentSessionId, seal, journal);
      setStatus(
        `Match settled on-chain! Contract: ${CHICKENZ_CONTRACT}`,
      );
      matchRegisteredOnChain = false;
    } catch (err: any) {
      setStatus(`Settlement failed: ${err.message}`);
      settleBtn.disabled = false;
    }
  };
  input.click();
});

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}
