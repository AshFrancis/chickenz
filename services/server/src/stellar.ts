import * as StellarSdk from "@stellar/stellar-sdk";

const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const CHICKENZ_CONTRACT = "CDYU5GFNDBIFYWLW54QV3LPDNQTER6ID3SK4QCCBVUY7NU76ESBP7LZP";
const ADMIN_SECRET = process.env.STELLAR_ADMIN_SECRET;

function getAdmin(): StellarSdk.Keypair | null {
  if (!ADMIN_SECRET) return null;
  try {
    return StellarSdk.Keypair.fromSecret(ADMIN_SECRET);
  } catch {
    console.error("Invalid STELLAR_ADMIN_SECRET");
    return null;
  }
}

async function submitTx(
  method: string,
  args: StellarSdk.xdr.ScVal[],
): Promise<void> {
  const admin = getAdmin();
  if (!admin) {
    console.warn(`[stellar] No admin key configured, skipping ${method}`);
    return;
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

  const prepared = StellarSdk.rpc.assembleTransaction(
    tx,
    simResult as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse,
  ).build();

  prepared.sign(admin);

  const sendResult = await server.sendTransaction(prepared);
  if (sendResult.status === "ERROR") {
    throw new Error(`Transaction send failed for ${method}: ${sendResult.status}`);
  }

  // Wait for confirmation
  let response = await server.getTransaction(sendResult.hash);
  while (response.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1000));
    response = await server.getTransaction(sendResult.hash);
  }

  if (response.status !== "SUCCESS") {
    throw new Error(`Transaction failed for ${method}: ${response.status}`);
  }

  console.log(`[stellar] ${method} succeeded: ${sendResult.hash}`);
}

/** Call start_match on the Chickenz Soroban contract. Fire-and-forget safe. */
export async function startMatchOnChain(
  sessionId: number,
  player1: string,
  player2: string,
  seedCommit: Uint8Array,
): Promise<void> {
  try {
    await submitTx("start_match", [
      StellarSdk.nativeToScVal(sessionId, { type: "u32" }),
      StellarSdk.nativeToScVal(player1, { type: "address" }),
      StellarSdk.nativeToScVal(player2, { type: "address" }),
      StellarSdk.nativeToScVal(Buffer.from(seedCommit), { type: "bytes" }),
    ]);
  } catch (err) {
    console.error("[stellar] startMatchOnChain failed:", err);
  }
}

/** Call settle_match on the Chickenz Soroban contract. */
export async function settleMatchOnChain(
  sessionId: number,
  seal: Uint8Array,
  journal: Uint8Array,
): Promise<void> {
  await submitTx("settle_match", [
    StellarSdk.nativeToScVal(sessionId, { type: "u32" }),
    StellarSdk.nativeToScVal(Buffer.from(seal), { type: "bytes" }),
    StellarSdk.nativeToScVal(Buffer.from(journal), { type: "bytes" }),
  ]);
}
