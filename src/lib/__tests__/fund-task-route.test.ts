import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * CC-081 Defects 1 and 3 — /api/fund-task is no longer an x402 payment recipient.
 * It is a confirmation endpoint: the DB row only moves to `active` once the chain
 * says the task is Funded and matches the row. These tests pin that gate.
 *
 * CC-094 / ADR-0005 D2 additionally requires the worker's consent first: the row
 * must be 'accepted' before anything can activate. A 'pending' row is still an
 * open offer; 'lapsed' and 'declined' are dead.
 */

const mockGetTaskByPaymentId = vi.fn();
const mockMarkTaskFunded = vi.fn();
const mockUpdateTaskStatus = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: (...args: unknown[]) => mockGetTaskByPaymentId(...args),
  markTaskFunded: (...args: unknown[]) => mockMarkTaskFunded(...args),
  updateTaskStatus: (...args: unknown[]) => mockUpdateTaskStatus(...args),
}));

const mockGetOnChainTask = vi.fn();
const mockGetCurrentBlockTimestamp = vi.fn();
vi.mock("@/lib/contracts/escrow", () => ({
  getOnChainTask: (...args: unknown[]) => mockGetOnChainTask(...args),
  getCurrentBlockTimestamp: () => mockGetCurrentBlockTimestamp(),
  getEscrowConfig: () => ({
    address: "0x1234567890123456789012345678901234567890",
    chainId: 84532,
    chainName: "Base Sepolia",
    usdcDecimals: 6,
  }),
}));

vi.mock("@/lib/logging", () => ({ log: vi.fn() }));

const WORKER = "0xworkerworkerworkerworkerworkerworkerwo";
const AGENT = "0xagentagentagentagentagentagentagentagen";

function makeRequest(body?: Record<string, unknown>) {
  return new Request("http://localhost/api/fund-task", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? { payment_request_id: "pr_1" }),
  }) as unknown as NextRequest;
}

function fundedOnChainTask(overrides: Record<string, unknown> = {}) {
  return {
    agent: AGENT,
    worker: WORKER,
    amount: BigInt(25_000_000), // 25 USDC, 6 decimals
    deadline: BigInt(9999999999),
    state: "Funded",
    stateRaw: 1,
    reviewWindow: 172800,
    submittedAt: BigInt(0),
    reviewDeadline: BigInt(172800),
    specHash: "0x" + "ab".repeat(32),
    evidenceHash: "0x" + "00".repeat(32),
    verdictHash: "0x" + "00".repeat(32),
    verdictPassed: false,
    attestationUid: "0x" + "00".repeat(32),
    ...overrides,
  };
}

