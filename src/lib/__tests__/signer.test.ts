import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks — vi.mock factories are hoisted so referenced values must be too
const { mockCreateKmsAccount, mockSimulateContract, mockWriteContract, mockWaitForReceipt } = vi.hoisted(() => ({
  mockCreateKmsAccount: vi.fn(),
  mockSimulateContract: vi.fn(),
  mockWriteContract: vi.fn(),
  mockWaitForReceipt: vi.fn(),
}));

vi.mock("@/lib/contracts/kms-signer", () => ({
  createKmsAccount: mockCreateKmsAccount,
}));

/**
 * CC-060: viem's clients are mocked so this file cannot reach the network.
 *
 * It previously could, and did. The KMS test called completeTaskOnChain inside a bare
 * try/catch and asserted only that createKmsAccount had been reached, on the stated
 * assumption that simulateContract "will fail since there's no RPC". There is an RPC —
 * getChainConfig() falls back to the public Base Sepolia endpoint — and an eth_call
 * against a codeless address succeeds rather than reverting, so writeContract ran and
 * broadcast a real transaction (0x1cc38f04…, block 44801606).
 *
 * The suite stayed green throughout, because "a mock was reached, inside a try/catch"
 * remained true after the behaviour underneath it changed shape entirely.
 *
 * Mocking the transport is what makes that impossible rather than unlikely. The
 * assertions below check the *intent* — that simulateContract is called with the right
 * arguments and its prepared request is what gets written — instead of relying on a
 * throw that turned out never to happen.
 */
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      simulateContract: mockSimulateContract,
      waitForTransactionReceipt: mockWaitForReceipt,
    }),
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

