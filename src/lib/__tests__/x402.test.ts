import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db/tasks
vi.mock("@/lib/db/tasks", () => ({
  createTask: vi.fn().mockResolvedValue({ id: "1", payment_request_id: "mock" }),
}));

// Mock contracts/escrow
vi.mock("@/lib/contracts/escrow", () => ({
  toTaskId: vi.fn().mockReturnValue("0x" + "ab".repeat(32)),
  getEscrowConfig: vi.fn().mockReturnValue({
    address: "0x1234567890123456789012345678901234567890",
    chainId: 84532,
    chainName: "Base Sepolia",
    usdcDecimals: 6,
  }),
}));

// Stub config env
vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_ANON_KEY", "key");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
vi.stubEnv("NEXT_PUBLIC_BASE_URL", "http://localhost:3000");
vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");

import { initiateX402Payment } from "@/lib/payments/x402";
import { parseAndHashSpec } from "@/lib/spec/hash";

const VALID_SPEC = '{"schema_version":1,"criteria":{"min_artefacts":8}}';

const BASE_REQUEST = {
  from_agent_wallet: "0x" + "a".repeat(40),
  to_human_wallet: "0x" + "b".repeat(40),
  task_description: "Build a smart contract for NFT minting",
  amount_usdc: 100,
  deadline_unix: Math.floor(Date.now() / 1000) + 3600,
  review_window_seconds: 24 * 60 * 60,
  spec: parseAndHashSpec(VALID_SPEC),
};

describe("x402 payment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates payment request with correct fields", async () => {
    const result = await initiateX402Payment(BASE_REQUEST);

    expect(result.status).toBe("awaiting_funding");
    expect(result.payment_request_id).toBeTruthy();
    expect(result.amount_usdc).toBe(100);
    expect(result.amount_wei).toBe("100000000"); // 100 * 10^6
    expect(result.fund_url).toContain("/api/fund-task");
  });

  it("returns every v2 createTask parameter (CC-081 Defect 1)", async () => {
    const result = await initiateX402Payment(BASE_REQUEST);

    // The six ABI arguments plus the addresses an agent needs to build the call.
    expect(result.task_id_bytes32).toBe("0x" + "ab".repeat(32));
    expect(result.worker).toBe(BASE_REQUEST.to_human_wallet);
    expect(result.amount_wei).toBe("100000000");
    expect(result.deadline_unix).toBe(BASE_REQUEST.deadline_unix);
    expect(result.review_window_seconds).toBe(24 * 60 * 60);
    expect(result.spec_hash).toBe(parseAndHashSpec(VALID_SPEC).hash);
    expect(result.escrow_contract).toBe("0x1234567890123456789012345678901234567890");
    expect(result.chain_id).toBe(84532);
    // Echoed so the agent can verify the hash commitment itself.
    expect(result.acceptance_spec).toBe(VALID_SPEC);
    expect(result.spec_schema_version).toBe(1);
  });

  it("instructs the agent to fund via approve + createTask, not to pay the endpoint", async () => {
    const result = await initiateX402Payment(BASE_REQUEST);

    expect(result.instructions).toContain("createTask");
    expect(result.instructions).toContain("approve");
    // The old instructions sent the agent to an x402 auto-pay flow that stranded USDC.
    expect(result.instructions).not.toMatch(/\bx402\b/i);
    expect(result.instructions).not.toContain("auto-pay");
    // And the confirmation step is described as a read, not a payment.
    expect(result.instructions).toContain("not a payment endpoint");
  });

  it("rejects zero amount", async () => {
    await expect(
      initiateX402Payment({ ...BASE_REQUEST, amount_usdc: 0 })
    ).rejects.toThrow("amount_usdc must be > 0");
  });

  it("rejects invalid wallet address", async () => {
    await expect(
      initiateX402Payment({ ...BASE_REQUEST, from_agent_wallet: "invalid" })
    ).rejects.toThrow("from_agent_wallet must be a valid 0x address");
  });

  it("rejects a review window below the contract's 12h floor", async () => {
    await expect(
      initiateX402Payment({ ...BASE_REQUEST, review_window_seconds: 3600 })
    ).rejects.toThrow("review_window_seconds");
  });

  it("rejects a review window above the contract's 14d ceiling", async () => {
    await expect(
      initiateX402Payment({ ...BASE_REQUEST, review_window_seconds: 15 * 24 * 60 * 60 })
    ).rejects.toThrow("review_window_seconds");
  });

  it("persists the spec commitment so the confirmation endpoint can check it", async () => {
    const { createTask } = await import("@/lib/db/tasks");
    await initiateX402Payment(BASE_REQUEST);

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptance_spec: VALID_SPEC,
        spec_hash: parseAndHashSpec(VALID_SPEC).hash,
        spec_schema_version: 1,
      }),
    );
  });

  // ─── CC-094 / ADR-0005: the offer stage ──────────────────────────────────

  it("creates a pending offer with the default 24h expiry when the worker must decide (D3/D4)", async () => {
    const { createTask } = await import("@/lib/db/tasks");
    const before = Math.floor(Date.now() / 1000);

    const result = await initiateX402Payment({ ...BASE_REQUEST, auto_accept: false });

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending" }),
    );
    const [inserted] = (createTask as ReturnType<typeof vi.fn>).mock.calls[0] as [{ offer_expiry_unix: number }];
    expect(inserted.offer_expiry_unix).toBeGreaterThanOrEqual(before + 24 * 60 * 60);
    expect(inserted.offer_expiry_unix).toBeLessThanOrEqual(before + 24 * 60 * 60 + 2);
    expect(result.worker_status).toBe("pending");
    expect(result.offer_expiry_unix).toBe(inserted.offer_expiry_unix);
  });

  it("honours an agent-set expiry within the 15m–7d bounds (D4)", async () => {
    const { createTask } = await import("@/lib/db/tasks");
    const before = Math.floor(Date.now() / 1000);

    await initiateX402Payment({ ...BASE_REQUEST, offer_expiry_seconds: 15 * 60 });

    const [inserted] = (createTask as ReturnType<typeof vi.fn>).mock.calls[0] as [{ offer_expiry_unix: number }];
    expect(inserted.offer_expiry_unix).toBeGreaterThanOrEqual(before + 15 * 60);
    expect(inserted.offer_expiry_unix).toBeLessThanOrEqual(before + 15 * 60 + 2);
  });

  it("auto-accepts a worker with accepts_auto_booking — born accepted, no expiry (D3)", async () => {
    const { createTask } = await import("@/lib/db/tasks");

    const result = await initiateX402Payment({ ...BASE_REQUEST, auto_accept: true });

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ status: "accepted", offer_expiry_unix: null }),
    );
    expect(result.worker_status).toBe("accepted");
    expect(result.offer_expiry_unix).toBeNull();
  });

  it("rejects an offer expiry below the 15-minute floor (D4)", async () => {
    await expect(
      initiateX402Payment({ ...BASE_REQUEST, offer_expiry_seconds: 14 * 60 }),
    ).rejects.toThrow("offer_expiry_seconds");
  });

  it("rejects an offer expiry above the 7-day ceiling (D4)", async () => {
    await expect(
      initiateX402Payment({ ...BASE_REQUEST, offer_expiry_seconds: 8 * 24 * 60 * 60 }),
    ).rejects.toThrow("offer_expiry_seconds");
  });

  it("tells the agent not to fund until the worker has accepted (CC-094 gate)", async () => {
    const pending = await initiateX402Payment({ ...BASE_REQUEST, auto_accept: false });
    expect(pending.instructions).toContain("Wait for the worker to accept");

    const accepted = await initiateX402Payment({ ...BASE_REQUEST, auto_accept: true });
    expect(accepted.instructions).not.toContain("Wait for the worker to accept");
  });
});

