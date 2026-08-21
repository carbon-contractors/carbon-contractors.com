import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";

// A throwaway key — never funded, never used anywhere. The test suite strips
// real signing keys from the environment (CC-060), so the platform account is
// mocked to this one instead.
const TEST_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const TEST_ACCOUNT = privateKeyToAccount(TEST_KEY);

const mockGetPlatformAccount = vi.fn();
vi.mock("@/lib/contracts/signer", () => ({
  getPlatformAccount: (...args: unknown[]) => mockGetPlatformAccount(...args),
}));

// escrow.ts stays real except where the chain would be read — verdict-signer
// only uses getEscrowConfig/toTaskId, both pure.
vi.mock("@/lib/contracts/escrow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/contracts/escrow")>();
  return { ...actual };
});

import {
  VERDICT_TYPEHASH,
  VERDICT_TYPES,
  VERDICT_DEFAULT_TTL_S,
  buildVerdict,
  computeVerdictDigest,
  deserializeVerdict,
  serializeVerdict,
  signVerdict,
  recoverVerdictSigner,
  verifyPresentedVerdict,
  hashVerdictField,
  failureReasonHash,
  PLACEHOLDER_CHECKER_HASH,
  type SerializedVerdict,
} from "@/lib/contracts/verdict-signer";

const ESCROW = "0x1234567890123456789012345678901234567890";

function stubEnv() {
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_ANON_KEY", "key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
  vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
  vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  vi.stubEnv("NEXT_PUBLIC_ESCROW_CONTRACT", ESCROW);
}

const NOW = 1_800_000_000;
const NONCE = BigInt(42);

