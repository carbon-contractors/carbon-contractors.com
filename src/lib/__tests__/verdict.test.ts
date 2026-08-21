import { describe, it, expect, vi, beforeEach } from "vitest";
import { recoverTypedDataAddress } from "viem";

// A valid 32-byte hex private key (Hardhat account #0, not a real key) — the same
// constant signer.test.ts uses, so both files pin against the same well-known address.
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const ESCROW = "0x1234567890123456789012345678901234567890";

const stubEnv = () => {
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_ANON_KEY", "key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
  vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  vi.stubEnv("NEXT_PUBLIC_ESCROW_CONTRACT", ESCROW);
  vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);
};

const FIXED_VERDICT = {
  taskId: `0x${"ab".repeat(32)}` as `0x${string}`,
  specHash: `0x${"cd".repeat(32)}` as `0x${string}`,
  evidenceHash: `0x${"ef".repeat(32)}` as `0x${string}`,
  checkerHash: `0x${"12".repeat(32)}` as `0x${string}`,
  passed: true,
  breakdownHash: `0x${"34".repeat(32)}` as `0x${string}`,
  expiry: BigInt(1800000000),
  nonce: BigInt(42),
};

describe("verdict", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("signs a verdict that recovers to the platform account's address", async () => {
    stubEnv();
    vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");

    const { signVerdict, VERDICT_TYPES } = await import("@/lib/contracts/verdict");
    const signature = await signVerdict(ESCROW, FIXED_VERDICT);

    const recovered = await recoverTypedDataAddress({
      domain: { name: "CarbonEscrow", version: "2", chainId: 84532, verifyingContract: ESCROW },
      types: VERDICT_TYPES,
      primaryType: "Verdict",
      message: FIXED_VERDICT,
      signature,
    });
    expect(recovered).toBe(TEST_ADDRESS);
  });

  it("produces a pinned signature — a preimage or encoding change must fail here, not on chain", async () => {
    stubEnv();
    vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");

    const { signVerdict } = await import("@/lib/contracts/verdict");
    const signature = await signVerdict(ESCROW, FIXED_VERDICT);

    // Computed once against contracts/CarbonEscrow.sol's VERDICT_TYPEHASH and
    // EIP712("CarbonEscrow", "2") domain, for the well-known Hardhat account #0 key.
    expect(signature).toBe(
      "0xca7b108ab98b2bd409662835a09b03259969f789a8d84d94493061467c2fd9cb2a5d3c2a3386118ec6c9b7440b5d4d05cbd9c7521656aa87121f64917ea5d4ae1c",
    );
  });

  it("binds the configured chain's id — a testnet and mainnet signature over the same verdict differ", async () => {
    stubEnv();

    vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
    const { signVerdict: signTestnet } = await import("@/lib/contracts/verdict");
    const testnetSig = await signTestnet(ESCROW, FIXED_VERDICT);

    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "mainnet");
    const { signVerdict: signMainnet } = await import("@/lib/contracts/verdict");
    const mainnetSig = await signMainnet(ESCROW, FIXED_VERDICT);

    expect(testnetSig).not.toBe(mainnetSig);
    expect(mainnetSig).toBe(
      "0xc70ddf1ba6fda3d858e22f75569af91e519456937f1effb63157622191542dee7c2b7bcb975785a8491121fc9915b05fdfadd88b86c81bedafb8f4638742fa3c1b",
    );
  });

  it("throws when the platform account cannot signTypedData", async () => {
    stubEnv();
    vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");

    vi.doMock("@/lib/contracts/signer", () => ({
      getPlatformAccount: vi.fn().mockResolvedValue({ address: "0x0", signTypedData: undefined }),
    }));

    const { signVerdict } = await import("@/lib/contracts/verdict");
    await expect(signVerdict(ESCROW, FIXED_VERDICT)).rejects.toThrow(
      "platform account cannot signTypedData",
    );
  });

  it("verdictTuple returns exactly the ABI-expected fields, nothing extra", async () => {
    const { verdictTuple } = await import("@/lib/contracts/verdict");
    expect(verdictTuple(FIXED_VERDICT)).toEqual(FIXED_VERDICT);
    expect(Object.keys(verdictTuple(FIXED_VERDICT))).toEqual(Object.keys(FIXED_VERDICT));
  });

  it("randomVerdictNonce produces distinct, in-range bigints", async () => {
    const { randomVerdictNonce } = await import("@/lib/contracts/verdict");
    const a = randomVerdictNonce();
    const b = randomVerdictNonce();
    expect(a).not.toBe(b);
    expect(a >= BigInt(0) && a < BigInt(2) ** BigInt(64)).toBe(true);
    expect(typeof a).toBe("bigint");
  });
});
