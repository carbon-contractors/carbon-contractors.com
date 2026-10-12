import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// CC-094 / ADR-0005 D4+D5: an auto-booked row is born 'accepted' and counts
// towards the worker's concurrency cap immediately. Until it carried an expiry,
// lapseExpiredOffers skipped it (NULL offer_expiry_unix), so any authenticated
// agent could hold an auto-booking worker at the cap for good with three
// request_human_work calls it never funded.
//
// The chainable mocks elsewhere assert query *shape*; this file needs the
// filters actually applied, so the real createFundingOffer → createTask →
// lapseExpiredOffers → countCommittedTasks path runs against a tiny in-memory
// `tasks` table that implements only the PostgREST calls those functions make.
// The last block drives the real request_human_work handler over the same
// table, because the expiry only frees the worker if the hire path lapses.

type Row = Record<string, unknown>;
const table: Row[] = [];

function query() {
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "insert" | "update" = "select";
  let payload: Row = {};
  let head = false;
  let orderBy: { col: string; ascending: boolean } | null = null;

  function run() {
    if (op === "insert") {
      const row = { id: `row-${table.length + 1}`, created_at: new Date().toISOString(), ...payload };
      table.push(row);
      return { data: [row], error: null };
    }
    const matched = table.filter((r) => filters.every((f) => f(r)));
    if (op === "update") matched.forEach((r) => Object.assign(r, payload));
    if (orderBy) {
      const { col, ascending } = orderBy;
      matched.sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (ascending ? 1 : -1));
    }
    return head
      ? { data: null, count: matched.length, error: null }
      : { data: matched, error: null };
  }

  const q = {
    insert(row: Row) { op = "insert"; payload = row; return q; },
    update(patch: Row) { op = "update"; payload = patch; return q; },
    select(_cols?: string, opts?: { head?: boolean }) { head = opts?.head ?? false; return q; },
    eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return q; },
    in(col: string, vs: unknown[]) { filters.push((r) => vs.includes(r[col])); return q; },
    not(col: string, operator: string, v: unknown) {
      // Only `.not(col, "is", null)` is used on this path; anything else would
      // be silently mis-modelled, so refuse it.
      if (operator !== "is" || v !== null) throw new Error(`fake: unsupported not(${operator})`);
      filters.push((r) => r[col] !== null && r[col] !== undefined);
      return q;
    },
    // SQL: a comparison against NULL is never true.
    lte(col: string, v: number) { filters.push((r) => r[col] != null && (r[col] as number) <= v); return q; },
    order(col: string, opts?: { ascending?: boolean }) {
      orderBy = { col, ascending: opts?.ascending ?? true };
      return q;
    },
    single() {
      const res = run();
      return Promise.resolve({ data: (res.data as Row[] | null)?.[0] ?? null, error: null });
    },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(run()).then(resolve, reject);
    },
  };
  return q;
}

vi.mock("@/lib/db/client", () => ({
  getSupabase: () => ({ from: () => query() }),
  getSupabaseAdmin: () => ({ from: () => query() }),
}));

vi.mock("@/lib/contracts/escrow", () => ({
  toTaskId: vi.fn().mockReturnValue("0x" + "ab".repeat(32)),
  getEscrowConfig: vi.fn().mockReturnValue({
    address: "0x1234567890123456789012345678901234567890",
    chainId: 84532,
    chainName: "Base Sepolia",
    usdcDecimals: 6,
  }),
}));

// For the hire-path block: everything request_human_work reads that is not the
// tasks table. The worker holds an auto-booking channel, so every hire would
// auto-accept; the AWOL check (src/lib/awol.ts) runs for real over the table.
vi.mock("@/lib/db/whitepages", () => ({
  getHumanByWallet: vi.fn().mockResolvedValue({
    id: "human-uuid",
    wallet: "0x" + "b".repeat(40),
    categories: ["delivery-errands"],
    rate_usdc: 40,
    availability: "available",
    reputation_score: 80,
  }),
  searchByCategory: vi.fn(),
  getAllHumans: vi.fn(),
  getHumanById: vi.fn(),
  getDistinctCategories: vi.fn(),
}));

const mockSetAcceptsAutoBooking = vi.fn().mockResolvedValue(1);
vi.mock("@/lib/db/notifications", () => ({
  getChannelsForContractor: vi
    .fn()
    .mockResolvedValue([{ id: "ch1", type: "telegram", address: "redacted", accepts_auto_booking: true }]),
  setAcceptsAutoBookingForContractor: (...args: unknown[]) => mockSetAcceptsAutoBooking(...args),
  registerNotificationChannel: vi.fn(),
}));

vi.mock("@/lib/notifications/dispatch", () => ({
  notifyContractor: vi.fn().mockResolvedValue({ notified_channels: 1 }),
  notifyAutoBookingDisabled: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/ratelimit", () => ({
  taskCreationRateLimiter: { limit: vi.fn().mockResolvedValue({ success: true, retryAfterS: 0 }) },
}));

vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_ANON_KEY", "key");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
vi.stubEnv("NEXT_PUBLIC_BASE_URL", "http://localhost:3000");
vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");