describe("signer", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockCreateKmsAccount.mockReset();
    mockSimulateContract.mockReset();
    mockWriteContract.mockReset();
    mockWaitForReceipt.mockReset();
    // Default happy path: simulate returns a prepared request, write returns a hash,
    // and the receipt confirms it (CC-081 Defect 3).
    mockSimulateContract.mockResolvedValue({ request: { __prepared: true } });
    mockWriteContract.mockResolvedValue("0x" + "ff".repeat(32));
    mockWaitForReceipt.mockResolvedValue({
      status: "success",
      transactionHash: "0x" + "ff".repeat(32),
      blockNumber: BigInt(12345),
    });
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

    // The transport is mocked, so this completes rather than throwing. No try/catch —
    // if it rejects, that is a real failure and the test should say so.
    const { completeTaskOnChain } = await import("@/lib/contracts/signer");
    const taskId = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const hash = await completeTaskOnChain(taskId);

    expect(mockCreateKmsAccount).toHaveBeenCalled();
    expect(hash).toBe("0x" + "ff".repeat(32));
  });

  it("simulates completeTask with the expected arguments before writing", async () => {
    stubEnv();
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);

    const { completeTaskOnChain } = await import("@/lib/contracts/signer");
    const taskId = ("0x" + "ab".repeat(32)) as `0x${string}`;
    await completeTaskOnChain(taskId);

    // Asserting the intent, which is what the old try/catch could not do.
    expect(mockSimulateContract).toHaveBeenCalledTimes(1);
    expect(mockSimulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "0x1234567890123456789012345678901234567890",
        functionName: "completeTask",
        args: [taskId],
      }),
    );
  });

  it("writes exactly the request simulateContract prepared", async () => {
    stubEnv();
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);
    const prepared = { __prepared: "only-this" };
    mockSimulateContract.mockResolvedValue({ request: prepared });

    const { completeTaskOnChain } = await import("@/lib/contracts/signer");
    await completeTaskOnChain(("0x" + "ab".repeat(32)) as `0x${string}`);

    // The simulate → write handoff is the step that turns a dry run into a real
    // transaction, so it is worth asserting rather than assuming.
    expect(mockWriteContract).toHaveBeenCalledTimes(1);
    expect(mockWriteContract).toHaveBeenCalledWith(prepared);
  });

  it("does not write when simulateContract rejects", async () => {
    stubEnv();
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);
    mockSimulateContract.mockRejectedValue(new Error("execution reverted: only agent"));

    const { completeTaskOnChain } = await import("@/lib/contracts/signer");
    await expect(
      completeTaskOnChain(("0x" + "ab".repeat(32)) as `0x${string}`),
    ).rejects.toThrow("only agent");

    // This is the property the original test assumed and never checked. It is also the
    // live behaviour of completeTask today — CC-080, ADR-0001 D2 — so a revert here is
    // the expected path, not an edge case.
    expect(mockWriteContract).not.toHaveBeenCalled();
  });

  // ── CC-081 Defect 3: confirmation before return ─────────────────────────────

  it("resolveDisputeOnChain waits for the receipt before returning the hash", async () => {
    stubEnv();
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);
    const confirmed = "0x" + "ee".repeat(32);
    mockWaitForReceipt.mockResolvedValue({
      status: "success",
      transactionHash: confirmed,
      blockNumber: BigInt(999),
    });

    const { resolveDisputeOnChain } = await import("@/lib/contracts/signer");
    const taskId = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const hash = await resolveDisputeOnChain(taskId, true);

    expect(mockWaitForReceipt).toHaveBeenCalledTimes(1);
    expect(mockWaitForReceipt).toHaveBeenCalledWith({
      hash: "0x" + "ff".repeat(32),
    });
    // The receipt's hash, not the raw writeContract return — under a hash-and-send
    // flow these can differ (replacement detection), and only the receipt is confirmed.
    expect(hash).toBe(confirmed);
  });

  it("expireTaskOnChain waits for the receipt before returning the hash", async () => {
    stubEnv();
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);
    const confirmed = "0x" + "dd".repeat(32);
    mockWaitForReceipt.mockResolvedValue({
      status: "success",
      transactionHash: confirmed,
      blockNumber: BigInt(999),
    });

    const { expireTaskOnChain } = await import("@/lib/contracts/signer");
    const taskId = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const hash = await expireTaskOnChain(taskId);

    expect(mockWaitForReceipt).toHaveBeenCalledTimes(1);
    expect(mockWaitForReceipt).toHaveBeenCalledWith({
      hash: "0x" + "ff".repeat(32),
    });
    expect(hash).toBe(confirmed);
  });

  it("resolveDisputeOnChain throws when the transaction reverts after submission", async () => {
    stubEnv();
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);
    // The failure Defect 3 is about: writeContract *succeeds* (the tx was submitted),
    // but it reverts on-chain. Pre-fix, the function returned the hash and the caller
    // recorded the outcome as settled.
    mockWaitForReceipt.mockResolvedValue({
      status: "reverted",
      transactionHash: "0x" + "ff".repeat(32),
      blockNumber: BigInt(999),
    });

    const { resolveDisputeOnChain } = await import("@/lib/contracts/signer");
    const taskId = ("0x" + "ab".repeat(32)) as `0x${string}`;

    await expect(resolveDisputeOnChain(taskId, false)).rejects.toThrow(
      "reverted on-chain",
    );
  });

  it("expireTaskOnChain throws when the transaction reverts after submission", async () => {
    stubEnv();
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);
    mockWaitForReceipt.mockResolvedValue({
      status: "reverted",
      transactionHash: "0x" + "ff".repeat(32),
      blockNumber: BigInt(999),
    });

    const { expireTaskOnChain } = await import("@/lib/contracts/signer");
    const taskId = ("0x" + "ab".repeat(32)) as `0x${string}`;

    await expect(expireTaskOnChain(taskId)).rejects.toThrow(
      "reverted on-chain",
    );
  });

  it("propagates a receipt-wait failure rather than returning a submitted-only hash", async () => {
    stubEnv();
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", TEST_PRIVATE_KEY);
    mockWaitForReceipt.mockRejectedValue(new Error("transaction replaced"));

    const { resolveDisputeOnChain } = await import("@/lib/contracts/signer");
    const taskId = ("0x" + "ab".repeat(32)) as `0x${string}`;

    await expect(resolveDisputeOnChain(taskId, true)).rejects.toThrow(
      "transaction replaced",
    );
  });

  // Integration coverage for these functions against a real chain belongs in
  // scripts/audit/, not here: a unit test that reaches the network is
  // non-deterministic and can broadcast. See vitest.setup.ts.
});
