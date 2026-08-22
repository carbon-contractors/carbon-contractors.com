import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mock — only getCurrentBlockTimestamp's tests below stub a return value;
// every other test in this file never calls getBlock, so the default undefined
// resolution is unreachable for them.
const { mockGetBlock } = vi.hoisted(() => ({ mockGetBlock: vi.fn() }));

// CC-060: real transport is blocked. Only createPublicClient is stubbed — every
// other viem export (keccak256, toHex, ...) stays real, since toTaskId's tests
// in this same file need them.
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({ getBlock: mockGetBlock }),
  };
});

describe("escrow helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockGetBlock.mockReset();
  });

  it("toTaskId produces deterministic bytes32 from payment_request_id", async () => {
    // Stub env so config doesn't throw
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_ANON_KEY", "key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
    vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
    vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");

    const { toTaskId } = await import("@/lib/contracts/escrow");
    const id1 = toTaskId("abc123");
    const id2 = toTaskId("abc123");
    const id3 = toTaskId("xyz789");

    expect(id1).toBe(id2); // deterministic
    expect(id1).not.toBe(id3); // different inputs → different outputs
    expect(id1).toMatch(/^0x[0-9a-f]{64}$/); // valid bytes32
  });

  it("getEscrowConfig returns null address when env not set", async () => {
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_ANON_KEY", "key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
    vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
    vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");

    const { getEscrowConfig } = await import("@/lib/contracts/escrow");
    const config = getEscrowConfig();
    expect(config.address).toBeNull();
    expect(config.chainId).toBeDefined();
  });

  it("getEscrowConfig returns address when env is set", async () => {
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_ANON_KEY", "key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
    vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
    vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    vi.stubEnv("NEXT_PUBLIC_ESCROW_CONTRACT", "0x1234567890123456789012345678901234567890");

    const { getEscrowConfig } = await import("@/lib/contracts/escrow");
    const config = getEscrowConfig();
    expect(config.address).toBe("0x1234567890123456789012345678901234567890");
  });

  // CC-092: /api/fund-task records this as tasks.funded_at.
  it("getCurrentBlockTimestamp reads the latest block's timestamp as a number", async () => {
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_ANON_KEY", "key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
    vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
    vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    mockGetBlock.mockResolvedValue({ timestamp: BigInt(1_700_000_000) });

    const { getCurrentBlockTimestamp } = await import("@/lib/contracts/escrow");
    const ts = await getCurrentBlockTimestamp();

    expect(ts).toBe(1_700_000_000);
    expect(typeof ts).toBe("number");
  });
});
