import { SmartAccountKit, IndexedDBStorage } from "smart-account-kit";
import * as StellarSdk from "@stellar/stellar-sdk";

const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

// Deployed contract addresses (testnet)
export const CHICKENZ_CONTRACT = "CBRDPRKUK3NH2HXOWSNZPG2ZSXXXZBR7GCMN7WLHWINMLNDCJ7NSREKG";
export const GAME_HUB_CONTRACT = "CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG";
export const VERIFIER_CONTRACT = "CDUDXCLMNE7Q4BZJLLB3KACFOS55SS55GSQW2UYHDUXTJKZUDDAJYCIH";

// SAK configuration — set via Vite env vars
const ACCOUNT_WASM_HASH = import.meta.env.VITE_ACCOUNT_WASM_HASH ?? "";
const WEBAUTHN_VERIFIER = import.meta.env.VITE_WEBAUTHN_VERIFIER ?? "";
const RELAYER_URL = import.meta.env.VITE_RELAYER_URL ?? "";

let kit: SmartAccountKit | null = null;

export function getConnectedAddress(): string | null {
  return kit?.contractId ?? null;
}

// ── Auth proof caching (for server-side wallet verification) ─────────────────

export interface AuthProof {
  address: string;
  credentialId: string; // base64url
  publicKey?: string; // base64url of 65-byte uncompressed secp256r1 key
  assertion?: {
    authenticatorData: string; // base64url
    clientDataJSON: string; // base64url
    signature: string; // base64url (DER-encoded ECDSA)
  };
}

let lastAuthProof: AuthProof | null = null;

