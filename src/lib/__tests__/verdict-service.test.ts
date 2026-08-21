import { describe, it, expect, vi, beforeEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";

const TEST_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const TEST_ACCOUNT = privateKeyToAccount(TEST_KEY);

const mockGetTaskByPaymentId = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: (...args: unknown[]) => mockGetTaskByPaymentId(...args),
}));

const mockGetOnChainTask = vi.fn();
vi.mock("@/lib/contracts/escrow", () => ({
  getOnChainTask: (...args: unknown[]) => mockGetOnChainTask(...args),
  getEscrowConfig: () => ({
    address: "0x1234567890123456789012345678901234567890",
    chainId: 84532,
    chainName: "Base Sepolia",
  }),
  toTaskId: (id: string) => keccak256(toHex(id)),
}));

const mockGetPlatformAccount = vi.fn();
vi.mock("@/lib/contracts/signer", () => ({
  getPlatformAccount: (...args: unknown[]) => mockGetPlatformAccount(...args),
}));

import {
  issueSignedVerdictForTask,
  VerdictServiceError,
  VERDICT_SERVICE_ERRORS,
} from "@/lib/contracts/verdict-service";
import { recoverVerdictSigner } from "@/lib/contracts/verdict-signer";

const PR_ID = "pr_verdict_1";
const SPEC_HASH = keccak256(toHex("spec"));
const EVIDENCE_HASH = keccak256(toHex("evidence"));

function deliveredTask(overrides: Record<string, unknown> = {}) {
  return {
    agent: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    worker: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    amount: BigInt(10_000_000),
    deadline: BigInt(9_999_999_999),
    state: "Delivered",
    stateRaw: 2,
    reviewWindow: 43200,
    submittedAt: BigInt(1_800_000_000),
    reviewDeadline: BigInt(1_800_043_200),
    specHash: SPEC_HASH,
    evidenceHash: EVIDENCE_HASH,
    verdictHash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    verdictPassed: false,
    attestationUid:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPlatformAccount.mockResolvedValue(TEST_ACCOUNT);
  mockGetTaskByPaymentId.mockResolvedValue({
    payment_request_id: PR_ID,
    to_human_wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    from_agent_wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    status: "active",
    spec_hash: SPEC_HASH,
  });
});

describe("issueSignedVerdictForTask (CC-092)", () => {
  it("binds specHash and evidenceHash from the chain, not the caller or the DB", async () => {
    mockGetOnChainTask.mockResolvedValue(deliveredTask());

    const signed = await issueSignedVerdictForTask({
      paymentRequestId: PR_ID,
      passed: true,
    });

    expect(signed.verdict.taskId).toBe(keccak256(toHex(PR_ID)));
    expect(signed.verdict.specHash).toBe(SPEC_HASH);
    // The binding must be the chain's evidence commitment — a zero here was the
    // defect this service exists to prevent (VerdictCommitmentMismatch on-chain).
    expect(signed.verdict.evidenceHash).toBe(EVIDENCE_HASH);
    expect(signed.verdict.passed).toBe(true);
  });

  it("produces a signature that recovers to the platform signer", async () => {
    mockGetOnChainTask.mockResolvedValue(deliveredTask());
    const signed = await issueSignedVerdictForTask({
      paymentRequestId: PR_ID,
      passed: false,
      failureReason: "evidence EXIF missing",
    });
    expect(await recoverVerdictSigner(signed.verdict, signed.signature)).toBe(
      TEST_ACCOUNT.address,
    );
    expect(signed.verdict.passed).toBe(false);
    // The failure reason is committed, not just logged.
    expect(signed.verdict.breakdownHash).toBe(keccak256(toHex("evidence EXIF missing")));
  });

  it("refuses a failing verdict with no stated reason", async () => {
    await expect(
      issueSignedVerdictForTask({ paymentRequestId: PR_ID, passed: false }),
    ).rejects.toMatchObject({ code: VERDICT_SERVICE_ERRORS.MISSING_FAILURE_REASON });
  });

  it("refuses a task that does not exist", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(null);
    await expect(
      issueSignedVerdictForTask({ paymentRequestId: "pr_ghost", passed: true }),
    ).rejects.toMatchObject({ code: VERDICT_SERVICE_ERRORS.TASK_NOT_FOUND });
  });

  it("refuses anything not delivered on-chain — claim and dispute both require Delivered", async () => {
    mockGetOnChainTask.mockResolvedValue(deliveredTask({ state: "Funded", stateRaw: 1 }));
    await expect(
      issueSignedVerdictForTask({ paymentRequestId: PR_ID, passed: true }),
    ).rejects.toMatchObject({ code: VERDICT_SERVICE_ERRORS.NOT_DELIVERED });

    mockGetOnChainTask.mockResolvedValue(deliveredTask({ state: "Completed", stateRaw: 3 }));
    await expect(
      issueSignedVerdictForTask({ paymentRequestId: PR_ID, passed: false, failureReason: "x".repeat(10) }),
    ).rejects.toBeInstanceOf(VerdictServiceError);
  });

  it("surfaces a chain read failure as CHAIN_UNAVAILABLE rather than a raw error", async () => {
    mockGetOnChainTask.mockRejectedValue(new Error("no contract at address"));
    await expect(
      issueSignedVerdictForTask({ paymentRequestId: PR_ID, passed: true }),
    ).rejects.toMatchObject({ code: VERDICT_SERVICE_ERRORS.CHAIN_UNAVAILABLE });
  });
});