function makeVerdict(overrides: Partial<Parameters<typeof buildVerdict>[0]> = {}) {
  return buildVerdict({
    taskId: keccak256(toHex("pr_test")),
    specHash: keccak256(toHex("spec")),
    evidenceHash: keccak256(toHex("evidence")),
    passed: false,
    checkerHash: PLACEHOLDER_CHECKER_HASH,
    breakdownHash: failureReasonHash("too blurry"),
    nowUnix: NOW,
    nonce: NONCE,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubEnv();
  mockGetPlatformAccount.mockResolvedValue(TEST_ACCOUNT);
});

describe("verdict-signer (CC-092)", () => {
  it("pins the type string to VERDICT_TYPEHASH in CarbonEscrow.sol", () => {
    // The digest is keccak256 over this exact string, so a renamed field in
    // either place silently invalidates every signature. Pin the pair.
    const sol = readFileSync("contracts/CarbonEscrow.sol", "utf8");
    const match = sol.match(/VERDICT_TYPEHASH\s*=\s*keccak256\(\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(VERDICT_TYPEHASH);
  });

  it("keeps the type field list in sync with the type string", () => {
    const fromTypes = VERDICT_TYPES.Verdict.map((f) => `${f.type} ${f.name}`).join(",");
    expect(VERDICT_TYPEHASH).toContain(fromTypes);
  });

  it("produces a well-formed EIP-712 digest", () => {
    expect(computeVerdictDigest(makeVerdict())).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic: same input, same digest", () => {
    expect(computeVerdictDigest(makeVerdict())).toBe(computeVerdictDigest(makeVerdict()));
  });

  it("buildVerdict stamps expiry at now + ttl and honours the injected nonce", () => {
    const verdict = makeVerdict({ ttlSeconds: 120 });
    expect(verdict.expiry).toBe(BigInt(NOW + 120));
    expect(verdict.nonce).toBe(NONCE);
  });

  it("defaults to the 1h TTL", () => {
    expect(makeVerdict().expiry).toBe(BigInt(NOW + VERDICT_DEFAULT_TTL_S));
  });

  it("survives a serialize → deserialize round trip", () => {
    const verdict = makeVerdict();
    const json = JSON.parse(JSON.stringify(serializeVerdict(verdict))) as SerializedVerdict;
    expect(deserializeVerdict(json)).toEqual(verdict);
  });

  it("signs with the platform account and recovers to it", async () => {
    const signed = await signVerdict(makeVerdict());
    expect(signed.signer).toBe(TEST_ACCOUNT.address);
    expect(await recoverVerdictSigner(signed.verdict, signed.signature)).toBe(
      TEST_ACCOUNT.address,
    );
    expect(signed.digest).toBe(computeVerdictDigest(signed.verdict));
  });

  it("hashVerdictField is keccak over UTF-8 bytes, and the failure hash is zero without a reason", () => {
    expect(hashVerdictField("abc")).toBe(keccak256(toHex("abc")));
    expect(failureReasonHash(undefined)).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(failureReasonHash("reason")).toBe(hashVerdictField("reason"));
  });
});

describe("verifyPresentedVerdict (CC-092 bare-assertion refusal)", () => {
  async function signOver(verdict: ReturnType<typeof makeVerdict>) {
    const { signature } = await signVerdict(verdict);
    return { serialized: serializeVerdict(verdict), signature };
  }

  it("accepts a failing verdict for a dispute", async () => {
    const { serialized, signature } = await signOver(makeVerdict({ passed: false }));
    const check = await verifyPresentedVerdict({
      paymentRequestId: "pr_test",
      serialized,
      signature,
      requirePassing: false,
      nowUnix: NOW,
    });
    expect(check.ok).toBe(true);
  });

  it("accepts a passing verdict for a claim", async () => {
    const { serialized, signature } = await signOver(makeVerdict({ passed: true }));
    const check = await verifyPresentedVerdict({
      paymentRequestId: "pr_test",
      serialized,
      signature,
      requirePassing: true,
      nowUnix: NOW,
    });
    expect(check.ok).toBe(true);
  });

  it("refuses a verdict naming a different task", async () => {
    const { serialized, signature } = await signOver(makeVerdict({ passed: false }));
    const check = await verifyPresentedVerdict({
      paymentRequestId: "pr_other",
      serialized,
      signature,
      requirePassing: false,
      nowUnix: NOW,
    });
    expect(check).toEqual({ ok: false, reason: expect.stringContaining("taskId mismatch") });
  });

  it("refuses a passing verdict presented for a dispute", async () => {
    const { serialized, signature } = await signOver(makeVerdict({ passed: true }));
    const check = await verifyPresentedVerdict({
      paymentRequestId: "pr_test",
      serialized,
      signature,
      requirePassing: false,
      nowUnix: NOW,
    });
    expect(check).toEqual({ ok: false, reason: expect.stringContaining("failing") });
  });

  it("refuses an expired verdict", async () => {
    const { serialized, signature } = await signOver(makeVerdict({ passed: false }));
    const check = await verifyPresentedVerdict({
      paymentRequestId: "pr_test",
      serialized,
      signature,
      requirePassing: false,
      nowUnix: NOW + VERDICT_DEFAULT_TTL_S + 1,
    });
    expect(check).toEqual({ ok: false, reason: "Verdict has expired" });
  });

  it("refuses a verdict signed by someone other than the platform signer", async () => {
    const { serialized } = await signOver(makeVerdict({ passed: false }));
    // Signed by a different throwaway key.
    const other = privateKeyToAccount(
      "0x0000000000000000000000000000000000000000000000000000000000000002",
    );
    const signature = await other.signTypedData({
      domain: {
        name: "CarbonEscrow",
        version: "2",
        chainId: 84532,
        verifyingContract: ESCROW,
      },
      types: VERDICT_TYPES,
      primaryType: "Verdict",
      message: makeVerdict({ passed: false }),
    });
    const check = await verifyPresentedVerdict({
      paymentRequestId: "pr_test",
      serialized,
      signature,
      requirePassing: false,
      nowUnix: NOW,
    });
    expect(check).toEqual({ ok: false, reason: expect.stringContaining("not from the platform") });
  });
});