describe("POST /api/fund-task (CC-081 Defects 1+3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTaskByPaymentId.mockResolvedValue({
      payment_request_id: "pr_1",
      from_agent_wallet: AGENT,
      to_human_wallet: WORKER,
      amount_usdc: 25,
      status: "accepted",
    });
    mockMarkTaskFunded.mockResolvedValue(undefined);
    mockGetCurrentBlockTimestamp.mockResolvedValue(1_700_000_000);
  });

  it("activates a task only after reading Funded from the chain", async () => {
    mockGetOnChainTask.mockResolvedValue(fundedOnChainTask());

    const { POST } = await import("@/app/api/fund-task/route");
    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status).toBe("active");
    expect(json.on_chain_state).toBe("Funded");
    expect(mockGetOnChainTask).toHaveBeenCalledWith("pr_1");
    expect(mockMarkTaskFunded).toHaveBeenCalledWith("pr_1", 1_700_000_000);
  });

  it("refuses to activate when the on-chain task does not exist yet", async () => {
    mockGetOnChainTask.mockResolvedValue(fundedOnChainTask({ state: "None", stateRaw: 0 }));

    const { POST } = await import("@/app/api/fund-task/route");
    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toContain("No on-chain task");
    expect(mockMarkTaskFunded).not.toHaveBeenCalled();
  });

  it("refuses to activate when the chain read fails — never guesses", async () => {
    mockGetOnChainTask.mockRejectedValue(new Error("HTTP 429"));

    const { POST } = await import("@/app/api/fund-task/route");
    const res = await POST(makeRequest());

    expect(res.status).toBe(502);
    expect(mockMarkTaskFunded).not.toHaveBeenCalled();
  });

  it("refuses to activate when the on-chain worker does not match the row", async () => {
    mockGetOnChainTask.mockResolvedValue(
      fundedOnChainTask({ worker: "0xsomeoneelsesomeoneelsesomeoneelsesome1" }),
    );

    const { POST } = await import("@/app/api/fund-task/route");
    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("does not match");
    expect(mockMarkTaskFunded).not.toHaveBeenCalled();
  });

  it("refuses to activate when the on-chain amount does not match the row", async () => {
    mockGetOnChainTask.mockResolvedValue(fundedOnChainTask({ amount: BigInt(1) }));

    const { POST } = await import("@/app/api/fund-task/route");
    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    expect(mockMarkTaskFunded).not.toHaveBeenCalled();
  });

  it("activates a task that has moved past Funded on-chain — the money is proven", async () => {
    mockGetOnChainTask.mockResolvedValue(
      fundedOnChainTask({ state: "Delivered", stateRaw: 2, submittedAt: BigInt(12345) }),
    );

    const { POST } = await import("@/app/api/fund-task/route");
    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(mockMarkTaskFunded).toHaveBeenCalledWith("pr_1", 1_700_000_000);
  });

  it("records the current block timestamp as funded_at, not a client-supplied value", async () => {
    mockGetOnChainTask.mockResolvedValue(fundedOnChainTask());
    mockGetCurrentBlockTimestamp.mockResolvedValue(1_800_000_000);

    const { POST } = await import("@/app/api/fund-task/route");
    await POST(makeRequest());

    expect(mockGetCurrentBlockTimestamp).toHaveBeenCalledTimes(1);
    expect(mockMarkTaskFunded).toHaveBeenCalledWith("pr_1", 1_800_000_000);
  });

  it("rejects a task that is not accepted", async () => {
    mockGetTaskByPaymentId.mockResolvedValue({
      payment_request_id: "pr_1",
      status: "active",
      to_human_wallet: WORKER,
      amount_usdc: 25,
    });

    const { POST } = await import("@/app/api/fund-task/route");
    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    expect(mockGetOnChainTask).not.toHaveBeenCalled();
    expect(mockMarkTaskFunded).not.toHaveBeenCalled();
  });

  it("refuses a still-pending offer — money must not lock before consent (CC-094 / ADR-0005 D2)", async () => {
    mockGetTaskByPaymentId.mockResolvedValue({
      payment_request_id: "pr_1",
      status: "pending",
      to_human_wallet: WORKER,
      amount_usdc: 25,
    });

    const { POST } = await import("@/app/api/fund-task/route");
    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("has not accepted");
    expect(mockGetOnChainTask).not.toHaveBeenCalled();
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("refuses a lapsed offer the same way — the agent must re-target (CC-094)", async () => {
    mockGetTaskByPaymentId.mockResolvedValue({
      payment_request_id: "pr_1",
      status: "lapsed",
      to_human_wallet: WORKER,
      amount_usdc: 25,
    });

    const { POST } = await import("@/app/api/fund-task/route");
    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    expect(mockGetOnChainTask).not.toHaveBeenCalled();
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("rejects a missing payment_request_id", async () => {
    const { POST } = await import("@/app/api/fund-task/route");
    const res = await POST(makeRequest({}));

    expect(res.status).toBe(400);
  });

  it("404s an unknown payment_request_id", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(null);

    const { POST } = await import("@/app/api/fund-task/route");
    const res = await POST(makeRequest());

    expect(res.status).toBe(404);
  });
});
