/**
 * kms-signer.ts
 * GCP Cloud KMS-backed Ethereum signer for viem.
 *
 * Authentication: Vercel OIDC -> GCP Workload Identity Federation -> short-lived token.
 * The private key never leaves Google's HSM. No static credentials exist.
 *
 * Falls back to DEPLOYER_PRIVATE_KEY for local development (see signer.ts).
 */

import { KeyManagementServiceClient } from "@google-cloud/kms";
import { IdentityPoolClient } from "google-auth-library";
import type { SubjectTokenSupplier } from "google-auth-library/build/src/auth/identitypoolclient";
import { toAccount, nonceManager } from "viem/accounts";
import type { LocalAccount } from "viem/accounts";
import {
  keccak256,
  getAddress,
  recoverAddress,
  serializeTransaction,
  hashMessage,
  hashTypedData,
  type Address,
  type Hex,
  type SignableMessage,
  type TransactionSerializable,
  type TypedDataDefinition,
} from "viem";
import { getConfig } from "@/lib/config";
import { log } from "@/lib/logging";

// ── Curve constants ─────────────────────────────────────────────────────────

const SECP256K1_ORDER = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / BigInt(2);

// ── Lazy-initialized clients ────────────────────────────────────────────────

let _kmsClient: KeyManagementServiceClient | null = null;
let _cachedAddress: Address | null = null;

// ── GCP Authentication via Workload Identity Federation ─────────────────────

async function getKmsClient(): Promise<KeyManagementServiceClient> {
  if (_kmsClient) return _kmsClient;

  const config = getConfig();
  const projectNumber = config.GCP_PROJECT_NUMBER;
  const poolId = config.GCP_WORKLOAD_IDENTITY_POOL_ID;
  const providerId = config.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID;
  const serviceAccountEmail = config.GCP_SERVICE_ACCOUNT_EMAIL;

  if (!projectNumber || !poolId || !providerId || !serviceAccountEmail) {
    throw new Error(
      "GCP Workload Identity Federation env vars not set. " +
        "Required: GCP_PROJECT_NUMBER, GCP_WORKLOAD_IDENTITY_POOL_ID, " +
        "GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID, GCP_SERVICE_ACCOUNT_EMAIL",
    );
  }

  // Dynamic import: @vercel/oidc only exists in Vercel runtime
  const { getVercelOidcToken } = await import("@vercel/oidc");

  const subjectTokenSupplier: SubjectTokenSupplier = {
    getSubjectToken: async () => getVercelOidcToken(),
  };

  const authClient = new IdentityPoolClient({
    type: "external_account",
    audience: `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`,
    subject_token_supplier: subjectTokenSupplier,
  });

  _kmsClient = new KeyManagementServiceClient({ authClient });
  return _kmsClient;
}

// ── DER Signature Parsing ───────────────────────────────────────────────────

export interface EthSignature {
  r: Hex;
  s: Hex;
  v: bigint;
}

/**
 * Parse an ASN.1 DER-encoded ECDSA signature into raw r and s BigInt values.
 * DER structure: SEQUENCE { INTEGER r, INTEGER s }
 *
 * Manual parsing — the structure is trivial for ECDSA and avoids an asn1js dependency.
 */
export function parseDerSignature(der: Uint8Array): {
  r: bigint;
  s: bigint;
} {
  if (der.length < 8 || der[0] !== 0x30) {
    throw new Error("Invalid DER: expected SEQUENCE tag (0x30)");
  }

  let offset = 2; // skip SEQUENCE tag + length

  // First INTEGER (r)
  if (der[offset] !== 0x02) {
    throw new Error("Invalid DER: expected INTEGER tag (0x02) for r");
  }
  const rLen = der[offset + 1];
  offset += 2;
  const rBytes = der.subarray(offset, offset + rLen);
  offset += rLen;

  // Second INTEGER (s)
  if (der[offset] !== 0x02) {
    throw new Error("Invalid DER: expected INTEGER tag (0x02) for s");
  }
  const sLen = der[offset + 1];
  offset += 2;
  const sBytes = der.subarray(offset, offset + sLen);

  // Strip leading zero byte (ASN.1 positive integer sign padding)
  const rHex = Buffer.from(rBytes[0] === 0x00 ? rBytes.subarray(1) : rBytes)
    .toString("hex")
    .padStart(64, "0");
  const sHex = Buffer.from(sBytes[0] === 0x00 ? sBytes.subarray(1) : sBytes)
    .toString("hex")
    .padStart(64, "0");

  return {
    r: BigInt("0x" + rHex),
    s: BigInt("0x" + sHex),
  };
}

// ── Low-S Normalization ─────────────────────────────────────────────────────

/**
 * Apply low-S normalization per EIP-2.
 * If s > secp256k1_order / 2, negate it: s = order - s.
 * Ethereum requires S in the lower half of the curve order.
 * KMS does not guarantee this — roughly half of signatures will have high S.
 */
export function normalizeSValue(s: bigint): bigint {
  if (s > SECP256K1_HALF_ORDER) {
    return SECP256K1_ORDER - s;
  }
  return s;
}

// ── DER -> Ethereum r/s/v Conversion ────────────────────────────────────────

/**
 * Convert a DER-encoded KMS signature to Ethereum's r/s/v format.
 * Applies low-S normalization and determines the recovery parameter (v)
 * by trying both candidates and verifying against the expected signer address.
 */
