import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CC-094 → CC-095: notifyContractor is the lifecycle's seam. Born as a
 * logging stub ("until real delivery ships"), it now delegates to the CC-095
 * engine — one engine call per event, payloads translated 1:1, and the two
 * promises the lifecycle depends on kept: never throws, never lets a
 * notification fault fail the request it rides on. The engine's own delivery
 * behaviour (adapters, retries, masking) is pinned in
 * notifications-delivery.test.ts; this file pins the seam contract.
 */

const mockDeliverToContractor = vi.fn();
const mockDispatchToChannels = vi.fn();
vi.mock("@/lib/notifications/delivery", () => ({
  notifyContractor: (...args: unknown[]) => mockDeliverToContractor(...args),
  dispatchToChannels: (...args: unknown[]) => mockDispatchToChannels(...args),
}));

const mockLog = vi.fn();
vi.mock("@/lib/logging", () => ({ log: (...args: unknown[]) => mockLog(...args) }));

import { notifyContractor } from "@/lib/notifications/dispatch";

/** A delivered and a failed outcome — the shapes the engine returns. */
function delivered(n = 1) {
  return Array.from({ length: n }, (_, i) => ({
    channelId: `ch-${i}`,
    channelType: "email",
    outcome: "delivered",
    attempts: 1,
    addressMasked: "sha256:deadbeef",
  }));
}

describe("notifyContractor (CC-094 seam → CC-095 engine)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliverToContractor.mockResolvedValue(delivered(2));
  });

  it("delegates offer_received with the payload translated 1:1", async () => {
    const result = await notifyContractor("human-uuid", {
      type: "offer_received",
      payment_request_id: "pr_1",
      amount_usdc: 25,
      offer_expiry_unix: 9999999999,
    });

    expect(mockDeliverToContractor).toHaveBeenCalledWith(
      "human-uuid",
      "offer_received",
      {
        taskId: "pr_1",
        amountUsdc: 25,
        offerExpiresAt: 9999999999,
      },
    );
    expect(result).toEqual({ notified_channels: 2 });
  });

  it("omits offerExpiresAt entirely on a null expiry — auto-accepted rows", async () => {
    await notifyContractor("human-uuid", {
      type: "offer_received",
      payment_request_id: "pr_1",
      amount_usdc: 25,
      offer_expiry_unix: null,
    });

    const payload = mockDeliverToContractor.mock.calls[0][2];
    expect(payload).not.toHaveProperty("offerExpiresAt");
  });

  it("translates every lifecycle event to the right engine event", async () => {
    await notifyContractor("id", {
      type: "task_funded",
      payment_request_id: "pr_1",
      amount_usdc: 5,
      deadline_unix: 1850000000,
    });
    await notifyContractor("id", {
      type: "verdict_signed",
      payment_request_id: "pr_1",
      passed: true,
    });
    await notifyContractor("id", {
      type: "payment_claimable",
      payment_request_id: "pr_1",
    });
    await notifyContractor("id", { type: "task_accepted", payment_request_id: "pr_1" });
    await notifyContractor("id", { type: "task_declined", payment_request_id: "pr_1" });

    const events = mockDeliverToContractor.mock.calls.map((c) => c[1]);
    expect(events).toEqual([
      "task_funded",
      "verdict_signed",
      "payment_claimable",
      "task_accepted",
      "task_declined",
    ]);
  });

  it("never throws when the engine rejects — the lifecycle event must succeed regardless", async () => {
    // The engine throws only on a malformed payload (a programming error);
    // the seam still must not pass it up to the request path.
    mockDeliverToContractor.mockRejectedValue(
      new Error("notifyContractor: invalid payload: taskId: too_small"),
    );

    await expect(
      notifyContractor("human-uuid", {
        type: "task_declined",
        payment_request_id: "pr_1",
      }),
    ).resolves.toEqual({ notified_channels: 0 });
  });

  it("returns zero channels when the worker has none — empty engine result", async () => {
    mockDeliverToContractor.mockResolvedValue([]);

    const result = await notifyContractor("human-uuid", {
      type: "task_declined",
      payment_request_id: "pr_1",
    });

    expect(result).toEqual({ notified_channels: 0 });
  });

  it("logs the aggregate with the event type only — no payload content (ADR-0002 D4)", async () => {
    await notifyContractor("human-uuid", {
      type: "offer_received",
      payment_request_id: "pr_1",
      amount_usdc: 25,
      offer_expiry_unix: null,
    });

    expect(mockLog).toHaveBeenCalledWith(
      "info",
      "contractor_notification",
      expect.objectContaining({ event_type: "offer_received" }),
    );
    const logged = JSON.stringify(mockLog.mock.calls);
    expect(logged).toContain("offer_received");
    // The payload's task content must not appear in the aggregate line.
    expect(logged).not.toContain("pr_1");
  });
});