import { createFundingOffer, MIN_OFFER_EXPIRY_SECONDS } from "@/lib/payments/funding";
import {
  countCommittedTasks,
  lapseExpiredOffers,
  markTaskFunded,
  WORKER_CONCURRENCY_CAP,
} from "@/lib/db/tasks";
import { parseAndHashSpec } from "@/lib/spec/hash";
import { createMcpServer } from "@/lib/mcp/server";

const WORKER = "0x" + "b".repeat(40);
const T0_MS = Date.UTC(2026, 9, 12, 0, 0, 0);

const AUTO_BOOKING = {
  from_agent_wallet: "0x" + "a".repeat(40),
  to_human_wallet: WORKER,
  task_description: "Photograph the switchboard in Rack Room 2",
  amount_usdc: 25,
  deadline_unix: Math.floor(T0_MS / 1000) + 7 * 24 * 60 * 60,
  review_window_seconds: 24 * 60 * 60,
  spec: parseAndHashSpec('{"schema_version":1,"criteria":{"min_artefacts":8}}'),
  auto_accept: true,
  offer_expiry_seconds: MIN_OFFER_EXPIRY_SECONDS,
};

describe("auto-booked rows lapse if never funded (CC-094, ADR-0005 D4)", () => {
  beforeEach(() => {
    table.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("frees a worker held at the cap by bookings the agent never funds", async () => {
    for (let i = 0; i < WORKER_CONCURRENCY_CAP; i++) {
      await createFundingOffer(AUTO_BOOKING);
    }
    expect(table.map((r) => r.status)).toEqual(["accepted", "accepted", "accepted"]);
    // The grief: three free calls and the worker cannot be booked or accept.
    expect(await countCommittedTasks(WORKER)).toBe(WORKER_CONCURRENCY_CAP);

    // One second short of the deadline, nothing lapses.
    vi.setSystemTime(T0_MS + (MIN_OFFER_EXPIRY_SECONDS - 1) * 1000);
    expect(await lapseExpiredOffers()).toBe(0);
    expect(await countCommittedTasks(WORKER)).toBe(WORKER_CONCURRENCY_CAP);

    // At the deadline the bookings lapse and the worker is released.
    vi.setSystemTime(T0_MS + MIN_OFFER_EXPIRY_SECONDS * 1000);
    expect(await lapseExpiredOffers()).toBe(WORKER_CONCURRENCY_CAP);
    expect(table.map((r) => r.status)).toEqual(["lapsed", "lapsed", "lapsed"]);
    expect(await countCommittedTasks(WORKER)).toBe(0);
  });

  it("lapses only the unfunded booking — a funded one is past the offer stage", async () => {
    const funded = await createFundingOffer(AUTO_BOOKING);
    await createFundingOffer(AUTO_BOOKING);
    await markTaskFunded(funded.payment_request_id, Math.floor(T0_MS / 1000) + 60);

    vi.setSystemTime(T0_MS + MIN_OFFER_EXPIRY_SECONDS * 1000);
    expect(await lapseExpiredOffers()).toBe(1);

    expect(table.map((r) => r.status)).toEqual(["active", "lapsed"]);
    expect(await countCommittedTasks(WORKER)).toBe(1);
  });
});

describe("request_human_work lapses before it counts (CC-094, ADR-0005 D4+D5)", () => {
  // The expiry only frees the worker if something runs the lapse. The cap
  // check reads 'accepted' rows straight from the table, and nothing else on
  // the hire path lapses — so before request_human_work lapsed inline, the
  // tests above passed while a quiet site kept the worker blocked for good.
  const GRIEFER = "0x" + "a".repeat(40);
  const HONEST = "0x" + "c".repeat(40);

  async function hire(callerWallet: string, extra: Record<string, unknown> = {}) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = createMcpServer({ callerWallet }) as any;
    const result = await server._registeredTools["request_human_work"].handler({
      to_human_wallet: WORKER,
      task_description: AUTO_BOOKING.task_description,
      amount_usdc: 25,
      deadline_hours: 24,
      review_window_hours: 48,
      acceptance_spec: '{"schema_version":1,"criteria":{"min_artefacts":8}}',
      ...extra,
    });
    return JSON.parse(result.content[0].text);
  }

  beforeEach(() => {
    table.length = 0;
    mockSetAcceptsAutoBooking.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("frees the worker for the next agent once unfunded auto-bookings expire", async () => {
    for (let i = 0; i < WORKER_CONCURRENCY_CAP; i++) {
      expect(await hire(GRIEFER, { offer_expiry_minutes: 15 })).toMatchObject({
        ok: true,
        worker_status: "accepted",
      });
    }
    // While the bookings are live the cap holds — that is D5 working.
    expect(await hire(HONEST)).toMatchObject({ ok: false, code: "WORKER_AT_CAPACITY" });

    // Past the deadline, with no other reader in between to lapse anything.
    vi.setSystemTime(T0_MS + 16 * 60 * 1000);
    const json = await hire(HONEST);

    expect(json).toMatchObject({ ok: true, worker_status: "accepted" });
    expect(table.map((r) => r.status)).toEqual(["lapsed", "lapsed", "lapsed", "accepted"]);
    // The AWOL check now sees those rows lapsed, and reads them as the
    // griefer walking away — not as the worker's silence (taskToAwolOutcome).
    expect(json.worker_auto_booking_disabled).toBeUndefined();
    expect(mockSetAcceptsAutoBooking).not.toHaveBeenCalled();
  });
});
