/**
 * CC-070 — chunked eth_getLogs and state-based reputation reads.
 *
 * Fully hermetic: viem's createPublicClient is mocked, so nothing here touches the
 * network. That is deliberate — see CC-060, where a test that was assumed to be a mock
 * turned out to be broadcasting real transactions to Base Sepolia.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ESCROW = "0xb9bF8dAC51f62cA237F2C439c63c9D8f16FD2ef7";
const WORKER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

const mocks = vi.hoisted(() => ({
  getLogs: vi.fn(),
  getBlockNumber: vi.fn(),
  readContract: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      getLogs: mocks.getLogs,
      getBlockNumber: mocks.getBlockNumber,
      readContract: mocks.readContract,
    }),
  };
});

function stubBaseEnv(extra: Record<string, string> = {}) {
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_ANON_KEY", "key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
  vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
  vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  vi.stubEnv("NEXT_PUBLIC_ESCROW_CONTRACT", ESCROW);
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
}

/** A task struct as viem decodes it from getTask(). */
function task(state: number, worker = WORKER, amountUnits = BigInt(1_000_000)) {
  return {
    agent: OTHER,
    worker,
    amount: amountUnits,
    deadline: BigInt(0),
    state,
  };
}

describe("CC-070 — chunked getLogs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mocks.getLogs.mockReset();
    mocks.getBlockNumber.mockReset();
    mocks.readContract.mockReset();
  });

  it("never requests a span wider than RPC_MAX_BLOCK_RANGE", async () => {
    stubBaseEnv({ ESCROW_DEPLOY_BLOCK: "1000", RPC_MAX_BLOCK_RANGE: "1000" });
    mocks.getBlockNumber.mockResolvedValue(BigInt(4500));
    mocks.getLogs.mockResolvedValue([]);

    const { getTaskResolvedOutcome } = await import("@/lib/contracts/escrow");
    await getTaskResolvedOutcome("nope");

    expect(mocks.getLogs).toHaveBeenCalled();
    for (const call of mocks.getLogs.mock.calls) {
      const { fromBlock, toBlock } = call[0];
      // Inclusive span, so the difference must be strictly under the cap.
      expect(toBlock - fromBlock).toBeLessThan(BigInt(1000));
      expect(toBlock).toBeGreaterThanOrEqual(fromBlock);
    }
  });

  it("starts at ESCROW_DEPLOY_BLOCK, not genesis", async () => {
    stubBaseEnv({ ESCROW_DEPLOY_BLOCK: "39032720", RPC_MAX_BLOCK_RANGE: "10000" });
    mocks.getBlockNumber.mockResolvedValue(BigInt(39_042_720));
    mocks.getLogs.mockResolvedValue([]);

    const { getTaskResolvedOutcome } = await import("@/lib/contracts/escrow");
    await getTaskResolvedOutcome("nope");

    const lowest = mocks.getLogs.mock.calls
      .map((c) => c[0].fromBlock as bigint)
      .reduce((a, b) => (a < b ? a : b));
    expect(lowest).toBe(BigInt(39_032_720));
  });

  it("covers the whole range with contiguous, non-overlapping windows", async () => {
    stubBaseEnv({ ESCROW_DEPLOY_BLOCK: "100", RPC_MAX_BLOCK_RANGE: "1000" });
    mocks.getBlockNumber.mockResolvedValue(BigInt(2600));
    mocks.getLogs.mockResolvedValue([]);

    const { getTaskResolvedOutcome } = await import("@/lib/contracts/escrow");
    await getTaskResolvedOutcome("nope");

    const ranges = mocks.getLogs.mock.calls
      .map((c) => [c[0].fromBlock as bigint, c[0].toBlock as bigint])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));

    expect(ranges[0][0]).toBe(BigInt(100));
    expect(ranges[ranges.length - 1][1]).toBe(BigInt(2600));
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i][0]).toBe(ranges[i - 1][1] + BigInt(1));
    }
  });

  it("scans newest-first and stops as soon as the event is found", async () => {
    stubBaseEnv({ ESCROW_DEPLOY_BLOCK: "0", RPC_MAX_BLOCK_RANGE: "1000" });
    mocks.getBlockNumber.mockResolvedValue(BigInt(100_000));
    // Only the newest window has the event.
    mocks.getLogs.mockImplementation(async ({ fromBlock }: { fromBlock: bigint }) =>
      fromBlock >= BigInt(99_000)
        ? [{ blockNumber: BigInt(99_500), logIndex: 0, args: { releasedToWorker: true, amount: BigInt(1_000_000) } }]
        : [],
    );

    const { getTaskResolvedOutcome } = await import("@/lib/contracts/escrow");
    const out = await getTaskResolvedOutcome("resolved-task");

    expect(out).toEqual({ releasedToWorker: true, amount: BigInt(1_000_000) });
    // A full ascending scan would be 100 calls. Newest-first + early exit is 1.
    expect(mocks.getLogs).toHaveBeenCalledTimes(1);
  });

  it("returns null after scanning the full range when nothing matches", async () => {
    stubBaseEnv({ ESCROW_DEPLOY_BLOCK: "0", RPC_MAX_BLOCK_RANGE: "1000" });
    mocks.getBlockNumber.mockResolvedValue(BigInt(5_000));
    mocks.getLogs.mockResolvedValue([]);

    const { getTaskResolvedOutcome } = await import("@/lib/contracts/escrow");
    expect(await getTaskResolvedOutcome("never-resolved")).toBeNull();
    // 0..5000 in 1000-block windows = 6 windows, all scanned.
    expect(mocks.getLogs).toHaveBeenCalledTimes(6);
  });

  it("is a no-op when the range is empty rather than issuing a bad query", async () => {
    stubBaseEnv({ ESCROW_DEPLOY_BLOCK: "5000", RPC_MAX_BLOCK_RANGE: "1000" });
    mocks.getBlockNumber.mockResolvedValue(BigInt(4_000)); // head behind the deploy block
    mocks.getLogs.mockResolvedValue([]);

    const { getTaskResolvedOutcome } = await import("@/lib/contracts/escrow");
    expect(await getTaskResolvedOutcome("x")).toBeNull();
    expect(mocks.getLogs).not.toHaveBeenCalled();
  });
});