describe("notifyAutoBookingDisabled (CC-075 → CC-095 delivery)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers the AWOL notice over every channel and reports outcomes honestly", async () => {
    mockDispatchToChannels.mockResolvedValue([
      {
        channelId: "ch-1",
        channelType: "email",
        outcome: "delivered",
        attempts: 1,
        addressMasked: "sha256:a",
      },
      {
        channelId: "ch-2",
        channelType: "telegram",
        outcome: "failed",
        attempts: 3,
        error: "timeout",
        addressMasked: "sha256:b",
      },
    ]);

    const { notifyAutoBookingDisabled } = await import(
      "@/lib/notifications/dispatch"
    );

    const attempts = await notifyAutoBookingDisabled({
      worker: { id: "human-uuid", wallet: "0xWORKERworkerWORKERworkerWORKERworkerWORK" },
      channels: [
        { id: "ch-1", contractor_id: "human-uuid", type: "email", address: "worker@example.com", accepts_auto_booking: true, created_at: "2026-08-01T00:00:00Z" },
        { id: "ch-2", contractor_id: "human-uuid", type: "telegram", address: "12345", accepts_auto_booking: true, created_at: "2026-08-01T00:00:00Z" },
      ],
      signal: "expired_tasks",
    });

    expect(mockDispatchToChannels).toHaveBeenCalledTimes(1);
    const [, event, payload] = mockDispatchToChannels.mock.calls[0];
    expect(event).toBe("auto_booking_disabled");
    expect(payload.category).toBe("expired_tasks");
    expect(attempts).toEqual([
      { channel_id: "ch-1", channel_type: "email", delivered: true },
      { channel_id: "ch-2", channel_type: "telegram", delivered: false },
    ]);
  });

  it("returns [] for a worker with no channels — nothing to attempt", async () => {
    const { notifyAutoBookingDisabled } = await import(
      "@/lib/notifications/dispatch"
    );

    const attempts = await notifyAutoBookingDisabled({
      worker: { id: "human-uuid", wallet: "0xWORKERworkerWORKERworkerWORKERworkerWORK" },
      channels: [],
      signal: "lapsed_offers",
    });

    expect(attempts).toEqual([]);
    expect(mockDispatchToChannels).not.toHaveBeenCalled();
  });

  it("contains an engine throw — the AWOL decision stands regardless", async () => {
    mockDispatchToChannels.mockRejectedValue(new Error("invalid payload"));

    const { notifyAutoBookingDisabled } = await import(
      "@/lib/notifications/dispatch"
    );

    const attempts = await notifyAutoBookingDisabled({
      worker: { id: "human-uuid", wallet: "0xWORKERworkerWORKERworkerWORKERworkerWORK" },
      channels: [
        { id: "ch-1", contractor_id: "human-uuid", type: "email", address: "worker@example.com", accepts_auto_booking: true, created_at: "2026-08-01T00:00:00Z" },
      ],
      signal: "lapsed_offers",
    });

    expect(attempts).toEqual([
      { channel_id: "ch-1", channel_type: "email", delivered: false },
    ]);
  });
});
