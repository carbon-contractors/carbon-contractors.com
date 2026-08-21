import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks — vi.mock factories are hoisted so referenced values must be too
const { mockCreateKmsAccount, mockSimulateContract, mockWriteContract } = vi.hoisted(() => ({
  mockCreateKmsAccount: vi.fn(),
  mockSimulateContract: vi.fn(),
  mockWriteContract: vi.fn(),
}));

vi.mock("@/lib/contracts/kms-signer", () => ({
  createKmsAccount: mockCreateKmsAccount,
}));

/**
 * CC-060: viem's clients are mocked so this file cannot reach the network.
 *
 * It previously could, and did. The KMS test called the write function under test inside
 * a bare try/catch and asserted only that createKmsAccount had been reached, on the
 * stated assumption that simulateContract "will fail since there's no RPC". There is an
 * RPC — getChainConfig() falls back to the public Base Sepolia endpoint — and an
 * eth_call against a codeless address succeeds rather than reverting, so writeContract
 * ran and broadcast a real transaction (0x1cc38f04…, block 44801606).
 *
 * The suite stayed green throughout, because "a mock was reached, inside a try/catch"
 * remained true after the behaviour underneath it changed shape entirely.
 *
 * Mocking the transport is what makes that impossible rather than unlikely. The
 * assertions below check the *intent* — that simulateContract is called with the right
 * arguments and its prepared request is what gets written — instead of relying on a
 * throw that turned out never to happen.
 *
 * CC-080: the function those tests exercised, completeTaskOnChain, is gone — it could
 * never succeed, because completeTask is agent-only and the platform signer is the
 * wrong sender. The same harness now covers the two remaining write functions
 * (resolveDisputeOnChain, expireTaskOnChain), and one test pins the removal itself:
 * a callable that always reverts is how the dead path survived unnoticed for so long.
 */
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({ simulateContract: mockSimulateContract }),
    createWalletClient: () => ({ writeContract: mockWriteContract }),
  };
});

// Env stubs shared across tests
const stubEnv = () => {
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_ANON_KEY", "key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
  vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
  vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  vi.stubEnv("NEXT_PUBLIC_ESCROW_CONTRACT", "0x1234567890123456789012345678901234567890");
};

// A valid 32-byte hex private key (Hardhat account #0, not a real key)
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const TASK_ID = ("0x" + "ab".repeat(32)) as `0x${string}`;

describe("signer", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockCreateKmsAccount.mockReset();
    mockSimulateContract.mockReset();
    mockWriteContract.mockReset();
    // Default happy path: simulate returns a prepared request, write returns a hash.
    mockSimulateContract.mockResolvedValue({ request: { __prepared: true } });
    mockWriteContract.mockResolvedValue("0x" + "ff".repeat(32));
  });

  it("no longer exports completeTaskOnChain — CC-080 removed it", async () => {
    stubEnv();
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);

    const signer = await import("@/lib/contracts/signer");
    expect((signer as Record<string, unknown>).completeTaskOnChain).toBeUndefined();
  });

  it("throws when NEXT_PUBLIC_ESCROW_CONTRACT is not set", async () => {
    stubEnv();
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);
    vi.stubEnv("NEXT_PUBLIC_ESCROW_CONTRACT", ""); // unset

    const { resolveDisputeOnChain } = await import("@/lib/contracts/signer");

    await expect(resolveDisputeOnChain(TASK_ID, true)).rejects.toThrow(
      "NEXT_PUBLIC_ESCROW_CONTRACT not set"
    );
  });

  it("exports the two remaining on-chain write functions", async () => {
    stubEnv();
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);

    const signer = await import("@/lib/contracts/signer");
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
    const { resolveDisputeOnChain } = await import("@/lib/contracts/signer");

    await expect(resolveDisputeOnChain(TASK_ID, true)).rejects.toThrow(
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

    // The transport is mocked, so this completes rather than throwing. No try/catch —
    // if it rejects, that is a real failure and the test should say so.
    const { expireTaskOnChain } = await import("@/lib/contracts/signer");
    const hash = await expireTaskOnChain(TASK_ID);

    expect(mockCreateKmsAccount).toHaveBeenCalled();
    expect(hash).toBe("0x" + "ff".repeat(32));
  });

  it("simulates each write with the expected arguments before writing", async () => {
    stubEnv();
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);

    const { resolveDisputeOnChain } = await import("@/lib/contracts/signer");
    await resolveDisputeOnChain(TASK_ID, true);

    // Asserting the intent, which is what the old try/catch could not do.
    expect(mockSimulateContract).toHaveBeenCalledTimes(1);
    expect(mockSimulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "0x1234567890123456789012345678901234567890",
        functionName: "resolveDispute",
        args: [TASK_ID, true],
      }),
    );
  });

  it("writes exactly the request simulateContract prepared", async () => {
    stubEnv();
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);
    const prepared = { __prepared: "only-this" };
    mockSimulateContract.mockResolvedValue({ request: prepared });

    const { resolveDisputeOnChain } = await import("@/lib/contracts/signer");
    await resolveDisputeOnChain(TASK_ID, false);

    // The simulate → write handoff is the step that turns a dry run into a real
    // transaction, so it is worth asserting rather than assuming.
    expect(mockWriteContract).toHaveBeenCalledTimes(1);
    expect(mockWriteContract).toHaveBeenCalledWith(prepared);
  });

  it("does not write when simulateContract rejects", async () => {
    stubEnv();
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);
    mockSimulateContract.mockRejectedValue(new Error("execution reverted: NotAgent()"));

    const { expireTaskOnChain } = await import("@/lib/contracts/signer");
    await expect(expireTaskOnChain(TASK_ID)).rejects.toThrow("NotAgent()");

    // This is the property the original test assumed and never checked.
    expect(mockWriteContract).not.toHaveBeenCalled();
  });

  // Integration coverage for these functions against a real chain belongs in
  // scripts/audit/, not here: a unit test that reaches the network is
  // non-deterministic and can broadcast. See vitest.setup.ts.
});