describe("CC-070 — reputation from on-chain state", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mocks.getLogs.mockReset();
    mocks.getBlockNumber.mockReset();
    mocks.readContract.mockReset();
  });

  it("issues no getLogs call at all", async () => {
    stubBaseEnv();
    mocks.readContract.mockResolvedValue(task(2));

    const { getOnChainReputationSummary } = await import("@/lib/contracts/escrow");
    await getOnChainReputationSummary(WORKER, ["a", "b"]);

    // The whole point of CC-070: the request path no longer scans event history.
    expect(mocks.getLogs).not.toHaveBeenCalled();
    expect(mocks.readContract).toHaveBeenCalledTimes(2);
  });

  it("counts each on-chain state and sums earnings from Completed only", async () => {
    stubBaseEnv();
    const byId: Record<string, ReturnType<typeof task>> = {
      done1: task(2, WORKER, BigInt(5_000_000)),
      done2: task(2, WORKER, BigInt(2_500_000)),
      open: task(1),
      fight: task(3),
      arbitrated: task(4, WORKER, BigInt(9_000_000)),
      lapsed: task(5),
    };
    // The caller passes toTaskId(id), so hash each known id to work out which task
    // this particular call is asking for.
    const { toTaskId } = await import("@/lib/contracts/escrow");
    mocks.readContract.mockImplementation(async ({ args }: { args: [string] }) => {
      const match = Object.keys(byId).find((k) => toTaskId(k) === args[0]);
      if (!match) throw new Error(`unexpected taskId ${args[0]}`);
      return byId[match];
    });

    const { getOnChainReputationSummary } = await import("@/lib/contracts/escrow");
    const s = await getOnChainReputationSummary(WORKER, Object.keys(byId));

    expect(s.total_tasks).toBe(6);
    expect(s.completed).toBe(2);
    expect(s.funded).toBe(1);
    expect(s.disputed).toBe(1);
    expect(s.resolved).toBe(1);
    expect(s.expired).toBe(1);
    // 5.0 + 2.5 only — the Resolved task's 9 USDC is excluded, because the state
    // alone does not say which way the owner arbitrated.
    expect(s.total_earned_usdc).toBe(7.5);
    expect(s.completedPaymentRequestIds.sort()).toEqual(["done1", "done2"]);
    expect(s.unverified).toEqual([]);
  });

  it("rejects a task whose on-chain worker is someone else", async () => {
    stubBaseEnv();
    mocks.readContract.mockResolvedValue(task(2, OTHER, BigInt(1_000_000)));

    const { getOnChainReputationSummary } = await import("@/lib/contracts/escrow");
    const s = await getOnChainReputationSummary(WORKER, ["stolen"]);

    // A DB row claiming someone else's task must not inflate this worker's record.
    expect(s.total_tasks).toBe(0);
    expect(s.completed).toBe(0);
    expect(s.total_earned_usdc).toBe(0);
    expect(s.unverified).toEqual(["stolen"]);
  });

  it("rejects an id with no on-chain task", async () => {
    stubBaseEnv();
    mocks.readContract.mockResolvedValue(task(0, "0x0000000000000000000000000000000000000000", BigInt(0)));

    const { getOnChainReputationSummary } = await import("@/lib/contracts/escrow");
    const s = await getOnChainReputationSummary(WORKER, ["phantom"]);

    expect(s.total_tasks).toBe(0);
    expect(s.unverified).toEqual(["phantom"]);
  });

  it("matches the worker address case-insensitively", async () => {
    stubBaseEnv();
    mocks.readContract.mockResolvedValue(task(2, WORKER.toUpperCase().replace("0X", "0x")));

    const { getOnChainReputationSummary } = await import("@/lib/contracts/escrow");
    const s = await getOnChainReputationSummary(WORKER.toLowerCase(), ["mixed"]);

    // Checksummed on-chain, lowercased in the DB — see the casing landmine.
    expect(s.completed).toBe(1);
    expect(s.unverified).toEqual([]);
  });

  it("short-circuits with no RPC call when given no ids", async () => {
    stubBaseEnv();

    const { getOnChainReputationSummary } = await import("@/lib/contracts/escrow");
    const s = await getOnChainReputationSummary(WORKER, []);

    expect(s.total_tasks).toBe(0);
    expect(mocks.readContract).not.toHaveBeenCalled();
  });
});
