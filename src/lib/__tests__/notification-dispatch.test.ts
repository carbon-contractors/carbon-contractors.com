import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CC-094 — the notifyContractor seam (ADR-0005 D7). Real delivery is CC-095;
 * until then the seam records one structured event per registered channel and
 * must never throw and never log a channel address (workers' contact details,
 * ADR-0002 D9).
 */

const mockGetChannelsForContractor = vi.fn();
vi.mock("@/lib/db/notifications", () => ({
  getChannelsForContractor: (...args: unknown[]) => mockGetChannelsForContractor(...args),
}));

const mockLog = vi.fn();
vi.mock("@/lib/logging", () => ({ log: (...args: unknown[]) => mockLog(...args) }));

import { notifyContractor } from "@/lib/notifications/dispatch";

describe("notifyContractor (CC-094 / ADR-0005 D7 seam)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records one event per registered channel", async () => {
    mockGetChannelsForContractor.mockResolvedValue([
      { id: "ch1", type: "email", address: "worker@example.com", accepts_auto_booking: false },
      { id: "ch2", type: "telegram", address: "12345", accepts_auto_booking: true },
    ]);

    const result = await notifyContractor("human-uuid", {
      type: "offer_received",
      payment_request_id: "pr_1",
      amount_usdc: 25,
      offer_expiry_unix: 9999999999,
    });

    expect(result).toEqual({ notified_channels: 2 });
    expect(mockLog).toHaveBeenCalledTimes(2);
  });

  it("never logs the channel address — only id and type (ADR-0002 D9)", async () => {
    mockGetChannelsForContractor.mockResolvedValue([
      { id: "ch1", type: "email", address: "worker@example.com", accepts_auto_booking: false },
    ]);

    await notifyContractor("human-uuid", {
      type: "task_accepted",
      payment_request_id: "pr_1",
    });

    const logged = JSON.stringify(mockLog.mock.calls);
    expect(logged).toContain("ch1");
    expect(logged).toContain("email");
    expect(logged).not.toContain("worker@example.com");
  });

  it("resolves with zero channels when the registry read fails — never throws", async () => {
    mockGetChannelsForContractor.mockRejectedValue(new Error("supabase down"));

    await expect(
      notifyContractor("human-uuid", {
        type: "offer_received",
        payment_request_id: "pr_1",
        amount_usdc: 25,
        offer_expiry_unix: null,
      }),
    ).resolves.toEqual({ notified_channels: 0 });
  });

  it("records nothing when the worker has no channels", async () => {
    mockGetChannelsForContractor.mockResolvedValue([]);

    const result = await notifyContractor("human-uuid", {
      type: "task_declined",
      payment_request_id: "pr_1",
    });

    expect(result).toEqual({ notified_channels: 0 });
    expect(mockLog).not.toHaveBeenCalled();
  });
});
