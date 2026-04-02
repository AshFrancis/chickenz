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
const CHICKENZ_CONTRACT = process.env.CHICKENZ_CONTRACT || "CBRDPRKUK3NH2HXOWSNZPG2ZSXXXZBR7GCMN7WLHWINMLNDCJ7NSREKG";
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

// All contracts whose instance + WASM TTL we keep alive
const CONTRACTS_TO_EXTEND = [
  CHICKENZ_CONTRACT,
  process.env.VERIFIER_CONTRACT || "CDUDXCLMNE7Q4BZJLLB3KACFOS55SS55GSQW2UYHDUXTJKZUDDAJYCIH",
  process.env.GAME_HUB_CONTRACT || "CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG",
];

const EXTEND_TTL_LEDGERS = 518_400; // ~30 days

/** Extend instance + WASM code TTL for all deployed contracts. */
export async function extendContractTtls(): Promise<void> {
  const admin = getAdmin();
  if (!admin || !StellarSdk) {
    console.warn("[stellar] No admin key or SDK, skipping TTL extension");
    return;
  }

  const server = new StellarSdk.rpc.Server(RPC_URL);

  for (const contractId of CONTRACTS_TO_EXTEND) {
    try {
      // Get the contract instance entry to find the WASM hash
      const contractAddress = new StellarSdk.Address(contractId);
      const instanceKey = StellarSdk.xdr.LedgerKey.contractData(
        new StellarSdk.xdr.LedgerKeyContractData({
          contract: contractAddress.toScAddress(),
          key: StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: StellarSdk.xdr.ContractDataDurability.persistent(),
        }),
      );

      // Build extend footprint TTL operation for the instance
      const account = await server.getAccount(admin.publicKey());
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: "1000000",
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          StellarSdk.Operation.extendFootprintTtl({
            extendTo: EXTEND_TTL_LEDGERS,
          }),
        )
        .setTimeout(60)
        .setSorobanData(new StellarSdk.SorobanDataBuilder().setReadOnly([instanceKey]).build())
        .build();

      const simResult = await server.simulateTransaction(tx);
      if (StellarSdk.rpc.Api.isSimulationError(simResult)) {
        console.error(`[stellar] TTL extend simulation failed for ${contractId}: ${simResult.error}`);
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prepared = StellarSdk.rpc.assembleTransaction(tx, simResult as any).build();
      prepared.sign(admin);

      const sendResult = await server.sendTransaction(prepared);
      if (sendResult.status === "ERROR") {
        console.error(`[stellar] TTL extend send failed for ${contractId}`);
        continue;
      }

      // Wait for confirmation
      let response = await server.getTransaction(sendResult.hash);
      let retries = 0;
      while (response.status === "NOT_FOUND") {
        if (++retries > 30) break;
        await new Promise((r) => setTimeout(r, 1000));
        response = await server.getTransaction(sendResult.hash);
      }

      if (response.status === "SUCCESS") {
        console.log(`[stellar] TTL extended for ${contractId}: ${sendResult.hash}`);
      } else {
        console.error(`[stellar] TTL extend failed for ${contractId}: ${response.status}`);
      }
    } catch (err) {
      console.error(`[stellar] TTL extend error for ${contractId}:`, err);
    }
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

/** Verify a settle tx hash actually called settle_match on our contract for the given sessionId.
 *  Parses the transaction envelope to confirm contract address and session ID argument. */
export async function verifySettleTxOnChain(txHash: string, sessionId: number): Promise<boolean> {
  if (!StellarSdk) return false;
  try {
    const server = new StellarSdk.rpc.Server(RPC_URL);
    const response = await server.getTransaction(txHash);
    if (response.status !== "SUCCESS") return false;
    // Parse the transaction envelope to verify the invoked contract and session ID
    try {
      const envelope = StellarSdk.xdr.TransactionEnvelope.fromXDR(response.envelopeXdr, "base64");
      const ops = envelope.tx().operations();
      for (const op of ops) {
        if (op.body().switch().name !== "invokeHostFunction") continue;
        const hostFn = op.body().invokeHostFunctionOp().hostFunction();
        if (hostFn.switch().name !== "hostFunctionTypeInvokeContract") continue;
        const args = hostFn.invokeContract();
        const contractId = StellarSdk.StrKey.encodeContract(args.contractAddress().contractId());
        if (contractId !== CHICKENZ_CONTRACT) continue;
        if (args.functionName().toString() !== "settle_match") continue;
        const invokeArgs = args.args();
        if (invokeArgs.length > 0 && Number(StellarSdk.scValToNative(invokeArgs[0])) === sessionId) {
          return true;
        }
      }
      return false;
    } catch {
      // Envelope parsing failed — fall back to just checking tx success
      return true;
    }
  } catch {
    return false;
  }
}
