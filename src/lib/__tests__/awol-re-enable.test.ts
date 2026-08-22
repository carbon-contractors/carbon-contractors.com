import { describe, it, expect, vi, beforeEach } from "vitest";

// Real db/notifications and notifications/dispatch modules against a mocked
// Supabase client — the CC-075 disable/re-enable round trip at the DB layer.

const mockFrom = vi.fn();
vi.mock("@/lib/db/client", () => ({
  getSupabase: () => ({ from: mockFrom }),
  getSupabaseAdmin: () => ({ from: mockFrom }),
}));

vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_ANON_KEY", "key");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");

import {
  registerNotificationChannel,
  setAcceptsAutoBookingForContractor,
  type NotificationChannel,
} from "@/lib/db/notifications";
import {
  notifyAutoBookingDisabled,
  buildAutoBookingDisabledNotice,
  AUTO_BOOKING_DISABLED_MESSAGE,
} from "@/lib/notifications/dispatch";

const CONTRACTOR_ID = "11111111-1111-4111-8111-111111111111";

function chainable(result: { data: unknown; error: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = () => chain;
  chain.select = vi.fn(self);
  chain.insert = vi.fn(self);
  chain.update = vi.fn(self);
  chain.upsert = vi.fn(self);
  chain.eq = vi.fn(self);
  chain.in = vi.fn(self);
  chain.order = vi.fn(self);
  chain.limit = vi.fn(self);
  chain.single = vi.fn().mockResolvedValue(result);
  chain.then = vi.fn((resolve: (v: unknown) => unknown) => Promise.resolve(resolve(result)));
  return chain;
}

function channel(overrides: Partial<NotificationChannel> = {}): NotificationChannel {
  return {
    id: "ch-1",
    contractor_id: CONTRACTOR_ID,
    type: "email",
    address: "worker@example.com",
    accepts_auto_booking: true,
    created_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("setAcceptsAutoBookingForContractor (CC-075)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flips every channel the contractor owns — no per-channel filter", async () => {
    const chain = chainable({
      data: [{ id: "ch-1" }, { id: "ch-2" }],
      error: null,
    });
    mockFrom.mockReturnValue(chain);

    const count = await setAcceptsAutoBookingForContractor(CONTRACTOR_ID, false);

    expect(count).toBe(2);
    expect(mockFrom).toHaveBeenCalledWith("notification_channels");
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ accepts_auto_booking: false }),
    );
    expect(chain.eq).toHaveBeenCalledWith("contractor_id", CONTRACTOR_ID);
    // The WHERE must not narrow to a single channel — a live channel left
    // behind keeps auto-booking the worker against their own silence.
    expect(chain.eq).toHaveBeenCalledTimes(1);
  });

  it("throws rather than reporting success when the update fails", async () => {
    mockFrom.mockReturnValue(
      chainable({ data: null, error: { message: "connection failed" } }),
    );

    await expect(
      setAcceptsAutoBookingForContractor(CONTRACTOR_ID, false),
    ).rejects.toThrow("setAcceptsAutoBookingForContractor failed");
  });
});

describe("reversibility — a worker re-enabling from the dashboard (CC-075)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-registering a channel with auto-booking on works normally after an auto-disable", async () => {
    // The auto-disable only ever writes accepts_auto_booking=false through the
    // bulk update above; re-enabling is the ordinary CC-073 dashboard upsert.
    // A channel that was flipped false comes straight back as true.
    const reEnabled = channel({ accepts_auto_booking: false });
    const chain = chainable({
      data: { ...reEnabled, accepts_auto_booking: true },
      error: null,
    });
    mockFrom.mockReturnValue(chain);

    const result = await registerNotificationChannel({
      contractor_id: CONTRACTOR_ID,
      type: "email",
      address: "worker@example.com",
      accepts_auto_booking: true,
    });

    expect(chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ accepts_auto_booking: true }),
      { onConflict: "contractor_id,type" },
    );
    expect(result.accepts_auto_booking).toBe(true);
  });
});

describe("notifyAutoBookingDisabled dispatch (CC-075)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("tells the worker auto-booking was disabled for inactivity and how to re-enable it", () => {
    const notice = buildAutoBookingDisabledNotice({
      contractorId: CONTRACTOR_ID,
      signal: "lapsed_offers",
    });

    expect(notice.kind).toBe("auto_booking_disabled");
    expect(notice.signal).toBe("lapsed_offers");
    expect(AUTO_BOOKING_DISABLED_MESSAGE).toMatch(/re-enable/i);
    expect(AUTO_BOOKING_DISABLED_MESSAGE).toMatch(/dashboard/i);
  });

  it("attempts every channel and reports undelivered honestly until CC-095 lands", async () => {
    const attempts = await notifyAutoBookingDisabled({
      worker: { id: CONTRACTOR_ID, wallet: "0xWORKERworkerWORKERworkerWORKERworkerWORK" },
      channels: [
        channel({ id: "ch-1", type: "email" }),
        channel({ id: "ch-2", type: "telegram", address: "12345" }),
      ],
      signal: "expired_tasks",
    });

    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.delivered === false)).toBe(true);
    expect(attempts.map((a) => a.channel_id)).toEqual(["ch-1", "ch-2"]);

    const event = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((e) => e.includes("worker_notice_dispatched"));
    expect(event).toBeDefined();
    expect(event).toContain('"kind":"auto_booking_disabled"');
    // Channel addresses are PII (ADR-0002 D9) — never in the log line.
    expect(event).not.toContain("worker@example.com");
    expect(event).not.toContain("12345");
  });
});
