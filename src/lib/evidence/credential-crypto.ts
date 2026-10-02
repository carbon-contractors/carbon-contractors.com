/**
 * credential-crypto.ts — envelope encryption for the agent's evidence-bucket
 * credential (ADR-0010 D2: "KMS-envelope-encrypted").
 *
 * Shape: a fresh 256-bit data key per credential encrypts the JSON with
 * AES-256-GCM; Cloud KMS wraps the data key under the dedicated symmetric key
 * `evidence-credentials` (ENCRYPT_DECRYPT, HSM). The stored envelope holds the
 * wrapped key, IV, tag and ciphertext — never the data key or the secret.
 *
 * Both layers bind the task: the payment_request_id is the GCM additional
 * authenticated data AND the KMS additionalAuthenticatedData, so an envelope
 * copied onto another task's row fails to decrypt rather than handing that
 * task's worker a grant into the wrong prefix.
 *
 * Identity: a separate service account (`evidence-creds-svc`), not the
 * contract-owner signer's. The account that can sign as owner must not also be
 * able to read agents' credentials, and vice versa. Same Vercel OIDC → Workload
 * Identity Federation path as kms-signer.ts; production-only by the
 * service account's IAM binding, so a preview deploy fails closed.
 *
 * Crypto-shredding note (ADR-0002 D9): the database row is DELETEd at terminal
 * state (migration 027), which leaves MVCC/PITR residue — but the residue is
 * ciphertext under a key only production can use. Destroying the KMS key
 * version is the backstop that makes old backups inert.
 *
 * Server-side only.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { IdentityPoolClient } from "google-auth-library";
import type { SubjectTokenSupplier } from "google-auth-library/build/src/auth/identitypoolclient";
import { getConfig } from "@/lib/config";
import type { BucketCredential } from "./presign";

/** What the agent hands over, beyond the key pair: where the bucket lives. */
export interface StoredCredential extends BucketCredential {
  region?: string;
  endpoint?: string;
}

interface EnvelopeV1 {
  v: 1;
  /** KMS-wrapped data key, base64. */
  wk: string;
  iv: string;
  tag: string;
  ct: string;
}

/** The KMS operations this module needs — injectable so tests run hermetic. */
export interface KmsWrapper {
  wrap(plaintextKey: Buffer, aad: Buffer): Promise<Buffer>;
  unwrap(wrappedKey: Buffer, aad: Buffer): Promise<Buffer>;
}

export function isEvidenceEncryptionConfigured(): boolean {
  return Boolean(getConfig().GCP_KMS_EVIDENCE_KEY_PATH);
}

let _client: KeyManagementServiceClient | null = null;

async function getClient(): Promise<KeyManagementServiceClient> {
  if (_client) return _client;
  // Same split as kms-signer.ts (CC-066): VERCEL is the one flag only Vercel's
  // runtime sets. Locally, Application Default Credentials.
  if (!process.env.VERCEL) {
    _client = new KeyManagementServiceClient();
    return _client;
  }
  const config = getConfig();
  const projectNumber = config.GCP_PROJECT_NUMBER;
  const poolId = config.GCP_WORKLOAD_IDENTITY_POOL_ID;
  const providerId = config.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID;
  const serviceAccountEmail = config.GCP_EVIDENCE_SERVICE_ACCOUNT_EMAIL;
  if (!projectNumber || !poolId || !providerId || !serviceAccountEmail) {
    throw new Error(
      "Evidence credential encryption needs GCP_PROJECT_NUMBER, GCP_WORKLOAD_IDENTITY_POOL_ID, " +
        "GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID and GCP_EVIDENCE_SERVICE_ACCOUNT_EMAIL in the Vercel runtime",
    );
  }
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
  _client = new KeyManagementServiceClient({ authClient });
  return _client;
}

/** The production wrapper: Cloud KMS encrypt/decrypt on the evidence key. */
export function cloudKmsWrapper(): KmsWrapper {
  const keyName = getConfig().GCP_KMS_EVIDENCE_KEY_PATH;
  if (!keyName) throw new Error("GCP_KMS_EVIDENCE_KEY_PATH is not set");
  return {
    async wrap(plaintextKey, aad) {
      const [res] = await (await getClient()).encrypt({
        name: keyName,
        plaintext: plaintextKey,
        additionalAuthenticatedData: aad,
      });
      if (!res.ciphertext) throw new Error("KMS encrypt returned no ciphertext");
      return Buffer.from(res.ciphertext as Uint8Array);
    },
    async unwrap(wrappedKey, aad) {
      // decrypt takes the key name without a version: KMS finds the version
      // from the ciphertext, which is what lets rotation just work.
      const [res] = await (await getClient()).decrypt({
        name: keyName,
        ciphertext: wrappedKey,
        additionalAuthenticatedData: aad,
      });
      if (!res.plaintext) throw new Error("KMS decrypt returned no plaintext");
      return Buffer.from(res.plaintext as Uint8Array);
    },
  };
}

export async function encryptCredential(
  credential: StoredCredential,
  paymentRequestId: string,
  kms: KmsWrapper = cloudKmsWrapper(),
): Promise<string> {
  const aad = Buffer.from(paymentRequestId, "utf8");
  const dataKey = randomBytes(32);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
    cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(JSON.stringify(credential), "utf8"), cipher.final()]);
    const envelope: EnvelopeV1 = {
      v: 1,
      wk: (await kms.wrap(dataKey, aad)).toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
    };
    return JSON.stringify(envelope);
  } finally {
    dataKey.fill(0);
  }
}

export async function decryptCredential(
  stored: string,
  paymentRequestId: string,
  kms: KmsWrapper = cloudKmsWrapper(),
): Promise<StoredCredential> {
  const envelope = JSON.parse(stored) as EnvelopeV1;
  if (envelope.v !== 1) throw new Error(`unknown credential envelope version ${String(envelope.v)}`);
  const aad = Buffer.from(paymentRequestId, "utf8");
  const dataKey = await kms.unwrap(Buffer.from(envelope.wk, "base64"), aad);
  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(envelope.ct, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(pt.toString("utf8")) as StoredCredential;
  } finally {
    dataKey.fill(0);
  }
}