/** Returns cached proof data from the most recent login/register. */
export function getLastAuthProof(): AuthProof | null {
  return lastAuthProof;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Init smart-account-kit ──────────────────────────────────────────────────

export async function initPasskeyKit(): Promise<void> {
  kit = new SmartAccountKit({
    rpcUrl: TESTNET_RPC,
    networkPassphrase: TESTNET_PASSPHRASE,
    accountWasmHash: ACCOUNT_WASM_HASH,
    webauthnVerifierAddress: WEBAUTHN_VERIFIER,
    rpId: window.location.hostname,
    rpName: "Chickenz",
    storage: new IndexedDBStorage(),
    ...(RELAYER_URL ? { relayerUrl: RELAYER_URL } : {}),
  });

  kit.events.on("walletDisconnected", () => {
    window.dispatchEvent(new CustomEvent("walletChanged", { detail: { address: null } }));
  });
}

/** Create a new passkey wallet (registration prompt).
 *  Optimistically updates UI after passkey creation, deploys on-chain in background. */
export async function createWallet(username: string): Promise<string | null> {
  if (!kit) return null;
  try {
    // Create passkey + get signed deploy tx (no on-chain submit yet)
    const result = await kit.createWallet("Chickenz", username);
    localStorage.removeItem("chickenz-wallet-disconnected");
    // Cache proof data for server verification (register path — no assertion needed)
    lastAuthProof = {
      address: result.contractId,
      credentialId: result.credentialId,
      publicKey: toBase64Url(result.publicKey),
    };
    // Optimistic UI update — wallet is usable locally immediately
    window.dispatchEvent(new CustomEvent("walletChanged", { detail: { address: result.contractId } }));
    // Deploy on-chain in background
    if (result.signedTransaction) {
      kit.relayer.sendXdr(result.signedTransaction).then((res) => {
        if (!res.success) console.warn("[stellar] background deploy failed:", res.error);
        else console.log("[stellar] wallet deployed on-chain:", res.hash);
      }).catch((err) => console.warn("[stellar] background deploy error:", err));
    }
    return result.contractId;
  } catch (err) {
    console.error("[stellar] createWallet failed:", err);
    return null;
  }
}

/** Silent session restore (startup). Returns address or null. */
export async function connectWallet(): Promise<string | null> {
  if (!kit) return null;
  if (localStorage.getItem("chickenz-wallet-disconnected")) return null;
  try {
    const result = await kit.connectWallet();
    if (result) {
      // Cache proof data for server verification (silent restore — has credential but no assertion)
      const pubKey = result.credential?.publicKey;
      lastAuthProof = {
        address: result.contractId,
        credentialId: result.credentialId,
        ...(pubKey ? { publicKey: toBase64Url(pubKey) } : {}),
      };
      window.dispatchEvent(new CustomEvent("walletChanged", { detail: { address: result.contractId } }));
      return result.contractId;
    }
    return null;
  } catch {
    return null;
  }
}

/** Interactive connect — prompts passkey selection if no stored session. */
export async function promptConnect(): Promise<string | null> {
  if (!kit) return null;
  try {
    const result = await kit.connectWallet({ prompt: true });
    if (result) {
      localStorage.removeItem("chickenz-wallet-disconnected");
      // Cache proof data for server verification (login path — includes assertion)
      const pubKey = result.credential?.publicKey;
      lastAuthProof = {
        address: result.contractId,
        credentialId: result.credentialId,
        publicKey: pubKey ? toBase64Url(pubKey) : "",
        ...(result.rawResponse
          ? {
              assertion: {
                authenticatorData: result.rawResponse.response.authenticatorData,
                clientDataJSON: result.rawResponse.response.clientDataJSON,
                signature: result.rawResponse.response.signature,
              },
            }
          : {}),
      };
      window.dispatchEvent(new CustomEvent("walletChanged", { detail: { address: result.contractId } }));
      return result.contractId;
    }
    return null;
  } catch (err) {
    console.error("[stellar] promptConnect failed:", err);
    return null;
  }
}

/** Disconnect wallet and clear session. */
export async function disconnectWallet(): Promise<void> {
  if (!kit) return;
  try {
    await kit.disconnect();
  } catch {
    // Ignore errors on disconnect
  }
  localStorage.setItem("chickenz-wallet-disconnected", "1");
  window.dispatchEvent(new CustomEvent("walletChanged", { detail: { address: null } }));
}

// ── Contract helpers ───────────────────────────────────────────────────────

async function callContract(
  method: string,
  args: StellarSdk.xdr.ScVal[],
): Promise<string | null> {
  if (!kit?.contractId) throw new Error("Wallet not connected");

  const tx = await StellarSdk.contract.AssembledTransaction.build({
    method,
    args,
    contractId: CHICKENZ_CONTRACT,
    networkPassphrase: TESTNET_PASSPHRASE,
    rpcUrl: TESTNET_RPC,
    publicKey: kit.contractId,
    timeoutInSeconds: 60,
    parseResultXdr: (result: StellarSdk.xdr.ScVal) => result,
  });

  const result = await kit.signAndSubmit(tx);
  if (!result.success) {
    throw new Error(`Transaction failed: ${result.error || "unknown"}`);
  }
  return result.hash ?? null;
}

export async function startMatch(
  sessionId: number,
  player1: string,
  player2: string,
  seedCommit: Uint8Array,
): Promise<void> {
  await callContract("start_match", [
    StellarSdk.nativeToScVal(sessionId, { type: "u32" }),
    StellarSdk.nativeToScVal(player1, { type: "address" }),
    StellarSdk.nativeToScVal(player2, { type: "address" }),
    StellarSdk.nativeToScVal(seedCommit, { type: "bytes" }),
  ]);
}

export async function settleMatch(sessionId: number, seal: Uint8Array, journal: Uint8Array): Promise<string | null> {
  return callContract("settle_match", [
    StellarSdk.nativeToScVal(sessionId, { type: "u32" }),
    StellarSdk.nativeToScVal(seal, { type: "bytes" }),
    StellarSdk.nativeToScVal(journal, { type: "bytes" }),
  ]);
}

/** SHA-256 hash of a u32 seed (LE bytes) — matches the Rust prover's hash_seed(). */
export async function hashSeed(seed: number): Promise<Uint8Array> {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, seed, true); // little-endian
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return new Uint8Array(digest);
}
