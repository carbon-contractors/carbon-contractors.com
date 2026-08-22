import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Module mocks: the AWOL orchestration against a mocked DB layer ─────────
// The real request_human_work handler is exercised at the bottom of this file,
// so every module it pulls in is mocked here too.

const mockGetChannelsForContractor = vi.fn();
const mockSetAcceptsAutoBookingForContractor = vi.fn();
vi.mock("@/lib/db/notifications", () => ({
  getChannelsForContractor: (...args: unknown[]) =>
    mockGetChannelsForContractor(...args),
  setAcceptsAutoBookingForContractor: (...args: unknown[]) =>
    mockSetAcceptsAutoBookingForContractor(...args),
  registerNotificationChannel: vi.fn(),
}));

const mockGetTasksByWallet = vi.fn();
const mockCountCommittedTasks = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getTasksByWallet: (...args: unknown[]) => mockGetTasksByWallet(...args),
  getTaskByPaymentId: vi.fn(),
  updateTaskStatus: vi.fn(),
  countCommittedTasks: (...args: unknown[]) => mockCountCommittedTasks(...args),
  WORKER_CONCURRENCY_CAP: 3,
}));

const mockNotifyAutoBookingDisabled = vi.fn();
const mockNotifyContractor = vi.fn();
vi.mock("@/lib/notifications/dispatch", () => ({
  notifyAutoBookingDisabled: (...args: unknown[]) =>
    mockNotifyAutoBookingDisabled(...args),
  notifyContractor: (...args: unknown[]) => mockNotifyContractor(...args),
}));

const mockGetHumanByWallet = vi.fn();
vi.mock("@/lib/db/whitepages", () => ({
  getHumanByWallet: (...args: unknown[]) => mockGetHumanByWallet(...args),
  searchByCategory: vi.fn(),
  getAllHumans: vi.fn(),
  getHumanById: vi.fn(),
  getDistinctCategories: vi.fn(),
}));

const mockInitiateX402Payment = vi.fn();
vi.mock("@/lib/payments/x402", () => ({
  initiateX402Payment: (...args: unknown[]) => mockInitiateX402Payment(...args),
}));

const mockLimit = vi.fn();
vi.mock("@/lib/ratelimit", () => ({
  taskCreationRateLimiter: { limit: (...args: unknown[]) => mockLimit(...args) },
}));

vi.mock("@/lib/contracts/escrow", () => ({
  getOnChainTask: vi.fn(),
  getTaskResolvedOutcome: vi.fn(),
  getEscrowConfig: () => ({
    address: "0xEscrow00000000000000000000000000000000",
    chainId: 84532,
    chainName: "Base Sepolia",
  }),
  toTaskId: (paymentRequestId: string) => `0xtaskid-${paymentRequestId}`,
}));

vi.mock("@/lib/contracts/signer", () => ({
  resolveDisputeOnChain: vi.fn(),
}));

import {
  AWOL_LAPSED_OFFER_THRESHOLD,
  AWOL_EXPIRED_TASK_THRESHOLD,
  computeAwolStreaks,
  evaluateAwol,
  taskStatusToAwolOutcome,
  evaluateAwolAtBooking,
} from "@/lib/awol";
import { createMcpServer } from "@/lib/mcp/server";

const WORKER_ID = "11111111-1111-4111-8111-111111111111";
const WORKER_WALLET = "0xWORKERworkerWORKERworkerWORKERworkerWORK";
const AGENT_WALLET = "0xAGENTagentAGENTagentAGENTagentAGENTagent";

const VALID_SPEC = '{"schema_version":1,"criteria":{"min_artefacts":8}}';

const VALID_ARGS = {
  to_human_wallet: WORKER_WALLET,
  task_description: "Photograph the switchboard in Rack Room 2",
  amount_usdc: 25,
  deadline_hours: 24,
  review_window_hours: 48,
  acceptance_spec: VALID_SPEC,
};

