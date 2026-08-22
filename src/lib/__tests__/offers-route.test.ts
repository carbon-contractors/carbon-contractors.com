import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * CC-094 / ADR-0005 — the worker's offer decision endpoints. Both require the
 * CC-093 wallet challenge-response signature; only the offered worker
 * (to_human_wallet) may answer; the ADR-0005 D5 concurrency cap gates accepts;
 * and an expired offer reads 'lapsed' (inline sweep) and can never be answered.
 */

const mockGetTaskByPaymentId = vi.fn();
const mockUpdateTaskStatus = vi.fn();
const mockCountCommittedTasks = vi.fn();
const mockLapseExpiredOffers = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: (...args: unknown[]) => mockGetTaskByPaymentId(...args),
  updateTaskStatus: (...args: unknown[]) => mockUpdateTaskStatus(...args),
  countCommittedTasks: (...args: unknown[]) => mockCountCommittedTasks(...args),
  lapseExpiredOffers: (...args: unknown[]) => mockLapseExpiredOffers(...args),
  WORKER_CONCURRENCY_CAP: 3,
}));

const mockGetHumanByWallet = vi.fn();
vi.mock("@/lib/db/whitepages", () => ({
  getHumanByWallet: (...args: unknown[]) => mockGetHumanByWallet(...args),
}));

const mockNotifyContractor = vi.fn();
vi.mock("@/lib/notifications/dispatch", () => ({
  notifyContractor: (...args: unknown[]) => mockNotifyContractor(...args),
}));

const mockVerifyChallengeSignature = vi.fn();
vi.mock("@/lib/auth/wallet-challenge", () => ({
  verifyChallengeSignature: (...args: unknown[]) => mockVerifyChallengeSignature(...args),
}));

vi.mock("@/lib/logging", () => ({ log: vi.fn() }));

const WORKER_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const AUTH_HEADERS = {
  "x-caller-wallet": WORKER_WALLET,
  "x-caller-signature": "0xsig",
  "x-caller-nonce": "nonce",
};

function openOffer(overrides: Record<string, unknown> = {}) {
  return {
    payment_request_id: "pr_1",
    from_agent_wallet: "0xagentagentagentagentagentagentagentagen",
    to_human_wallet: WORKER_WALLET,
    amount_usdc: 25,
    status: "pending",
    offer_expiry_unix: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function makeRequest(path: string, opts: { headers?: Record<string, string>; body?: Record<string, unknown> } = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    body: JSON.stringify(opts.body ?? { payment_request_id: "pr_1" }),
  }) as unknown as NextRequest;
}

async function postAccept(opts: Parameters<typeof makeRequest>[1] = {}) {
  const { POST } = await import("@/app/api/offers/accept/route");
  return POST(makeRequest("/api/offers/accept", opts));
}

async function postDecline(opts: Parameters<typeof makeRequest>[1] = {}) {
  const { POST } = await import("@/app/api/offers/decline/route");
  return POST(makeRequest("/api/offers/decline", opts));
}

