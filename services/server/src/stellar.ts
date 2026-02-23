import { createHash } from "crypto";

// Lazy import — don't crash if @stellar/stellar-sdk isn't installed
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic import has no static types
let StellarSdk: any = null;
try {
  StellarSdk = await import("@stellar/stellar-sdk");
} catch {
  console.warn("[stellar] @stellar/stellar-sdk not installed, on-chain features disabled");
}

const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const CHICKENZ_CONTRACT = "CDYU5GFNDBIFYWLW54QV3LPDNQTER6ID3SK4QCCBVUY7NU76ESBP7LZP";
const ADMIN_SECRET = process.env.STELLAR_ADMIN_SECRET;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic SDK type
function getAdmin(): any | null {
  if (!StellarSdk || !ADMIN_SECRET) return null;
  try {
    return StellarSdk.Keypair.fromSecret(ADMIN_SECRET);
  } catch {
    console.error("Invalid STELLAR_ADMIN_SECRET");
    return null;
  }
}

async function submitTx(
  method: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic SDK ScVal args
  args: any[],
): Promise<string | null> {
  const admin = getAdmin();
  if (!admin) {
    console.warn(`[stellar] No admin key or SDK configured, skipping ${method}`);
    return null;
  }

  const server = new StellarSdk.rpc.Server(RPC_URL);
  const account = await server.getAccount(admin.publicKey());
  const contract = new StellarSdk.Contract(CHICKENZ_CONTRACT);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed for ${method}: ${simResult.error}`);
  }

  const prepared = StellarSdk.rpc
    .assembleTransaction(
      tx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch
      simResult as any,
    )
    .build();

  prepared.sign(admin);

  const sendResult = await server.sendTransaction(prepared);
  if (sendResult.status === "ERROR") {
    throw new Error(`Transaction send failed for ${method}: ${sendResult.status}`);
  }

  // Wait for confirmation
  let response = await server.getTransaction(sendResult.hash);
  let retries = 0;
  while (response.status === "NOT_FOUND") {
    if (++retries > 60) throw new Error(`Transaction polling timeout for ${method}`);
    await new Promise((r) => setTimeout(r, 1000));
    response = await server.getTransaction(sendResult.hash);
  }

  if (response.status !== "SUCCESS") {
    throw new Error(`Transaction failed for ${method}: ${response.status}`);
  }

  console.log(`[stellar] ${method} succeeded: ${sendResult.hash}`);
  return sendResult.hash;
}

/** Call start_match on the Chickenz Soroban contract. Fire-and-forget safe. */
export async function startMatchOnChain(
  sessionId: number,
  player1: string,
  player2: string,
  seedCommit: Uint8Array,
): Promise<string | null> {
  if (!StellarSdk) return null;
  try {
    return await submitTx("start_match", [
      StellarSdk.nativeToScVal(sessionId, { type: "u32" }),
      StellarSdk.nativeToScVal(player1, { type: "address" }),
      StellarSdk.nativeToScVal(player2, { type: "address" }),
      StellarSdk.nativeToScVal(Buffer.from(seedCommit), { type: "bytes" }),
    ]);
  } catch (err) {
    console.error("[stellar] startMatchOnChain failed:", err);
    return null;
  }
}

/** Call settle_match on the Chickenz Soroban contract. */
export async function settleMatchOnChain(
  sessionId: number,
  seal: Uint8Array,
  journal: Uint8Array,
): Promise<string | null> {
  if (!StellarSdk) return null;
  try {
    return await submitTx("settle_match", [
      StellarSdk.nativeToScVal(sessionId, { type: "u32" }),
      StellarSdk.nativeToScVal(Buffer.from(seal), { type: "bytes" }),
      StellarSdk.nativeToScVal(Buffer.from(journal), { type: "bytes" }),
    ]);
  } catch (err) {
    console.error("[stellar] settleMatchOnChain failed:", err);
    return null;
  }
}

/** Verify a Stellar transaction hash is successful on-chain. */
export async function verifyTxOnChain(txHash: string): Promise<boolean> {
  if (!StellarSdk) return false;
  try {
    const server = new StellarSdk.rpc.Server(RPC_URL);
    const response = await server.getTransaction(txHash);
    return response.status === "SUCCESS";
  } catch {
    return false;
  }
}

/** Verify a Stellar signature using Keypair.verify().
 *  Freighter's signMessage prefixes with "Stellar Signed Message:\n" and SHA-256 hashes before signing. */
export function verifySignature(publicKey: string, message: string, signature: string): boolean {
  if (!StellarSdk) return false;
  try {
    const keypair = StellarSdk.Keypair.fromPublicKey(publicKey);
    const prefixed = "Stellar Signed Message:\n" + message;
    const hash = createHash("sha256").update(Buffer.from(prefixed, "utf-8")).digest();
    const sigBytes = Buffer.from(signature, "base64");
    return keypair.verify(hash, sigBytes);
  } catch {
    return false;
  }
}
