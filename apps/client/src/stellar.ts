import {
  StellarWalletsKit,
  WalletNetwork,
  allowAllModules,
  FREIGHTER_ID,
} from "@creit.tech/stellar-wallets-kit";
import * as StellarSdk from "@stellar/stellar-sdk";

const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

// Deployed contract addresses (testnet)
export const CHICKENZ_CONTRACT =
  "CDYU5GFNDBIFYWLW54QV3LPDNQTER6ID3SK4QCCBVUY7NU76ESBP7LZP";
export const GAME_HUB_CONTRACT =
  "CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG";
export const VERIFIER_CONTRACT =
  "CDUDXCLMNE7Q4BZJLLB3KACFOS55SS55GSQW2UYHDUXTJKZUDDAJYCIH";

let connectedAddress: string | null = null;
let kit: StellarWalletsKit | null = null;

export function getConnectedAddress(): string | null {
  return connectedAddress;
}

// ── Init stellar-wallets-kit v1 ─────────────────────────────────────────────

export function initWalletKit() {
  kit = new StellarWalletsKit({
    network: WalletNetwork.TESTNET,
    selectedWalletId: FREIGHTER_ID,
    modules: allowAllModules(),
  });
}

/** Open wallet selection modal, connect, and return address. */
export async function connectWallet(): Promise<string | null> {
  if (!kit) return null;

  return new Promise((resolve) => {
    kit!.openModal({
      onWalletSelected: async (option: { id: string }) => {
        try {
          kit!.setWallet(option.id);
          const { address } = await kit!.getAddress();
          if (address) {
            connectedAddress = address;
            localStorage.removeItem("chickenz-wallet-disconnected");
            window.dispatchEvent(
              new CustomEvent("walletChanged", { detail: { address } }),
            );
            resolve(address);
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      },
    });
  });
}

/** Disconnect wallet and clear state. */
export function disconnectWallet() {
  connectedAddress = null;
  localStorage.setItem("chickenz-wallet-disconnected", "1");
  window.dispatchEvent(
    new CustomEvent("walletChanged", { detail: { address: null } }),
  );
}

/** Try to silently reconnect to Freighter if previously connected. */
export async function tryReconnectWallet(): Promise<boolean> {
  if (!kit) return false;
  if (localStorage.getItem("chickenz-wallet-disconnected")) return false;
  try {
    kit.setWallet(FREIGHTER_ID);
    const { address } = await kit.getAddress();
    if (address) {
      connectedAddress = address;
      window.dispatchEvent(
        new CustomEvent("walletChanged", { detail: { address } }),
      );
      return true;
    }
  } catch {
    // Freighter not available or user denied
  }
  return false;
}

// ── Contract helpers ───────────────────────────────────────────────────────

function getRpc(): StellarSdk.rpc.Server {
  return new StellarSdk.rpc.Server(TESTNET_RPC);
}

async function callContract(
  method: string,
  args: StellarSdk.xdr.ScVal[],
): Promise<StellarSdk.rpc.Api.GetTransactionResponse> {
  if (!connectedAddress || !kit) throw new Error("Wallet not connected");

  const server = getRpc();
  const account = await server.getAccount(connectedAddress);
  const contract = new StellarSdk.Contract(CHICKENZ_CONTRACT);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  const prepared = StellarSdk.rpc.assembleTransaction(
    tx,
    simResult as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse,
  ).build();

  const { signedTxXdr } = await kit.signTransaction(prepared.toXDR(), {
    networkPassphrase: TESTNET_PASSPHRASE,
    address: connectedAddress,
  });

  const signed = StellarSdk.TransactionBuilder.fromXDR(
    signedTxXdr,
    TESTNET_PASSPHRASE,
  );

  const sendResult = await server.sendTransaction(signed);
  if (sendResult.status === "ERROR") {
    throw new Error(`Transaction failed: ${sendResult.status}`);
  }

  // Wait for confirmation
  let response = await server.getTransaction(sendResult.hash);
  while (response.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1000));
    response = await server.getTransaction(sendResult.hash);
  }

  return response;
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

export async function settleMatch(
  sessionId: number,
  seal: Uint8Array,
  journal: Uint8Array,
): Promise<void> {
  await callContract("settle_match", [
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