describe("offer decision endpoints (CC-094)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyChallengeSignature.mockResolvedValue(WORKER_WALLET);
    mockLapseExpiredOffers.mockResolvedValue(0);
    mockGetTaskByPaymentId.mockResolvedValue(openOffer());
    mockUpdateTaskStatus.mockResolvedValue(undefined);
    mockCountCommittedTasks.mockResolvedValue(0);
    mockGetHumanByWallet.mockResolvedValue({ id: "human-uuid", wallet: WORKER_WALLET });
    mockNotifyContractor.mockResolvedValue({ notified_channels: 1 });
  });

  // ─── Authentication (CC-093 pattern) ──────────────────────────────────────

  it("rejects an unsigned accept with 401", async () => {
    const res = await postAccept({});
    expect(res.status).toBe(401);
    expect(mockGetTaskByPaymentId).not.toHaveBeenCalled();
  });

  it("rejects an accept whose signature fails verification with 401", async () => {
    mockVerifyChallengeSignature.mockRejectedValue(new Error("bad signature"));
    const res = await postAccept({ headers: AUTH_HEADERS });
    expect(res.status).toBe(401);
    expect(mockGetTaskByPaymentId).not.toHaveBeenCalled();
  });

  it("rejects an unsigned decline with 401", async () => {
    const res = await postDecline({});
    expect(res.status).toBe(401);
    expect(mockGetTaskByPaymentId).not.toHaveBeenCalled();
  });

  it("rejects a wallet other than the offered worker with 403", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(OTHER_WALLET);
    const res = await postAccept({ headers: AUTH_HEADERS });
    expect(res.status).toBe(403);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("404s an unknown payment_request_id", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(null);
    const res = await postAccept({ headers: AUTH_HEADERS });
    expect(res.status).toBe(404);
  });

  it("rejects a missing payment_request_id with 400", async () => {
    const res = await postAccept({ headers: AUTH_HEADERS, body: {} });
    expect(res.status).toBe(400);
  });

  // ─── Accept ───────────────────────────────────────────────────────────────

  it("accepts an open offer: pending → accepted", async () => {
    const res = await postAccept({ headers: AUTH_HEADERS });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status).toBe("accepted");
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("pr_1", "accepted");
  });

  it("enforces the ADR-0005 D5 concurrency cap on accept", async () => {
    mockCountCommittedTasks.mockResolvedValue(3);

    const res = await postAccept({ headers: AUTH_HEADERS });

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("concurrency cap");
    expect(json.concurrency_cap).toBe(3);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("does not apply the concurrency cap to a decline (D6 — declining is free)", async () => {
    mockCountCommittedTasks.mockResolvedValue(3);

    const res = await postDecline({ headers: AUTH_HEADERS });

    expect(res.status).toBe(200);
    expect(mockCountCommittedTasks).not.toHaveBeenCalled();
  });

  it("refuses to accept a task that is not an open offer", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(openOffer({ status: "active" }));

    const res = await postAccept({ headers: AUTH_HEADERS });

    expect(res.status).toBe(409);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  // ─── Decline ──────────────────────────────────────────────────────────────

  it("declines an open offer: pending → declined, agent free to re-target (D6)", async () => {
    const res = await postDecline({ headers: AUTH_HEADERS });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status).toBe("declined");
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("pr_1", "declined");
  });

  // ─── Lapse ────────────────────────────────────────────────────────────────

  it("returns 410 for a lapsed offer — the inline sweep already ran", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(openOffer({ status: "lapsed", offer_expiry_unix: null }));

    const res = await postAccept({ headers: AUTH_HEADERS });

    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.offer_lapsed).toBe(true);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("lapses an offer whose expiry passed between sweep and read — never accepted out of time", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(
      openOffer({ offer_expiry_unix: Math.floor(Date.now() / 1000) - 10 }),
    );

    const res = await postAccept({ headers: AUTH_HEADERS });

    expect(res.status).toBe(410);
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("pr_1", "lapsed");
    expect(mockUpdateTaskStatus).not.toHaveBeenCalledWith("pr_1", "accepted");
  });

  it("refuses a decline on a lapsed offer too", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(openOffer({ status: "lapsed", offer_expiry_unix: null }));

    const res = await postDecline({ headers: AUTH_HEADERS });

    expect(res.status).toBe(410);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("evaluates the sweep before reading the task (inline lapse on inspection)", async () => {
    await postAccept({ headers: AUTH_HEADERS });

    expect(mockLapseExpiredOffers).toHaveBeenCalled();
  });

  // ─── Notification seam (ADR-0005 D7) ─────────────────────────────────────

  it("records the worker's decision against their channels", async () => {
    await postAccept({ headers: AUTH_HEADERS });
    expect(mockNotifyContractor).toHaveBeenCalledWith(
      "human-uuid",
      expect.objectContaining({ type: "task_accepted", payment_request_id: "pr_1" }),
    );

    await postDecline({ headers: AUTH_HEADERS });
    expect(mockNotifyContractor).toHaveBeenCalledWith(
      "human-uuid",
      expect.objectContaining({ type: "task_declined", payment_request_id: "pr_1" }),
    );
  });
});
