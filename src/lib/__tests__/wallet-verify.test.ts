import { describe, it, expect, vi, beforeEach } from "vitest";

const mockVerifyMessage = vi.fn();
const mockCreatePublicClient = vi.fn((..._args: unknown[]) => ({
  verifyMessage: mockVerifyMessage,
}));

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createPublicClient: (...args: unknown[]) => mockCreatePublicClient(...args),
  };
});

const stubEnv = () => {
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_ANON_KEY", "key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
  vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
  vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
};

describe("verifyWalletSignature (CC-069)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockCreatePublicClient.mockClear();
    mockVerifyMessage.mockReset();
  });

  it("delegates to a public client's verifyMessage — ERC-6492/1271-aware, not raw ecrecover", async () => {
    stubEnv();
    mockVerifyMessage.mockResolvedValue(true);

    const { verifyWalletSignature } = await import("@/lib/wallet/verify");

    const result = await verifyWalletSignature({
      address: "0x3bE93502BF48bFbbB4f6c065E7f663a97DF5ce44",
      message: "hello",
      signature: "0xsig",
    });

    expect(result).toBe(true);
    expect(mockCreatePublicClient).toHaveBeenCalled();
    expect(mockVerifyMessage).toHaveBeenCalledWith({
      address: "0x3bE93502BF48bFbbB4f6c065E7f663a97DF5ce44",
      message: "hello",
      signature: "0xsig",
    });
  });

  it("returns false when the public client reports an invalid signature", async () => {
    stubEnv();
    mockVerifyMessage.mockResolvedValue(false);

    const { verifyWalletSignature } = await import("@/lib/wallet/verify");

    const result = await verifyWalletSignature({
      address: "0x3bE93502BF48bFbbB4f6c065E7f663a97DF5ce44",
      message: "hello",
      signature: "0xbadsig",
    });

    expect(result).toBe(false);
  });

  it("reuses the cached client across calls", async () => {
    stubEnv();
    mockVerifyMessage.mockResolvedValue(true);

    const { verifyWalletSignature } = await import("@/lib/wallet/verify");

    await verifyWalletSignature({
      address: "0x3bE93502BF48bFbbB4f6c065E7f663a97DF5ce44",
      message: "one",
      signature: "0xsig",
    });
    await verifyWalletSignature({
      address: "0x3bE93502BF48bFbbB4f6c065E7f663a97DF5ce44",
      message: "two",
      signature: "0xsig",
    });

    expect(mockCreatePublicClient).toHaveBeenCalledTimes(1);
  });

  it("_resetVerifyClient forces a fresh client on the next call", async () => {
    stubEnv();
    mockVerifyMessage.mockResolvedValue(true);

    const { verifyWalletSignature, _resetVerifyClient } = await import(
      "@/lib/wallet/verify"
    );

    await verifyWalletSignature({
      address: "0x3bE93502BF48bFbbB4f6c065E7f663a97DF5ce44",
      message: "one",
      signature: "0xsig",
    });
    _resetVerifyClient();
    await verifyWalletSignature({
      address: "0x3bE93502BF48bFbbB4f6c065E7f663a97DF5ce44",
      message: "two",
      signature: "0xsig",
    });

    expect(mockCreatePublicClient).toHaveBeenCalledTimes(2);
  });
});