export async function derToEthSignature(
  msgHash: Hex,
  derBytes: Uint8Array,
  signerAddress: Address,
): Promise<EthSignature> {
  const { r, s: rawS } = parseDerSignature(derBytes);
  const s = normalizeSValue(rawS);

  const rHex = ("0x" + r.toString(16).padStart(64, "0")) as Hex;
  const sHex = ("0x" + s.toString(16).padStart(64, "0")) as Hex;

  // Try both recovery IDs to find correct v
  for (const v of [BigInt(27), BigInt(28)]) {
    try {
      const recovered = await recoverAddress({
        hash: msgHash,
        signature: { r: rHex, s: sHex, v },
      });
      if (recovered.toLowerCase() === signerAddress.toLowerCase()) {
        return { r: rHex, s: sHex, v };
      }
    } catch {
      // Try the other recovery ID
    }
  }

  throw new Error(
    "Could not determine recovery parameter v for KMS signature",
  );
}

// ── Public Key -> Ethereum Address ──────────────────────────────────────────

/**
 * Derive the Ethereum address from the KMS key's public key.
 * Fetches the PEM-encoded public key, extracts the uncompressed EC point,
 * and computes keccak256(x || y) -> last 20 bytes.
 */
export async function getEthAddressFromKms(): Promise<Address> {
  if (_cachedAddress) return _cachedAddress;

  const config = getConfig();
  const keyPath = config.GCP_KMS_KEY_PATH;
  if (!keyPath) throw new Error("GCP_KMS_KEY_PATH not set");

  const client = await getKmsClient();
  const [publicKey] = await client.getPublicKey({ name: keyPath });

  if (!publicKey.pem) {
    throw new Error("KMS returned no PEM public key");
  }

  // Parse PEM: strip header/footer, base64-decode to DER
  const pemBody = publicKey.pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s/g, "");
  const derBuf = Buffer.from(pemBody, "base64");

  // SubjectPublicKeyInfo DER for secp256k1:
  //   SEQUENCE { SEQUENCE { OID ecPublicKey, OID secp256k1 }, BIT STRING { 0x04 || x || y } }
  // The uncompressed point (65 bytes) is always at the end of the DER.
  const uncompressedPoint = derBuf.subarray(derBuf.length - 65);
  if (uncompressedPoint[0] !== 0x04) {
    throw new Error(
      "Expected uncompressed EC point (0x04 prefix) in KMS public key",
    );
  }

  // Ethereum address = last 20 bytes of keccak256(x || y)
  const rawPubKey = ("0x" +
    Buffer.from(uncompressedPoint.subarray(1)).toString("hex")) as Hex;
  const hash = keccak256(rawPubKey);
  const address = ("0x" + hash.slice(-40)) as Address;

  _cachedAddress = getAddress(address);
  log("info", "kms_signer_address_derived", { address: _cachedAddress });
  return _cachedAddress;
}

// ── KMS Sign Helper ─────────────────────────────────────────────────────────

/**
 * Sign a 32-byte digest via GCP Cloud KMS asymmetricSign.
 * For EC_SIGN_SECP256K1_SHA256 keys, passing digest.sha256 means KMS
 * signs the raw bytes directly without re-hashing. We pass the keccak256
 * hash as sha256 — this is the standard Ethereum + GCP KMS pattern.
 */
async function kmsSign(digest: Hex): Promise<Uint8Array> {
  const config = getConfig();
  const keyPath = config.GCP_KMS_KEY_PATH;
  if (!keyPath) throw new Error("GCP_KMS_KEY_PATH not set");

  const client = await getKmsClient();
  const digestBuf = Buffer.from(digest.slice(2), "hex");

  const [response] = await client.asymmetricSign({
    name: keyPath,
    digest: { sha256: digestBuf },
  });

  if (!response.signature) {
    throw new Error("KMS asymmetricSign returned no signature");
  }

  return new Uint8Array(
    typeof response.signature === "string"
      ? Buffer.from(response.signature, "base64")
      : (response.signature as Buffer),
  );
}

// ── Signature Encoding ──────────────────────────────────────────────────────

function encodeSignature(r: Hex, s: Hex, v: bigint): Hex {
  return (r + s.slice(2) + (v === BigInt(27) ? "1b" : "1c")) as Hex;
}

// ── viem Custom Account ─────────────────────────────────────────────────────

/**
 * Create a viem-compatible account backed by GCP Cloud KMS.
 * signMessage, signTransaction, and signTypedData all delegate to KMS.
 * nonceManager is attached for concurrent transaction safety (NOR-188 / AUD-003).
 */
export async function createKmsAccount(): Promise<LocalAccount> {
  const address = await getEthAddressFromKms();

  return toAccount({
    address,
    nonceManager,

    async signMessage({ message }: { message: SignableMessage }): Promise<Hex> {
      const hash = hashMessage(message);
      const derSig = await kmsSign(hash);
      const { r, s, v } = await derToEthSignature(hash, derSig, address);
      return encodeSignature(r, s, v);
    },

    async signTransaction(
      transaction: TransactionSerializable,
    ): Promise<Hex> {
      const serialized = serializeTransaction(transaction);
      const hash = keccak256(serialized);
      const derSig = await kmsSign(hash);
      const { r, s, v } = await derToEthSignature(hash, derSig, address);
      return serializeTransaction(transaction, {
        r,
        s,
        v,
      });
    },

    async signTypedData<
      const typedData extends Record<string, unknown>,
      primaryType extends keyof typedData | "EIP712Domain" = keyof typedData,
    >(parameters: TypedDataDefinition<typedData, primaryType>): Promise<Hex> {
      const hash = hashTypedData(parameters);
      const derSig = await kmsSign(hash);
      const { r, s, v } = await derToEthSignature(hash, derSig, address);
      return encodeSignature(r, s, v);
    },
  });
}

// ── Test Helpers ────────────────────────────────────────────────────────────

/** Reset cached KMS clients and address (for testing). */
export function _resetKmsClients(): void {
  _kmsClient = null;
  _cachedAddress = null;
}