function channel(overrides: Record<string, unknown> = {}) {
  return {
    id: "ch-1",
    contractor_id: WORKER_ID,
    type: "email",
    address: "worker@example.com",
    accepts_auto_booking: true,
    created_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * Run the inline booking-time check for a worker whose history is given as
 * task statuses, oldest first. getTasksByWallet returns newest first, so the
 * mock reverses it exactly as production would.
 */
async function decideWithHistory(
  statusesOldestFirst: string[],
  wallet: string = WORKER_WALLET,
) {
  mockGetTasksByWallet.mockResolvedValue(
    [...statusesOldestFirst].reverse().map((status, i) => ({
      id: `task-${i}`,
      status,
    })),
  );
  return evaluateAwolAtBooking({ id: WORKER_ID, wallet });
}

describe("AWOL streak computation (CC-075, ADR-0005 D6 primary / ADR-0001 D1 backstop)", () => {
  it("counts a trailing run of lapsed offers", () => {
    const streaks = computeAwolStreaks([
      "completed",
      "lapsed_offer",
      "lapsed_offer",
      "lapsed_offer",
    ]);
    expect(streaks).toEqual({
      consecutiveLapsedOffers: 3,
      consecutiveExpiredTasks: 0,
    });
  });

  it("counts a trailing run of expired-without-submission tasks", () => {
    const streaks = computeAwolStreaks([
      "lapsed_offer",
      "expired_no_submission",
      "expired_no_submission",
      "expired_no_submission",
    ]);
    expect(streaks).toEqual({
      consecutiveLapsedOffers: 0,
      consecutiveExpiredTasks: 3,
    });
  });

  it("treats a single trailing run as one streak — a different silence starts fresh", () => {
    // The trailing run is expiries; the older lapsed offers are not consecutive
    // with it and must not add to either counter.
    const streaks = computeAwolStreaks([
      "lapsed_offer",
      "lapsed_offer",
      "expired_no_submission",
    ]);
    expect(streaks).toEqual({
      consecutiveLapsedOffers: 0,
      consecutiveExpiredTasks: 1,
    });
  });

  it("skips in-flight items — an auto-booked active task is not evidence of anything", () => {
    const streaks = computeAwolStreaks([
      "lapsed_offer",
      "lapsed_offer",
      "lapsed_offer",
      "other", // pending / active
    ]);
    expect(streaks.consecutiveLapsedOffers).toBe(3);
  });

  it.each(["completed", "delivered", "accepted"] as const)(
    "a successful delivery or accepted offer resets both counters (%s at the tail)",
    (outcome) => {
      const streaks = computeAwolStreaks([
        "lapsed_offer",
        "lapsed_offer",
        "lapsed_offer",
        outcome,
      ]);
      expect(streaks).toEqual({
        consecutiveLapsedOffers: 0,
        consecutiveExpiredTasks: 0,
      });
    },
  );

  it("a success older than the run stops the count where it stood", () => {
    const streaks = computeAwolStreaks([
      "completed",
      "lapsed_offer",
      "lapsed_offer",
    ]);
    expect(streaks.consecutiveLapsedOffers).toBe(2);
  });

  it("declining is participation, never silence — a decline resets both counters (ADR-0005 D6)", () => {
    const streaks = computeAwolStreaks([
      "lapsed_offer",
      "lapsed_offer",
      "declined",
      "lapsed_offer",
    ]);
    expect(streaks).toEqual({
      consecutiveLapsedOffers: 1,
      consecutiveExpiredTasks: 0,
    });
  });

  it("a dispute means work was submitted — participation, resets", () => {
    const streaks = computeAwolStreaks([
      "expired_no_submission",
      "expired_no_submission",
      "disputed",
    ]);
    expect(streaks.consecutiveExpiredTasks).toBe(0);
  });

  it("empty history yields zero streaks", () => {
    expect(computeAwolStreaks([])).toEqual({
      consecutiveLapsedOffers: 0,
      consecutiveExpiredTasks: 0,
    });
  });
});

describe("AWOL thresholds", () => {
  it("triggers on the primary signal at the threshold", () => {
    expect(
      evaluateAwol({ consecutiveLapsedOffers: AWOL_LAPSED_OFFER_THRESHOLD, consecutiveExpiredTasks: 0 }),
    ).toEqual({ triggered: true, signal: "lapsed_offers" });
  });

  it("triggers on the backstop signal at the threshold", () => {
    expect(
      evaluateAwol({ consecutiveLapsedOffers: 0, consecutiveExpiredTasks: AWOL_EXPIRED_TASK_THRESHOLD }),
    ).toEqual({ triggered: true, signal: "expired_tasks" });
  });

  it("prefers the primary signal when both somehow cross", () => {
    expect(
      evaluateAwol({ consecutiveLapsedOffers: 4, consecutiveExpiredTasks: 4 }),
    ).toEqual({ triggered: true, signal: "lapsed_offers" });
  });

  it("does not trigger below either threshold", () => {
    expect(
      evaluateAwol({ consecutiveLapsedOffers: 2, consecutiveExpiredTasks: 2 }),
    ).toEqual({ triggered: false, signal: null });
  });
});

describe("task status → AWOL outcome mapping", () => {
  it("maps the statuses that exist today", () => {
    expect(taskStatusToAwolOutcome("expired")).toBe("expired_no_submission");
    expect(taskStatusToAwolOutcome("completed")).toBe("completed");
    expect(taskStatusToAwolOutcome("disputed")).toBe("disputed");
    expect(taskStatusToAwolOutcome("pending")).toBe("other");
    expect(taskStatusToAwolOutcome("active")).toBe("other");
  });

  it("already maps CC-094's offer statuses so the primary signal lights up when they land", () => {
    expect(taskStatusToAwolOutcome("lapsed")).toBe("lapsed_offer");
    expect(taskStatusToAwolOutcome("declined")).toBe("declined");
    expect(taskStatusToAwolOutcome("accepted")).toBe("accepted");
  });
});

describe("evaluateAwolAtBooking — the inline auto-booking check", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockGetChannelsForContractor.mockResolvedValue([channel()]);
    mockSetAcceptsAutoBookingForContractor.mockResolvedValue(1);
    mockNotifyAutoBookingDisabled.mockResolvedValue([
      { channel_id: "ch-1", type: "email", delivered: false },
    ]);
  });

  it("does not evaluate a worker with no auto-bookable channel", async () => {
    mockGetChannelsForContractor.mockResolvedValue([channel({ accepts_auto_booking: false })]);

    const decision = await decideWithHistory(["lapsed", "lapsed", "lapsed"]);

    expect(decision.evaluated).toBe(false);
    expect(decision.triggered).toBe(false);
    expect(mockGetTasksByWallet).not.toHaveBeenCalled();
    expect(mockSetAcceptsAutoBookingForContractor).not.toHaveBeenCalled();
  });

  it("keeps auto-booking active below the lapsed-offer threshold", async () => {
    const decision = await decideWithHistory(["lapsed", "lapsed"]);

    expect(decision).toMatchObject({
      evaluated: true,
      triggered: false,
      signal: null,
      consecutiveLapsedOffers: 2,
    });
    expect(mockSetAcceptsAutoBookingForContractor).not.toHaveBeenCalled();
    expect(mockNotifyAutoBookingDisabled).not.toHaveBeenCalled();
    const events = logSpy.mock.calls.map((c) => String(c[0]));
    expect(events.some((e) => e.includes("worker_awol_auto_disabled"))).toBe(false);
  });

  it("auto-disables and notifies after 3 consecutive lapsed offers", async () => {
    const decision = await decideWithHistory(["lapsed", "lapsed", "lapsed"]);

    expect(decision).toMatchObject({
      evaluated: true,
      triggered: true,
      signal: "lapsed_offers",
      consecutiveLapsedOffers: 3,
    });
    expect(mockSetAcceptsAutoBookingForContractor).toHaveBeenCalledWith(WORKER_ID, false);
    expect(mockNotifyAutoBookingDisabled).toHaveBeenCalledWith({
      worker: { id: WORKER_ID, wallet: WORKER_WALLET },
      channels: [expect.objectContaining({ id: "ch-1" })],
      signal: "lapsed_offers",
    });

    const event = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((e) => e.includes("worker_awol_auto_disabled"));
    expect(event).toBeDefined();
    expect(event).toContain('"signal":"lapsed_offers"');

    // The wallet is masked in the structured event, never raw. The readable
    // fake wallets used elsewhere here are not hex, so masking needs a
    // realistic one to prove it engaged.
    const HEX_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
    await decideWithHistory(["lapsed", "lapsed", "lapsed"], HEX_WALLET);
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain(HEX_WALLET);
    expect(logged).toContain("0x1234...5678");
  });

  it("auto-disables after 3 consecutive expired tasks with no submission", async () => {
    const decision = await decideWithHistory(["expired", "expired", "expired"]);

    expect(decision).toMatchObject({
      triggered: true,
      signal: "expired_tasks",
      consecutiveExpiredTasks: 3,
    });
    expect(mockSetAcceptsAutoBookingForContractor).toHaveBeenCalledWith(WORKER_ID, false);
    expect(mockNotifyAutoBookingDisabled).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "expired_tasks" }),
    );
  });

  it("flips every channel the worker owns, not just the auto-bookable one", async () => {
    await decideWithHistory(["expired", "expired", "expired"]);

    // The update is by contractor_id with no channel filter — the assertion is
    // on the DB helper's WHERE, exercised in awol-re-enable.test.ts.
    expect(mockSetAcceptsAutoBookingForContractor).toHaveBeenCalledTimes(1);
  });

  it("an accepted offer between lapses keeps the worker below the threshold", async () => {
    const decision = await decideWithHistory(["lapsed", "lapsed", "accepted", "lapsed"]);

    expect(decision.triggered).toBe(false);
    expect(decision.consecutiveLapsedOffers).toBe(1);
    expect(mockSetAcceptsAutoBookingForContractor).not.toHaveBeenCalled();
  });

  it("a notification failure never blocks the disable or the hire", async () => {
    mockNotifyAutoBookingDisabled.mockRejectedValueOnce(
      new Error("dispatch exploded"),
    );

    const decision = await decideWithHistory(["lapsed", "lapsed", "lapsed"]);

    expect(decision.triggered).toBe(true);
    expect(mockSetAcceptsAutoBookingForContractor).toHaveBeenCalled();
    const events = logSpy.mock.calls.map((c) => String(c[0]));
    expect(events.some((e) => e.includes("worker_awol_notification_failed"))).toBe(true);
  });

  it("reads the worker's own task history by wallet", async () => {
    await decideWithHistory(["completed"]);

    expect(mockGetTasksByWallet).toHaveBeenCalledWith(WORKER_WALLET);
  });
});

