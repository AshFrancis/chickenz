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

/** Returns the wallet address — from active SDK session or cached localStorage.
 *  For the lobby, the cached address is sufficient. SDK connection only needed for signing. */
export function getConnectedAddress(): string | null {
  return kit?.contractId ?? localStorage.getItem("chickenz-wallet-address") ?? null;
}

/** Returns true if the SDK has an active session (can sign transactions). */
export function isSDKConnected(): boolean {
  return kit?.isConnected ?? false;
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
 *  Waits for on-chain deployment before updating UI. */
export async function createWallet(username: string): Promise<string | null> {
  if (!kit) return null;
  try {
    // Create passkey + deploy on-chain (autoSubmit waits for confirmation)
    const result = await kit.createWallet("Chickenz", username, { autoSubmit: true });
    if (result.submitResult && !result.submitResult.success) {
      console.error("[stellar] wallet deploy failed:", result.submitResult.error);
      return null;
    }
    localStorage.removeItem("chickenz-wallet-disconnected");
    // Cache proof data for server verification (register path — no assertion needed)
    lastAuthProof = {
      address: result.contractId,
      credentialId: result.credentialId,
      publicKey: toBase64Url(result.publicKey),
    };
    console.log("[stellar] wallet created and deployed:", result.contractId);
    window.dispatchEvent(new CustomEvent("walletChanged", { detail: { address: result.contractId } }));
    return result.contractId;
  } catch (err) {
    console.error("[stellar] createWallet failed:", err);
    return null;
  }
}

/** Silent session restore (startup). Returns address or null.
 *  If stored credential exists but contract isn't deployed, tries to deploy it silently. */
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
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // If the contract isn't deployed, try deploying pending credentials silently
    if (errMsg.includes("not found on-chain") || errMsg.includes("not yet been deployed")) {
      console.warn("[stellar] silent restore found undeployed contract, trying to deploy...");
      const deployed = await tryDeployPending();
      if (deployed) return deployed;
    }
    return null;
  }
}

/** Interactive connect — always prompts passkey selection (ignores stored session).
 *  If the contract isn't deployed yet (pending from failed registration), auto-deploys it. */
export async function promptConnect(): Promise<string | null> {
  if (!kit) return null;
  try {
    const result = await kit.connectWallet({ fresh: true });
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
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("not found on-chain") || errMsg.includes("not yet been deployed")) {
      // Selected passkey's contract isn't deployed — try deploying pending credentials
      console.warn("[stellar] selected passkey's contract not deployed, trying to deploy...");
      const deployed = await tryDeployPending();
      if (deployed) return deployed;
      console.warn("[stellar] could not deploy. Try clicking 'Register' to create a new wallet.");
    } else {
      console.error("[stellar] promptConnect failed:", err);
    }
    return null;
  }
}

/** Try to deploy any pending credentials. Returns contract address on success, null on failure. */
async function tryDeployPending(): Promise<string | null> {
  if (!kit) return null;
  try {
    const pending = await kit.credentials.getPending();
    if (pending.length === 0) return null;
    console.log(`[stellar] found ${pending.length} pending credential(s), deploying first...`);
    const cred = pending[0]!;
    const result = await kit.credentials.deploy(cred.credentialId, { autoSubmit: true });
    if (result.submitResult?.success) {
      console.log("[stellar] pending credential deployed:", result.contractId);
      // Now try connecting again
      const connectResult = await kit.connectWallet({ credentialId: cred.credentialId });
      if (connectResult) {
        localStorage.removeItem("chickenz-wallet-disconnected");
        lastAuthProof = {
          address: connectResult.contractId,
          credentialId: connectResult.credentialId,
        };
        window.dispatchEvent(new CustomEvent("walletChanged", { detail: { address: connectResult.contractId } }));
        return connectResult.contractId;
      }
    } else {
      console.error("[stellar] pending credential deploy failed:", result.submitResult?.error);
    }
  } catch (err) {
    console.error("[stellar] tryDeployPending failed:", err);
  }
  return null;
}

/** Disconnect wallet and clear session (always works, even if SDK isn't connected). */
export async function disconnectWallet(): Promise<void> {
  // Clear cached address first (so UI updates immediately)
  localStorage.removeItem("chickenz-wallet-address");
  localStorage.setItem("chickenz-wallet-disconnected", "1");
  lastAuthProof = null;
  // Try to disconnect SDK session (best-effort)
  if (kit) {
    try {
      await kit.disconnect();
    } catch {
      // Ignore — SDK might not be connected
    }
  }
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
