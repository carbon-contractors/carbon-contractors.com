import { describe, it, expect, vi, beforeEach } from "vitest";

// Env stubs shared across tests
const stubEnv = () => {
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_ANON_KEY", "key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
  vi.stubEnv("NEXT_PUBLIC_ONCHAINKIT_API_KEY", "key");
  vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
  vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  vi.stubEnv("NEXT_PUBLIC_ESCROW_CONTRACT", "0x1234567890123456789012345678901234567890");
};

// A valid 32-byte hex private key (Hardhat account #0, not a real key)
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("signer", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("throws when NEXT_PUBLIC_ESCROW_CONTRACT is not set", async () => {
    stubEnv();
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);
    vi.stubEnv("NEXT_PUBLIC_ESCROW_CONTRACT", ""); // unset

    const { completeTaskOnChain } = await import("@/lib/contracts/signer");
    const taskId = ("0x" + "ab".repeat(32)) as `0x${string}`;

    await expect(completeTaskOnChain(taskId)).rejects.toThrow(
      "NEXT_PUBLIC_ESCROW_CONTRACT not set"
    );
  });

  it("exports all three on-chain write functions", async () => {
    stubEnv();
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);

    const signer = await import("@/lib/contracts/signer");
    expect(typeof signer.completeTaskOnChain).toBe("function");
    expect(typeof signer.resolveDisputeOnChain).toBe("function");
    expect(typeof signer.expireTaskOnChain).toBe("function");
  });

  it("_resetSignerClients clears cached clients", async () => {
    stubEnv();
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);

    const { _resetSignerClients } = await import("@/lib/contracts/signer");
    expect(() => _resetSignerClients()).not.toThrow();
  });

  // Note: integration tests for completeTaskOnChain/resolveDisputeOnChain/expireTaskOnChain
  // require a running RPC node (Hardhat or fork) and are covered in e2e tests.
});
