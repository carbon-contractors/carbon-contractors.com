import { describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential, type KmsWrapper } from "@/lib/evidence/credential-crypto";

/**
 * ADR-0010 — envelope encryption, with KMS replaced by a local wrapper that
 * enforces the same AAD binding Cloud KMS does. The production wrapper is the
 * one piece exercised only on a real deployment (like kms-signer.ts).
 */
function fakeKms(): KmsWrapper & { calls: number } {
  const store = new Map<string, { key: Buffer; aad: string }>();
  let n = 0;
  return {
    calls: 0,
    async wrap(key, aad) {
      this.calls++;
      const id = Buffer.from(`wrapped-${n++}`);
      store.set(id.toString(), { key: Buffer.from(key), aad: aad.toString() });
      return id;
    },
    async unwrap(wrapped, aad) {
      const entry = store.get(wrapped.toString());
      if (!entry || entry.aad !== aad.toString()) throw new Error("KMS: decryption failed");
      return Buffer.from(entry.key);
    },
  };
}

const CRED = {
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "super-secret-value",
  region: "ap-southeast-2",
};

describe("credential envelope (ADR-0010 D2)", () => {
  it("round-trips, and the stored envelope never contains the secret", async () => {
    const kms = fakeKms();
    const stored = await encryptCredential(CRED, "pr_1", kms);
    expect(stored).not.toContain("super-secret-value");
    expect(stored).not.toContain("AKIAEXAMPLE");
    expect(await decryptCredential(stored, "pr_1", kms)).toEqual(CRED);
  });

  it("refuses to decrypt under another task's id — the envelope is bound to its task", async () => {
    const kms = fakeKms();
    const stored = await encryptCredential(CRED, "pr_1", kms);
    await expect(decryptCredential(stored, "pr_2", kms)).rejects.toThrow();
  });

  it("detects tampering with the ciphertext", async () => {
    const kms = fakeKms();
    const env = JSON.parse(await encryptCredential(CRED, "pr_1", kms));
    const ct = Buffer.from(env.ct, "base64");
    ct[0] ^= 0xff;
    env.ct = ct.toString("base64");
    await expect(decryptCredential(JSON.stringify(env), "pr_1", kms)).rejects.toThrow();
  });

  it("uses a fresh data key per credential", async () => {
    const kms = fakeKms();
    const a = JSON.parse(await encryptCredential(CRED, "pr_1", kms));
    const b = JSON.parse(await encryptCredential(CRED, "pr_1", kms));
    expect(a.ct).not.toBe(b.ct);
    expect(a.iv).not.toBe(b.iv);
  });
});
