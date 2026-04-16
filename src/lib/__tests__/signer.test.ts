import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks — vi.mock factories are hoisted so referenced values must be too
const { mockCreateKmsAccount } = vi.hoisted(() => ({
  mockCreateKmsAccount: vi.fn(),
}));

vi.mock("@/lib/contracts/kms-signer", () => ({
  createKmsAccount: mockCreateKmsAccount,
}));

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
    mockCreateKmsAccount.mockReset();
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

  it("throws when neither GCP_KMS_KEY_PATH nor DEPLOYER_PRIVATE_KEY is set", async () => {
    stubEnv();
    // Neither key is set — should throw a descriptive error
    const { completeTaskOnChain } = await import("@/lib/contracts/signer");
    const taskId = ("0x" + "ab".repeat(32)) as `0x${string}`;

    await expect(completeTaskOnChain(taskId)).rejects.toThrow(
      "Neither GCP_KMS_KEY_PATH nor DEPLOYER_PRIVATE_KEY is set"
    );
  });

  it("uses KMS signer when GCP_KMS_KEY_PATH is set", async () => {
    stubEnv();
    vi.stubEnv("GCP_KMS_KEY_PATH", "projects/test/locations/us/keyRings/test/cryptoKeys/test/cryptoKeyVersions/1");
    vi.stubEnv("GCP_PROJECT_NUMBER", "123456");
    vi.stubEnv("GCP_WORKLOAD_IDENTITY_POOL_ID", "test-pool");
    vi.stubEnv("GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID", "vercel");
    vi.stubEnv("GCP_SERVICE_ACCOUNT_EMAIL", "test@test.iam.gserviceaccount.com");

    mockCreateKmsAccount.mockResolvedValue({
      address: "0x1234567890AbcdEF1234567890aBcdef12345678",
      type: "local",
      source: "custom",
      signMessage: vi.fn(),
      signTransaction: vi.fn(),
      signTypedData: vi.fn(),
    });

    // Trigger account creation by calling an on-chain function.
    // It will fail at simulateContract since there's no RPC, but
    // createKmsAccount should have been called.
    const { completeTaskOnChain } = await import("@/lib/contracts/signer");
    const taskId = ("0x" + "ab".repeat(32)) as `0x${string}`;
    try {
      await completeTaskOnChain(taskId);
    } catch {
      // Expected: no RPC node, but KMS account was created
    }

    expect(mockCreateKmsAccount).toHaveBeenCalled();
  });

  // Note: integration tests for completeTaskOnChain/resolveDisputeOnChain/expireTaskOnChain
  // require a running RPC node (Hardhat or fork) and are covered in e2e tests.
});