describe("request_human_work with the AWOL check inline (CC-075)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockLimit.mockResolvedValue({ success: true, reset: 0 });
    mockCountCommittedTasks.mockResolvedValue(0);
    mockGetHumanByWallet.mockResolvedValue({
      id: WORKER_ID,
      wallet: WORKER_WALLET.toLowerCase(),
      categories: ["delivery-errands"],
      rate_usdc: 40,
      availability: "available",
      reputation_score: 80,
    });
    mockGetChannelsForContractor.mockResolvedValue([channel()]);
    mockSetAcceptsAutoBookingForContractor.mockResolvedValue(1);
    mockNotifyAutoBookingDisabled.mockResolvedValue([]);
    mockInitiateX402Payment.mockResolvedValue({
      status: "awaiting_funding",
      payment_request_id: "pr_1",
    });
  });

  async function callRequestHumanWork(
    args: Record<string, unknown> = VALID_ARGS,
    callerWallet: string | null = AGENT_WALLET,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = createMcpServer({ callerWallet }) as any;
    const tool = server._registeredTools["request_human_work"];
    const result = await tool.handler(args);
    return { result, json: JSON.parse(result.content[0].text) };
  }

  it("runs the AWOL check after the worker is resolved, before the task is created", async () => {
    mockGetTasksByWallet.mockResolvedValue([]);

    await callRequestHumanWork();

    expect(mockGetChannelsForContractor).toHaveBeenCalledWith(WORKER_ID);
    // worker.wallet comes from humans, stored lowercase (migration 014).
    expect(mockGetTasksByWallet).toHaveBeenCalledWith(WORKER_WALLET.toLowerCase());
    expect(mockInitiateX402Payment).toHaveBeenCalledTimes(1);
  });

  it("when triggered, the offer proceeds as manual acceptance and says so", async () => {
    mockGetTasksByWallet.mockResolvedValue(
      ["lapsed", "lapsed", "lapsed"].map((status, i) => ({ id: `t${i}`, status })),
    );

    const { result, json } = await callRequestHumanWork();

    expect(result.isError).toBeUndefined();
    expect(mockInitiateX402Payment).toHaveBeenCalledTimes(1); // the hire is not blocked
    expect(mockSetAcceptsAutoBookingForContractor).toHaveBeenCalledWith(WORKER_ID, false);
    expect(mockNotifyAutoBookingDisabled).toHaveBeenCalledTimes(1);
    expect(json.worker_auto_booking_disabled).toBe(true);
    expect(json.awol_signal).toBe("lapsed_offers");
    expect(json.acceptance).toBe("manual");
  });

  it("when not triggered, the response carries no AWOL fields", async () => {
    mockGetTasksByWallet.mockResolvedValue(
      ["lapsed", "lapsed"].map((status, i) => ({ id: `t${i}`, status })),
    );

    const { json } = await callRequestHumanWork();

    expect(json.worker_auto_booking_disabled).toBeUndefined();
    expect(json.acceptance).toBeUndefined();
    expect(mockSetAcceptsAutoBookingForContractor).not.toHaveBeenCalled();
  });

  it("an unreadable AWOL state fails safe to manual acceptance without blocking the hire", async () => {
    mockGetTasksByWallet.mockRejectedValue(new Error("supabase down"));

    const { result, json } = await callRequestHumanWork();

    expect(result.isError).toBeUndefined();
    expect(mockInitiateX402Payment).toHaveBeenCalledTimes(1);
    expect(json.worker_auto_booking_disabled).toBeUndefined();
  });
});
