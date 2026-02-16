import {
  isConnected,
  getAddress,
  signTransaction,
} from "@stellar/freighter-api";
import * as StellarSdk from "@stellar/stellar-sdk";

const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

// Deployed contract addresses (testnet)
export const CHICKENZ_CONTRACT =
  "CDSSYXMYCB6SPU5TWUU4WEISYGOY2BMIP6RMVHLQ3HMMYHVSOO4IUYAM";
export const GAME_HUB_CONTRACT =
  "CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG";
export const VERIFIER_CONTRACT =
  "CDUDXCLMNE7Q4BZJLLB3KACFOS55SS55GSQW2UYHDUXTJKZUDDAJYCIH";

let connectedAddress: string | null = null;

export function getConnectedAddress(): string | null {
  return connectedAddress;
}

export async function connectWallet(): Promise<string> {
  const connected = await isConnected();
  if (!connected.isConnected) {
    throw new Error("Freighter wallet not found. Please install the extension.");
  }
  const result = await getAddress();
  if (result.error) {
    throw new Error(`Wallet connection failed: ${result.error}`);
  }
  connectedAddress = result.address;
  return result.address;
}

export async function disconnectWallet(): Promise<void> {
  connectedAddress = null;
}

function getRpc(): StellarSdk.rpc.Server {
  return new StellarSdk.rpc.Server(TESTNET_RPC);
}

async function callContract(
  method: string,
  args: StellarSdk.xdr.ScVal[],
): Promise<StellarSdk.rpc.Api.GetTransactionResponse> {
  if (!connectedAddress) throw new Error("Wallet not connected");

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

  const signResult = await signTransaction(prepared.toXDR(), {
    networkPassphrase: TESTNET_PASSPHRASE,
  });
  if (signResult.error) {
    throw new Error(`Signing failed: ${signResult.error}`);
  }

  const signed = StellarSdk.TransactionBuilder.fromXDR(
    signResult.signedTxXdr,
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
    StellarSdk.nativeToScVal(Buffer.from(seedCommit), { type: "bytes" }),
  ]);
}

export async function settleMatch(
  sessionId: number,
  seal: Uint8Array,
  journal: Uint8Array,
): Promise<void> {
  await callContract("settle_match", [
    StellarSdk.nativeToScVal(sessionId, { type: "u32" }),
    StellarSdk.nativeToScVal(Buffer.from(seal), { type: "bytes" }),
    StellarSdk.nativeToScVal(Buffer.from(journal), { type: "bytes" }),
  ]);
}

/** SHA-256 hash of a u32 seed (LE bytes) — matches the Rust prover's hash_seed(). */
export async function hashSeed(seed: number): Promise<Uint8Array> {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, seed, true); // little-endian
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return new Uint8Array(digest);
}
