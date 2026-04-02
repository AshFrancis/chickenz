// ── Passkey wallet verification helpers ─────────────────────
import { hash, Keypair, StrKey, Address, xdr } from "@stellar/stellar-sdk";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export function base64UrlDecode(str: string): Uint8Array {
  // Restore standard base64: replace URL-safe chars, add padding
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** Replicate SAK's contract address derivation: credentialId → Stellar contract address. */
export function deriveSmartAccountAddress(credentialIdB64url: string): string {
  const credentialIdBuf = Buffer.from(base64UrlDecode(credentialIdB64url));
  const deployerKeypair = Keypair.fromRawEd25519Seed(hash(Buffer.from("openzeppelin-smart-account-kit")));
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(TESTNET_PASSPHRASE)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(deployerKeypair.publicKey()).toScAddress(),
          salt: hash(credentialIdBuf),
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

/** Convert DER-encoded ECDSA signature to raw r||s (64 bytes) for crypto.subtle. */
export function derToRaw(derSig: Uint8Array): Uint8Array {
  // DER: 0x30 [len] 0x02 [rLen] [r...] 0x02 [sLen] [s...]
  if (derSig.length < 8 || derSig[0] !== 0x30) throw new Error("Not a DER signature");
  let offset = 2; // skip 0x30 + total length
  if (derSig[1]! & 0x80) offset += derSig[1]! & 0x7f; // long form length (unlikely but handle)

  if (offset + 2 > derSig.length || derSig[offset] !== 0x02) throw new Error("Expected integer tag for r");
  const rLen = derSig[offset + 1]!;
  const rStart = offset + 2;
  if (rStart + rLen > derSig.length) throw new Error("DER r value truncated");
  const rBytes = derSig.subarray(rStart, rStart + rLen);

  const sOffset = rStart + rLen;
  if (sOffset + 2 > derSig.length || derSig[sOffset] !== 0x02) throw new Error("Expected integer tag for s");
  const sLen = derSig[sOffset + 1]!;
  const sStart = sOffset + 2;
  if (sStart + sLen > derSig.length) throw new Error("DER s value truncated");
  const sBytes = derSig.subarray(sStart, sStart + sLen);

  // Pad/trim to exactly 32 bytes each (remove leading zero padding, left-pad if short)
  const raw = new Uint8Array(64);
  const rTrimmed = rBytes[0] === 0 && rLen > 32 ? rBytes.subarray(1) : rBytes;
  const sTrimmed = sBytes[0] === 0 && sLen > 32 ? sBytes.subarray(1) : sBytes;
  raw.set(rTrimmed, 32 - rTrimmed.length);
  raw.set(sTrimmed, 64 - sTrimmed.length);
  return raw;
}

/** Verify a WebAuthn P-256 assertion signature. */
export async function verifyPasskeyAssertion(
  publicKeyBytes: Uint8Array,
  assertion: { authenticatorData: string; clientDataJSON: string; signature: string },
): Promise<boolean> {
  try {
    const authData = base64UrlDecode(assertion.authenticatorData);
    const clientDataJSON = base64UrlDecode(assertion.clientDataJSON);
    const signatureDer = base64UrlDecode(assertion.signature);

    // Signed data = authenticatorData || SHA-256(clientDataJSON)
    const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", Buffer.from(clientDataJSON)));
    const signedData = Buffer.alloc(authData.length + 32);
    signedData.set(authData);
    signedData.set(clientDataHash, authData.length);

    // Import P-256 public key
    const key = await crypto.subtle.importKey(
      "raw",
      Buffer.from(publicKeyBytes),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );

    // Convert DER signature to raw r||s format
    const rawSig = derToRaw(signatureDer);

    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(rawSig), signedData);
  } catch (err) {
    console.error("[wallet] Assertion verification error:", err);
    return false;
  }
}
