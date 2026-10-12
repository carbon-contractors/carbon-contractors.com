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

import { createFundingOffer } from "@/lib/payments/funding";
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

describe("funding offer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates payment request with correct fields", async () => {
    const result = await createFundingOffer(BASE_REQUEST);

    expect(result.status).toBe("awaiting_funding");
    expect(result.payment_request_id).toBeTruthy();
    expect(result.amount_usdc).toBe(100);
    expect(result.amount_wei).toBe("100000000"); // 100 * 10^6
    expect(result.fund_url).toContain("/api/fund-task");
  });

  it("returns every v2 createTask parameter (CC-081 Defect 1)", async () => {
    const result = await createFundingOffer(BASE_REQUEST);

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
    const result = await createFundingOffer(BASE_REQUEST);

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
      createFundingOffer({ ...BASE_REQUEST, amount_usdc: 0 })
    ).rejects.toThrow("amount_usdc must be > 0");
  });

  it("rejects invalid wallet address", async () => {
    await expect(
      createFundingOffer({ ...BASE_REQUEST, from_agent_wallet: "invalid" })
    ).rejects.toThrow("from_agent_wallet must be a valid 0x address");
  });

  it("rejects a review window below the contract's 12h floor", async () => {
    await expect(
      createFundingOffer({ ...BASE_REQUEST, review_window_seconds: 3600 })
    ).rejects.toThrow("review_window_seconds");
  });

  it("rejects a review window above the contract's 14d ceiling", async () => {
    await expect(
      createFundingOffer({ ...BASE_REQUEST, review_window_seconds: 15 * 24 * 60 * 60 })
    ).rejects.toThrow("review_window_seconds");
  });

  it("persists the spec commitment so the confirmation endpoint can check it", async () => {
    const { createTask } = await import("@/lib/db/tasks");
    await createFundingOffer(BASE_REQUEST);

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

    const result = await createFundingOffer({ ...BASE_REQUEST, auto_accept: false });

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

    await createFundingOffer({ ...BASE_REQUEST, offer_expiry_seconds: 15 * 60 });

    const [inserted] = (createTask as ReturnType<typeof vi.fn>).mock.calls[0] as [{ offer_expiry_unix: number }];
    expect(inserted.offer_expiry_unix).toBeGreaterThanOrEqual(before + 15 * 60);
    expect(inserted.offer_expiry_unix).toBeLessThanOrEqual(before + 15 * 60 + 2);
  });

  it("auto-accepts a worker with accepts_auto_booking — born accepted, with a funding deadline (D3/D4)", async () => {
    const { createTask } = await import("@/lib/db/tasks");
    const before = Math.floor(Date.now() / 1000);

    const result = await createFundingOffer({ ...BASE_REQUEST, auto_accept: true });

    // An 'accepted' row counts towards the D5 cap. With a NULL expiry
    // lapseExpiredOffers never touched it, so three bookings an agent never
    // funded blocked the worker for good — the row must carry the default
    // expiry, which is now the agent's deadline to fund.
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ status: "accepted" }),
    );
    const [inserted] = (createTask as ReturnType<typeof vi.fn>).mock.calls[0] as [{ offer_expiry_unix: number | null }];
    expect(inserted.offer_expiry_unix).not.toBeNull();
    expect(inserted.offer_expiry_unix).toBeGreaterThanOrEqual(before + 24 * 60 * 60);
    expect(inserted.offer_expiry_unix).toBeLessThanOrEqual(before + 24 * 60 * 60 + 2);
    expect(result.worker_status).toBe("accepted");
    expect(result.offer_expiry_unix).toBe(inserted.offer_expiry_unix);
  });

  it("honours an agent-set expiry on an auto-accepted offer too (D4)", async () => {
    const { createTask } = await import("@/lib/db/tasks");
    const before = Math.floor(Date.now() / 1000);

    await createFundingOffer({ ...BASE_REQUEST, auto_accept: true, offer_expiry_seconds: 2 * 60 * 60 });

    const [inserted] = (createTask as ReturnType<typeof vi.fn>).mock.calls[0] as [{ offer_expiry_unix: number }];
    expect(inserted.offer_expiry_unix).toBeGreaterThanOrEqual(before + 2 * 60 * 60);
    expect(inserted.offer_expiry_unix).toBeLessThanOrEqual(before + 2 * 60 * 60 + 2);
  });

  it("bounds an auto-accepted offer's expiry exactly as a manual one's — no 7-day-plus parking (D4)", async () => {
    const { createTask } = await import("@/lib/db/tasks");

    await expect(
      createFundingOffer({ ...BASE_REQUEST, auto_accept: true, offer_expiry_seconds: 8 * 24 * 60 * 60 }),
    ).rejects.toThrow("offer_expiry_seconds");
    await expect(
      createFundingOffer({ ...BASE_REQUEST, auto_accept: true, offer_expiry_seconds: 14 * 60 }),
    ).rejects.toThrow("offer_expiry_seconds");
    // Rejected before any row is written.
    expect(createTask).not.toHaveBeenCalled();
  });

  it("rejects an offer expiry below the 15-minute floor (D4)", async () => {
    await expect(
      createFundingOffer({ ...BASE_REQUEST, offer_expiry_seconds: 14 * 60 }),
    ).rejects.toThrow("offer_expiry_seconds");
  });

  it("rejects an offer expiry above the 7-day ceiling (D4)", async () => {
    await expect(
      createFundingOffer({ ...BASE_REQUEST, offer_expiry_seconds: 8 * 24 * 60 * 60 }),
    ).rejects.toThrow("offer_expiry_seconds");
  });

  it("tells the agent not to fund until the worker has accepted (CC-094 gate)", async () => {
    const pending = await createFundingOffer({ ...BASE_REQUEST, auto_accept: false });
    expect(pending.instructions).toContain("Wait for the worker to accept");

    const accepted = await createFundingOffer({ ...BASE_REQUEST, auto_accept: true });
    expect(accepted.instructions).not.toContain("Wait for the worker to accept");
  });

  it("tells an auto-booked agent to fund before the expiry or the booking lapses (D4)", async () => {
    const accepted = await createFundingOffer({ ...BASE_REQUEST, auto_accept: true });

    expect(accepted.instructions).toContain(`Deadline: unix ${accepted.offer_expiry_unix}`);
    expect(accepted.instructions).toContain("or the booking lapses");
  });

  it("tells the agent how to recover USDC funded into a task that lapsed anyway", async () => {
    const accepted = await createFundingOffer({ ...BASE_REQUEST, auto_accept: true });

    // expireTask is agent-only and refunds directly once the deadline passes.
    expect(accepted.instructions).toContain(
      `escrow.expireTask("${accepted.task_id_bytes32}") from this wallet refunds it`,
    );
  });

  it("tells a manual-offer agent the same expiry also bounds funding after acceptance (D4)", async () => {
    const pending = await createFundingOffer({ ...BASE_REQUEST, auto_accept: false });

    expect(pending.instructions).toContain(`Deadline: unix ${pending.offer_expiry_unix}`);
    expect(pending.instructions).toContain("The worker must accept AND you must fund and confirm");
    expect(pending.instructions).toContain("or the offer lapses");
  });
});