describe("x402 idempotency passthrough and replay (CC-046)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists the idempotency key and review window on the task row", async () => {
    const { createTask } = await import("@/lib/db/tasks");

    await initiateX402Payment({ ...BASE_REQUEST, idempotency_key: "retry-1" });

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotency_key: "retry-1",
        review_window_seconds: 24 * 60 * 60,
      }),
    );
  });

  it("omits the idempotency key entirely when none was supplied", async () => {
    const { createTask } = await import("@/lib/db/tasks");

    await initiateX402Payment(BASE_REQUEST);

    expect(createTask).toHaveBeenCalledWith(
      expect.not.objectContaining({ idempotency_key: expect.anything() }),
    );
  });

  const STORED_ROW = {
    id: "row-uuid",
    payment_request_id: "storedprid",
    from_agent_wallet: BASE_REQUEST.from_agent_wallet,
    to_human_wallet: BASE_REQUEST.to_human_wallet,
    task_description: BASE_REQUEST.task_description,
    amount_usdc: 250,
    deadline_unix: 1850000000,
    status: "pending" as const,
    offer_expiry_unix: 1840000000,
    tx_hash: "",
    escrow_contract: "0x1234567890123456789012345678901234567890",
    acceptance_spec: VALID_SPEC,
    spec_hash: parseAndHashSpec(VALID_SPEC).hash,
    spec_schema_version: 1,
    funded_at: null,
    content_purged_at: null,
    content_purge_rule: null,
    idempotency_key: "retry-1",
    review_window_seconds: 48 * 3600,
    created_at: "2026-08-20T00:00:00.000Z",
  };

  it("reconstructs every createTask parameter from a stored row, without writing", async () => {
    const { createTask } = await import("@/lib/db/tasks");
    const { replayX402Payment } = await import("@/lib/payments/x402");

    const replay = replayX402Payment(STORED_ROW);

    expect(createTask).not.toHaveBeenCalled();
    expect(replay.payment_request_id).toBe("storedprid");
    expect(replay.task_id_bytes32).toBe("0x" + "ab".repeat(32)); // toTaskId(payment_request_id)
    expect(replay.worker).toBe(BASE_REQUEST.to_human_wallet);
    expect(replay.amount_usdc).toBe(250);
    expect(replay.amount_wei).toBe("250000000"); // 250 * 10^6, recomputed
    expect(replay.deadline_unix).toBe(1850000000);
    expect(replay.review_window_seconds).toBe(48 * 3600);
    expect(replay.spec_hash).toBe(parseAndHashSpec(VALID_SPEC).hash);
    expect(replay.acceptance_spec).toBe(VALID_SPEC);
    // Chain parameters re-derived from server config, never from any caller input.
    expect(replay.escrow_contract).toBe("0x1234567890123456789012345678901234567890");
    expect(replay.chain_id).toBe(84532);
    expect(replay.worker_status).toBe("pending");
    expect(replay.status).toBe("awaiting_funding");
    expect(replay.task_status).toBe("pending");
    expect(replay.instructions).toContain("createTask");
  });

  it("reports a replay past the offer stage as already initiated", async () => {
    const { replayX402Payment } = await import("@/lib/payments/x402");

    const replay = replayX402Payment({ ...STORED_ROW, status: "active" });

    expect(replay.status).toBe("already_initiated");
    expect(replay.task_status).toBe("active");
    expect(replay.worker_status).toBe("accepted"); // the offer stage is behind it
  });
});
