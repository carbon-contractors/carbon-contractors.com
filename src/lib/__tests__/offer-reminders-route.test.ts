import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * GET /api/cron/offer-reminders (CC-095).
 *
 * Same posture pins as the retention route: it cannot be made to run by an
 * unauthenticated caller, and it refuses rather than runs when its own secret
 * is missing. `/api/*` bypasses the coming-soon gate, so this endpoint is
 * internet-reachable the moment it deploys, and it reads the channel registry
 * and dispatches notifications.
 *
 * Additionally pins the exactly-once mechanics: the reminder marker is
 * claimed by compare-and-set BEFORE dispatch (overlapping runs race safely),
 * a lost claim skips the offer, and a worker-lookup failure counts as
 * no_worker rather than aborting the run.
 */

const mockGetOffersNeedingReminder = vi.fn();
const mockMarkOfferReminderSent = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getOffersNeedingReminder: (...args: unknown[]) => mockGetOffersNeedingReminder(...args),
  markOfferReminderSent: (...args: unknown[]) => mockMarkOfferReminderSent(...args),
}));

const mockGetHumanByWallet = vi.fn();
vi.mock("@/lib/db/whitepages", () => ({
  getHumanByWallet: (...args: unknown[]) => mockGetHumanByWallet(...args),
}));

const mockNotifyContractor = vi.fn();
vi.mock("@/lib/notifications/dispatch", () => ({
  notifyContractor: (...args: unknown[]) => mockNotifyContractor(...args),
}));

let mockCronSecret: string | undefined;
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ CRON_SECRET: mockCronSecret }),
}));

vi.mock("@/lib/logging", () => ({ log: vi.fn() }));

const SECRET = "s3cr3t-value-of-some-length";

const WORKER = "0xworkerworkerworkerworkerworkerworkerwo";

function makeRequest(authorization?: string): NextRequest {
  return new Request("http://localhost/api/cron/offer-reminders", {
    method: "GET",
    headers: authorization ? { authorization } : {},
  }) as unknown as NextRequest;
}

function offer(overrides: Record<string, unknown> = {}) {
  return {
    payment_request_id: "pr_1",
    to_human_wallet: WORKER,
    amount_usdc: 25,
    offer_expiry_unix: 1_850_000_000,
    ...overrides,
  };
}

describe("GET /api/cron/offer-reminders (CC-095)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCronSecret = SECRET;
    mockGetOffersNeedingReminder.mockResolvedValue([]);
    mockMarkOfferReminderSent.mockResolvedValue(true);
    mockGetHumanByWallet.mockResolvedValue({ id: "worker-uuid", wallet: WORKER });
    mockNotifyContractor.mockResolvedValue({ notified_channels: 1 });
  });

  it("refuses to run at all when CRON_SECRET is unset — fails closed", async () => {
    mockCronSecret = undefined;
    const { GET } = await import("@/app/api/cron/offer-reminders/route");

    const res = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect(mockGetOffersNeedingReminder).not.toHaveBeenCalled();
  });

  it("treats a blank CRON_SECRET as unset, not as a secret empty matches", async () => {
    mockCronSecret = "";
    const { GET } = await import("@/app/api/cron/offer-reminders/route");

    const res = await GET(makeRequest("Bearer "));
    expect(res.status).toBe(503);
    expect(mockGetOffersNeedingReminder).not.toHaveBeenCalled();
  });

  it("401s with no Authorization header", async () => {
    const { GET } = await import("@/app/api/cron/offer-reminders/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockGetOffersNeedingReminder).not.toHaveBeenCalled();
  });

  it("401s a wrong bearer", async () => {
    const { GET } = await import("@/app/api/cron/offer-reminders/route");
    const res = await GET(makeRequest("Bearer not-the-secret"));
    expect(res.status).toBe(401);
    expect(mockGetOffersNeedingReminder).not.toHaveBeenCalled();
  });

  it("claims the marker before dispatching, and sends the offer_expiring event", async () => {
    mockGetOffersNeedingReminder.mockResolvedValue([offer()]);

    const { GET } = await import("@/app/api/cron/offer-reminders/route");
    const res = await GET(makeRequest(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(mockMarkOfferReminderSent).toHaveBeenCalledWith("pr_1");
    // Claim before dispatch — the call order is the guarantee.
    expect(mockMarkOfferReminderSent.mock.invocationCallOrder[0]).toBeLessThan(
      mockNotifyContractor.mock.invocationCallOrder[0],
    );
    expect(mockNotifyContractor).toHaveBeenCalledWith("worker-uuid", {
      type: "offer_expiring",
      payment_request_id: "pr_1",
      amount_usdc: 25,
      offer_expiry_unix: 1_850_000_000,
    });
    const json = await res.json();
    expect(json.dispatched).toBe(1);
  });

  it("skips an offer whose claim lost the race — no duplicate reminder", async () => {
    mockGetOffersNeedingReminder.mockResolvedValue([offer()]);
    mockMarkOfferReminderSent.mockResolvedValue(false);

    const { GET } = await import("@/app/api/cron/offer-reminders/route");
    const res = await GET(makeRequest(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(mockNotifyContractor).not.toHaveBeenCalled();
    const json = await res.json();
    expect(json.skipped_race).toBe(1);
    expect(json.dispatched).toBe(0);
  });

  it("counts an unresolvable worker as no_worker and keeps going", async () => {
    mockGetOffersNeedingReminder.mockResolvedValue([offer(), offer({ payment_request_id: "pr_2" })]);
    mockGetHumanByWallet.mockResolvedValue(null);

    const { GET } = await import("@/app/api/cron/offer-reminders/route");
    const res = await GET(makeRequest(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(mockNotifyContractor).not.toHaveBeenCalled();
    const json = await res.json();
    expect(json.no_worker).toBe(2);
  });

  it("does not let one offer's lookup failure abort the rest", async () => {
    mockGetOffersNeedingReminder.mockResolvedValue([offer(), offer({ payment_request_id: "pr_2" })]);
    mockGetHumanByWallet
      .mockRejectedValueOnce(new Error("supabase down"))
      .mockResolvedValueOnce({ id: "worker-uuid", wallet: WORKER });

    const { GET } = await import("@/app/api/cron/offer-reminders/route");
    const res = await GET(makeRequest(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.no_worker).toBe(1);
    expect(json.dispatched).toBe(1);
  });

  it("503s via safeErrorResponse when the candidate scan itself fails", async () => {
    mockGetOffersNeedingReminder.mockRejectedValue(new Error("supabase down"));

    const { GET } = await import("@/app/api/cron/offer-reminders/route");
    const res = await GET(makeRequest(`Bearer ${SECRET}`));

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(mockNotifyContractor).not.toHaveBeenCalled();
  });
});
