/**
 * CC-036 — getTaskCompletion and readEasDomainInputs. Hermetic: viem's client is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ESCROW = "0xb9bF8dAC51f62cA237F2C439c63c9D8f16FD2ef7";
const WORKER = "0x1111111111111111111111111111111111111111";

const mocks = vi.hoisted(() => ({
  getLogs: vi.fn(),
  getBlockNumber: vi.fn(),
  getBlock: vi.fn(),
  readContract: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      getLogs: mocks.getLogs,
      getBlockNumber: mocks.getBlockNumber,
      getBlock: mocks.getBlock,
      readContract: mocks.readContract,
    }),
  };
});

const State = { Funded: 1, Completed: 3, Resolved: 6, Expired: 7 } as const;
const Z = `0x${"00".repeat(32)}`;

function task(state: number) {
  return {
    agent: "0x2222222222222222222222222222222222222222",
    worker: WORKER,
    amount: BigInt(25_000_000),
    deadline: BigInt(0),
    reviewWindow: 259200,
    submittedAt: BigInt(0),
    state,
    verdictPassed: false,
    disputedAt: BigInt(0),
    specHash: Z,
    evidenceHash: Z,
    verdictHash: Z,
    attestationUid: Z,
  };
}

describe("getTaskCompletion (CC-036)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    for (const m of Object.values(mocks)) m.mockReset();
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_ANON_KEY", "key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
    vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
    vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    vi.stubEnv("NEXT_PUBLIC_ESCROW_CONTRACT", ESCROW);
    vi.stubEnv("ESCROW_DEPLOY_BLOCK", "0");
    vi.stubEnv("RPC_MAX_BLOCK_RANGE", "1000");
    mocks.getBlockNumber.mockResolvedValue(BigInt(500));
    mocks.getBlock.mockResolvedValue({ timestamp: BigInt(1_760_832_000) });
  });

  it("reads the route from TaskCompleted and the time from that block, not the wall clock", async () => {
    mocks.readContract.mockResolvedValue(task(State.Completed));
    mocks.getLogs.mockResolvedValue([
      { blockNumber: BigInt(420), logIndex: 0, args: { route: 2, amount: BigInt(25_000_000) } },
    ]);
    const { getTaskCompletion } = await import("@/lib/contracts/escrow");
    expect(await getTaskCompletion("pr")).toEqual({
      routeRaw: 2,
      completedAt: BigInt(1_760_832_000),
      amount: BigInt(25_000_000),
    });
    expect(mocks.getBlock).toHaveBeenCalledWith({ blockNumber: BigInt(420) });
  });

  it("returns a null route for an owner ruling in the worker's favour", async () => {
    mocks.readContract.mockResolvedValue(task(State.Resolved));
    mocks.getLogs.mockResolvedValue([
      { blockNumber: BigInt(421), logIndex: 0, args: { releasedToWorker: true, amount: BigInt(7) } },
    ]);
    const { getTaskCompletion } = await import("@/lib/contracts/escrow");
    expect(await getTaskCompletion("pr")).toMatchObject({ routeRaw: null, amount: BigInt(7) });
  });

  it("is null when the ruling refunded the agent", async () => {
    mocks.readContract.mockResolvedValue(task(State.Resolved));
    mocks.getLogs.mockResolvedValue([
      { blockNumber: BigInt(421), logIndex: 0, args: { releasedToWorker: false, amount: BigInt(7) } },
    ]);
    const { getTaskCompletion } = await import("@/lib/contracts/escrow");
    expect(await getTaskCompletion("pr")).toBeNull();
  });

  it("is null, without scanning events, for a task still in flight or expired", async () => {
    for (const state of [State.Funded, State.Expired]) {
      mocks.readContract.mockResolvedValue(task(state));
      const { getTaskCompletion } = await import("@/lib/contracts/escrow");
      expect(await getTaskCompletion("pr")).toBeNull();
    }
    expect(mocks.getLogs).not.toHaveBeenCalled();
  });

  it("reads EAS version and domain separator from the predeploy", async () => {
    mocks.readContract.mockImplementation(async ({ functionName, address }) => {
      expect(address).toBe("0x4200000000000000000000000000000000000021");
      return functionName === "version" ? "1.2.0" : `0x${"64".repeat(32)}`;
    });
    const { readEasDomainInputs } = await import("@/lib/contracts/escrow");
    expect(await readEasDomainInputs()).toEqual({
      version: "1.2.0",
      domainSeparator: `0x${"64".repeat(32)}`,
    });
  });
});
