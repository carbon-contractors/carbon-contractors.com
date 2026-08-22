import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetTasksForParties = vi.fn();
const mockGetPublicTasks = vi.fn();
const mockLapseExpiredOffers = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getTasksForParties: (...args: unknown[]) => mockGetTasksForParties(...args),
  getPublicTasks: (...args: unknown[]) => mockGetPublicTasks(...args),
  lapseExpiredOffers: (...args: unknown[]) => mockLapseExpiredOffers(...args),
}));

const mockVerifyChallengeSignature = vi.fn();
vi.mock("@/lib/auth/wallet-challenge", () => ({
  verifyChallengeSignature: (...args: unknown[]) =>
    mockVerifyChallengeSignature(...args),
}));

// No escrow address configured in tests, so no on-chain enrichment calls fire.
vi.mock("@/lib/contracts/escrow", () => ({
  getEscrowConfig: () => ({ address: null }),
  getOnChainTask: vi.fn(),
}));

const WORKER_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const AGENT_WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const FULL_TASK = {
  id: "1",
  payment_request_id: "pr_1",
  from_agent_wallet: AGENT_WALLET,
  to_human_wallet: WORKER_WALLET,
  task_description: "secret location: 12 Main St",
  amount_usdc: 10,
  deadline_unix: 0,
  status: "active",
  tx_hash: null,
  escrow_contract: null,
  created_at: "2026-08-01T00:00:00Z",
};

/** tasks_public projection (migration 011) — no task_description. */
const PUBLIC_TASK = {
  id: "1",
  payment_request_id: "pr_1",
  from_agent_wallet: AGENT_WALLET,
  to_human_wallet: WORKER_WALLET,
  amount_usdc: 10,
  deadline_unix: 0,
  status: "active",
  tx_hash: null,
  escrow_contract: null,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};

function makeRequest(opts: { headers?: Record<string, string>; query?: string } = {}) {
  return new NextRequest(`http://localhost/api/tasks${opts.query ?? ""}`, {
    headers: opts.headers ?? {},
  });
}

function authHeaders(wallet: string) {
  return {
    "x-caller-wallet": wallet,
    "x-caller-signature": "0xsig",
    "x-caller-nonce": "nonce",
  };
}

describe("GET /api/tasks (CC-093 auth)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLapseExpiredOffers.mockResolvedValue(0);
  });

  it("serves the public projection (no task_description) to an unsigned caller", async () => {
    mockGetPublicTasks.mockResolvedValue([PUBLIC_TASK]);
    const { GET } = await import("@/app/api/tasks/route");

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.authenticated).toBe(false);
    expect(json.tasks).toHaveLength(1);
    expect(json.tasks[0]).not.toHaveProperty("task_description");
    expect(mockGetTasksForParties).not.toHaveBeenCalled();
    expect(mockGetPublicTasks).toHaveBeenCalledOnce();
  });

  it("returns 401 for a wallet filter without a signature", async () => {
    const { GET } = await import("@/app/api/tasks/route");

    const res = await GET(makeRequest({ query: `?wallet=${WORKER_WALLET}` }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(mockGetTasksForParties).not.toHaveBeenCalled();
    expect(mockGetPublicTasks).not.toHaveBeenCalled();
  });

  it("returns 401 when auth headers are incomplete", async () => {
    const { GET } = await import("@/app/api/tasks/route");

    const res = await GET(
      makeRequest({ headers: { "x-caller-wallet": WORKER_WALLET } }),
    );
    expect(res.status).toBe(401);
    expect(mockVerifyChallengeSignature).not.toHaveBeenCalled();
    expect(mockGetTasksForParties).not.toHaveBeenCalled();
  });

  it("returns 401 when the wallet header is malformed", async () => {
    const { GET } = await import("@/app/api/tasks/route");

    const res = await GET(makeRequest({ headers: authHeaders("not-a-wallet") }));
    expect(res.status).toBe(401);
    expect(mockVerifyChallengeSignature).not.toHaveBeenCalled();
  });

  it("returns 401 when the signature fails verification", async () => {
    mockVerifyChallengeSignature.mockRejectedValue(
      new Error("Signature does not match claimed wallet"),
    );
    const { GET } = await import("@/app/api/tasks/route");

    const res = await GET(makeRequest({ headers: authHeaders(WORKER_WALLET) }));
    expect(res.status).toBe(401);
    expect(mockGetTasksForParties).not.toHaveBeenCalled();
    expect(mockGetPublicTasks).not.toHaveBeenCalled();
  });

  it("serves full task objects (with task_description) to a signed party", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(WORKER_WALLET);
    mockGetTasksForParties.mockResolvedValue([FULL_TASK]);
    const { GET } = await import("@/app/api/tasks/route");

    const res = await GET(makeRequest({ headers: authHeaders(WORKER_WALLET) }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.authenticated).toBe(true);
    expect(json.tasks[0].task_description).toBe(FULL_TASK.task_description);
    expect(mockGetTasksForParties).toHaveBeenCalledWith(WORKER_WALLET);
    expect(mockGetPublicTasks).not.toHaveBeenCalled();
  });

  it("authorises the hiring agent as well as the worker", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(AGENT_WALLET);
    mockGetTasksForParties.mockResolvedValue([FULL_TASK]);
    const { GET } = await import("@/app/api/tasks/route");

    const res = await GET(makeRequest({ headers: authHeaders(AGENT_WALLET) }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tasks[0].task_description).toBeDefined();
    expect(mockGetTasksForParties).toHaveBeenCalledWith(AGENT_WALLET);
  });

  it("ignores ?wallet= on the signed path — the verified wallet is the query", async () => {
    // A caller signed as OTHER_WALLET asking for ?wallet=WORKER_WALLET must
    // not receive the worker's tasks.
    mockVerifyChallengeSignature.mockResolvedValue(OTHER_WALLET);
    mockGetTasksForParties.mockResolvedValue([]);
    const { GET } = await import("@/app/api/tasks/route");

    const res = await GET(
      makeRequest({
        headers: authHeaders(OTHER_WALLET),
        query: `?wallet=${WORKER_WALLET}`,
      }),
    );
    expect(res.status).toBe(200);
    expect(mockGetTasksForParties).toHaveBeenCalledWith(OTHER_WALLET);
    expect(mockGetTasksForParties).not.toHaveBeenCalledWith(WORKER_WALLET);
  });
});
