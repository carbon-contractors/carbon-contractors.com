import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * NOR-322 / ADR-0009 — the authenticated /api/tasks path must accept a session
 * (cookie or bearer) with zero signature round trips, while unsigned callers
 * keep the public projection and wallet-scoped reads without any proof still 401.
 */

const mockSessionWallet = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  sessionWalletFromRequest: (...args: unknown[]) => mockSessionWallet(...args),
}));

const mockGetTasksForParties = vi.fn();
const mockGetPublicTasks = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getTasksForParties: (...args: unknown[]) => mockGetTasksForParties(...args),
  getPublicTasks: (...args: unknown[]) => mockGetPublicTasks(...args),
  lapseExpiredOffers: vi.fn(),
  WORKER_CONCURRENCY_CAP: 3,
}));

vi.mock("@/lib/contracts/escrow", () => ({
  getOnChainTask: vi.fn(),
  getEscrowConfig: vi.fn(() => ({ address: null })),
}));

vi.mock("@/lib/auth/wallet-challenge", () => ({
  verifyChallengeSignature: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({ log: vi.fn() }));

const WALLET = "0x1234567890abcdef1234567890abcdef12345678";

function makeRequest(url: string, headers: Record<string, string> = {}) {
  const req = new Request(`http://localhost${url}`, {
    headers,
  }) as unknown as NextRequest;
  // The route's public/401 branches read req.nextUrl; a plain Request has none.
  (req as unknown as { nextUrl: URL }).nextUrl = new URL(`http://localhost${url}`);
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/api/tasks with a session (NOR-322)", () => {
  it("serves party-scoped tasks on the session alone — no challenge headers", async () => {
    mockSessionWallet.mockResolvedValue(WALLET);
    mockGetTasksForParties.mockResolvedValue([
      { id: "t1", payment_request_id: "pr_1", status: "pending" },
    ]);

    const { GET } = await import("@/app/api/tasks/route");
    const res = await GET(makeRequest("/api/tasks", { cookie: "cc_session=ccs_raw" }));
    const data = await res.json();

    expect(data.authenticated).toBe(true);
    expect(data.tasks).toHaveLength(1);
    expect(mockGetTasksForParties).toHaveBeenCalledWith(WALLET);
    expect(mockGetPublicTasks).not.toHaveBeenCalled();
  });

  it("carries the concurrency cap and committed count (NOR-326)", async () => {
    mockSessionWallet.mockResolvedValue(WALLET);
    mockGetTasksForParties.mockResolvedValue([
      { id: "t1", payment_request_id: "pr_1", to_human_wallet: WALLET, status: "accepted" },
      { id: "t2", payment_request_id: "pr_2", to_human_wallet: WALLET, status: "active" },
      { id: "t3", payment_request_id: "pr_3", to_human_wallet: "0xother", status: "active" },
      { id: "t4", payment_request_id: "pr_4", to_human_wallet: WALLET, status: "completed" },
    ]);

    const { GET } = await import("@/app/api/tasks/route");
    const res = await GET(makeRequest("/api/tasks", { cookie: "cc_session=ccs_raw" }));
    const data = await res.json();

    expect(data.worker_concurrency).toEqual({ committed: 2, cap: 3 });
  });

  it("omits the concurrency block for the public projection", async () => {
    mockSessionWallet.mockResolvedValue(null);
    mockGetPublicTasks.mockResolvedValue([]);

    const { GET } = await import("@/app/api/tasks/route");
    const res = await GET(makeRequest("/api/tasks"));
    const data = await res.json();

    expect(data.worker_concurrency).toBeUndefined();
  });

  it("works identically over the bearer transport", async () => {
    mockSessionWallet.mockResolvedValue(WALLET);
    mockGetTasksForParties.mockResolvedValue([]);

    const { GET } = await import("@/app/api/tasks/route");
    const res = await GET(
      makeRequest("/api/tasks", { authorization: "Bearer ccs_raw" }),
    );

    expect((await res.json()).authenticated).toBe(true);
  });

  it("falls back to the public projection when no session and no headers", async () => {
    mockSessionWallet.mockResolvedValue(null);
    mockGetPublicTasks.mockResolvedValue([{ id: "pub" }]);

    const { GET } = await import("@/app/api/tasks/route");
    const res = await GET(makeRequest("/api/tasks"));
    const data = await res.json();

    expect(data.authenticated).toBe(false);
    expect(mockGetPublicTasks).toHaveBeenCalled();
    expect(mockGetTasksForParties).not.toHaveBeenCalled();
  });
});