describe("funding-offer idempotency passthrough and replay (CC-046)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists the idempotency key and review window on the task row", async () => {
    const { createTask } = await import("@/lib/db/tasks");

    await createFundingOffer({ ...BASE_REQUEST, idempotency_key: "retry-1" });

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotency_key: "retry-1",
        review_window_seconds: 24 * 60 * 60,
      }),
    );
  });

  it("omits the idempotency key entirely when none was supplied", async () => {
    const { createTask } = await import("@/lib/db/tasks");

    await createFundingOffer(BASE_REQUEST);

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
    offer_reminder_sent: null,
    tx_hash: "",
    escrow_contract: "0x1234567890123456789012345678901234567890",
    acceptance_spec: VALID_SPEC,
    accepted_description_hash: null,
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
    const { replayFundingOffer } = await import("@/lib/payments/funding");

    const replay = replayFundingOffer(STORED_ROW);

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

  it("replays an auto-booked row with its funding deadline (CC-094)", async () => {
    const { replayFundingOffer } = await import("@/lib/payments/funding");

    const replay = replayFundingOffer({
      ...STORED_ROW,
      status: "accepted",
      accepted_description_hash: "0x" + "cd".repeat(32),
    });

    expect(replay.status).toBe("awaiting_funding");
    expect(replay.worker_status).toBe("accepted");
    expect(replay.offer_expiry_unix).toBe(1840000000);
    expect(replay.instructions).toContain("Deadline: unix 1840000000");
    expect(replay.instructions).toContain("or the booking lapses");
  });

  it("replays a legacy auto-booked row with no expiry without inventing a deadline", async () => {
    const { replayFundingOffer } = await import("@/lib/payments/funding");

    const replay = replayFundingOffer({
      ...STORED_ROW,
      status: "accepted",
      offer_expiry_unix: null,
    });

    expect(replay.offer_expiry_unix).toBeNull();
    expect(replay.instructions).not.toContain("Deadline:");
    expect(replay.instructions).toContain("createTask");
  });

  it("reports a replay past the offer stage as already initiated", async () => {
    const { replayFundingOffer } = await import("@/lib/payments/funding");

    const replay = replayFundingOffer({ ...STORED_ROW, status: "active" });

    expect(replay.status).toBe("already_initiated");
    expect(replay.task_status).toBe("active");
    expect(replay.worker_status).toBe("accepted"); // the offer stage is behind it
  });

  it.each(["declined", "lapsed", "active", "completed"] as const)(
    "does not tell a replay of a %s row that the worker is booked and to fund it",
    async (status) => {
      const { replayFundingOffer } = await import("@/lib/payments/funding");

      // The expiry is still in the future, which is what made the line appear:
      // a declined offer replayed within 24h would be told to fund a task that
      // /api/fund-task then refuses, locking the USDC until deadline_unix.
      const replay = replayFundingOffer({ ...STORED_ROW, status, offer_expiry_unix: 1840000000 });

      expect(replay.status).toBe("already_initiated");
      expect(replay.instructions).not.toContain("Deadline:");
      expect(replay.instructions).not.toContain("The worker is booked");
    },
  );
});
