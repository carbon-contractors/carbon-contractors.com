import { describe, it, expect, vi, beforeEach } from "vitest";
import { keccak256, toHex } from "viem";
import type { TaskRecord } from "@/lib/db/tasks";

const mockGetOnChainTask = vi.fn();
vi.mock("@/lib/contracts/escrow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/contracts/escrow")>();
  return {
    ...actual,
    getOnChainTask: (...args: unknown[]) => mockGetOnChainTask(...args),
    getEscrowConfig: () => ({
      address: "0x1234567890123456789012345678901234567890",
      chainId: 84532,
      chainName: "Base Sepolia",
      usdcDecimals: 6,
    }),
  };
});

const mockSignVerdict = vi.fn();
vi.mock("@/lib/contracts/verdict", () => ({
  signVerdict: (...args: unknown[]) => mockSignVerdict(...args),
  randomVerdictNonce: () => BigInt(42),
}));

const SPEC = '{"schema_version":1,"criteria":{"min_artefacts":1}}';
const SPEC_HASH = keccak256(toHex(SPEC));

const EVIDENCE = JSON.stringify({
  taskId: "abc",
  artifacts: [{ uri: "https://example.com/1.jpg" }],
  submittedAt: "2026-08-20T04:15:00Z",
});
const EVIDENCE_HASH = keccak256(toHex(EVIDENCE));

function baseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "1",
    payment_request_id: "pr_1",
    from_agent_wallet: "0xagent",
    to_human_wallet: "0xworker",
    task_description: "do the thing",
    amount_usdc: 10,
    deadline_unix: 9999999999,
    status: "active",
    tx_hash: "0xtx",
    escrow_contract: "0x1234567890123456789012345678901234567890",
    acceptance_spec: SPEC,
    spec_hash: SPEC_HASH,
    spec_schema_version: 1,
    offer_expiry_unix: null,
    funded_at: "2026-08-20T00:00:00.000Z",
    created_at: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function onChainTask(overrides: Record<string, unknown> = {}) {
  return {
    agent: "0xagent",
    worker: "0xworker",
    amount: BigInt(10_000_000),
    deadline: BigInt(9999999999),
    state: "Delivered",
    stateRaw: 2,
    reviewWindow: 172800,
    submittedAt: BigInt(1_692_500_000),
    reviewDeadline: BigInt(1_692_672_800),
    specHash: SPEC_HASH,
    evidenceHash: EVIDENCE_HASH,
    verdictHash: "0x" + "00".repeat(32),
    verdictPassed: false,
    attestationUid: "0x" + "00".repeat(32),
    ...overrides,
  };
}

describe("computeAndSignVerdict (CC-092)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignVerdict.mockResolvedValue("0xsignedsignedsignedsignedsignedsignedsignedsignedsignedsignedsigned");
  });

  it("computes a passing verdict and signs it", async () => {
    mockGetOnChainTask.mockResolvedValue(onChainTask());

    const { computeAndSignVerdict } = await import("@/lib/contracts/verdict-service");
    const result = await computeAndSignVerdict(baseTask(), EVIDENCE);

    expect(result.verdict.passed).toBe(true); // min_artefacts: 1, one artefact submitted
    expect(result.verdict.specHash).toBe(SPEC_HASH);
    expect(result.verdict.evidenceHash).toBe(EVIDENCE_HASH);
    expect(result.verdict.nonce).toBe(BigInt(42));
    expect(result.signature).toBe(
      "0xsignedsignedsignedsignedsignedsignedsignedsignedsignedsignedsigned",
    );
    expect(result.checks.length).toBeGreaterThan(0);
    expect(mockSignVerdict).toHaveBeenCalledWith(
      "0x1234567890123456789012345678901234567890",
      expect.objectContaining({ specHash: SPEC_HASH, evidenceHash: EVIDENCE_HASH }),
    );
  });

  it("computes a failing verdict when the checker's criteria are not met", async () => {
    const strictSpec = '{"schema_version":1,"criteria":{"min_artefacts":5}}';
    const strictHash = keccak256(toHex(strictSpec));
    mockGetOnChainTask.mockResolvedValue(onChainTask({ specHash: strictHash }));

    const { computeAndSignVerdict } = await import("@/lib/contracts/verdict-service");
    const result = await computeAndSignVerdict(
      baseTask({ acceptance_spec: strictSpec, spec_hash: strictHash }),
      EVIDENCE,
    );

    expect(result.verdict.passed).toBe(false);
    expect(result.checks[0].passed).toBe(false);
    // A failing verdict still gets signed — the platform signs what the checker
    // found, it does not withhold a signature based on the outcome.
    expect(mockSignVerdict).toHaveBeenCalledTimes(1);
  });

  it("throws VerdictInputError when the task has no committed spec", async () => {
    const { computeAndSignVerdict, VerdictInputError } = await import(
      "@/lib/contracts/verdict-service"
    );
    await expect(
      computeAndSignVerdict(baseTask({ acceptance_spec: null, spec_hash: null }), EVIDENCE),
    ).rejects.toThrow(VerdictInputError);
    expect(mockGetOnChainTask).not.toHaveBeenCalled();
  });

  it("throws VerdictInputError when the task has not been delivered yet", async () => {
    mockGetOnChainTask.mockResolvedValue(onChainTask({ state: "Funded", stateRaw: 1 }));

    const { computeAndSignVerdict, VerdictInputError } = await import(
      "@/lib/contracts/verdict-service"
    );
    await expect(computeAndSignVerdict(baseTask(), EVIDENCE)).rejects.toThrow(VerdictInputError);
    expect(mockSignVerdict).not.toHaveBeenCalled();
  });

  it("throws when the stored spec_hash does not match the on-chain specHash", async () => {
    mockGetOnChainTask.mockResolvedValue(onChainTask({ specHash: "0x" + "ff".repeat(32) }));

    const { computeAndSignVerdict } = await import("@/lib/contracts/verdict-service");
    await expect(computeAndSignVerdict(baseTask(), EVIDENCE)).rejects.toThrow(
      /does not match the on-chain specHash/,
    );
    expect(mockSignVerdict).not.toHaveBeenCalled();
  });

  it("throws VerdictInputError when the evidence bundle is malformed", async () => {
    mockGetOnChainTask.mockResolvedValue(onChainTask());

    const { computeAndSignVerdict, VerdictInputError } = await import(
      "@/lib/contracts/verdict-service"
    );
    await expect(computeAndSignVerdict(baseTask(), "{not json")).rejects.toThrow(
      VerdictInputError,
    );
  });

  it("throws VerdictInputError when the evidence bundle does not hash to the on-chain commitment", async () => {
    mockGetOnChainTask.mockResolvedValue(onChainTask({ evidenceHash: "0x" + "aa".repeat(32) }));

    const { computeAndSignVerdict, VerdictInputError } = await import(
      "@/lib/contracts/verdict-service"
    );
    await expect(computeAndSignVerdict(baseTask(), EVIDENCE)).rejects.toThrow(VerdictInputError);
    expect(mockSignVerdict).not.toHaveBeenCalled();
  });

  it("throws when the task is Delivered but has no funded_at recorded", async () => {
    mockGetOnChainTask.mockResolvedValue(onChainTask());

    const { computeAndSignVerdict } = await import("@/lib/contracts/verdict-service");
    await expect(
      computeAndSignVerdict(baseTask({ funded_at: null }), EVIDENCE),
    ).rejects.toThrow(/funded_at/);
  });
});
