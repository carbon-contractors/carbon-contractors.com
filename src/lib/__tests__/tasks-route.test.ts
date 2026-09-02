import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetTasksForParties = vi.fn();
const mockGetPublicTasks = vi.fn();
const mockLapseExpiredOffers = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  WORKER_CONCURRENCY_CAP: 3,
  getTasksForParties: (...args: unknown[]) => mockGetTasksForParties(...args),
  getPublicTasks: (...args: unknown[]) => mockGetPublicTasks(...args),
  lapseExpiredOffers: (...args: unknown[]) => mockLapseExpiredOffers(...args),
}));

const mockVerifyChallengeSignature = vi.fn();
vi.mock("@/lib/auth/wallet-challenge", () => ({
  verifyChallengeSignature: (...args: unknown[]) =>
    mockVerifyChallengeSignature(...args),
}));

// The escrow address is null by default, so no on-chain enrichment fires; the
// enrichment tests flip it and stub getOnChainTask with a full v2 task.
const mockGetOnChainTask = vi.fn();
let mockEscrowAddress: string | null = null;
vi.mock("@/lib/contracts/escrow", () => ({
  getEscrowConfig: () => ({ address: mockEscrowAddress }),
  getOnChainTask: (...args: unknown[]) => mockGetOnChainTask(...args),
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
    mockEscrowAddress = null;
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

describe("GET /api/tasks on-chain enrichment (CC-092 v2 fields)", () => {
  const ESCROW = "0xescrowescrowescrowescrowescrowescrowescrow";

  /** A full OnChainTask as escrow.ts returns one — Delivered, mid review window. */
  const ON_CHAIN_TASK = {
    agent: AGENT_WALLET,
    worker: WORKER_WALLET,
    amount: BigInt(10_000_000),
    deadline: BigInt(1_800_000_000),
    state: "Delivered",
    stateRaw: 2,
    reviewWindow: 86_400,
    submittedAt: BigInt(1_799_000_000),
    reviewDeadline: BigInt(1_799_000_000 + 86_400),
    specHash: "0x" + "aa".repeat(32),
    evidenceHash: "0x" + "bb".repeat(32),
    verdictHash: "0x" + "00".repeat(32),
    verdictPassed: false,
    // ADR-0006 D3. Delivered, never disputed, so the stamp is 0 and the deadline
    // lands in 1970 — the state check is what keeps that from meaning "claimable".
    disputedAt: BigInt(0),
    arbitrationDeadline: BigInt(7 * 24 * 60 * 60),
    arbitrationClock: true,
    attestationUid: "0x" + "00".repeat(32),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLapseExpiredOffers.mockResolvedValue(0);
    mockEscrowAddress = ESCROW;
    mockVerifyChallengeSignature.mockResolvedValue(WORKER_WALLET);
    mockGetTasksForParties.mockResolvedValue([FULL_TASK]);
    mockGetOnChainTask.mockResolvedValue(ON_CHAIN_TASK);
  });

  it("returns every v2 field the dashboard write paths need", async () => {
    const { GET } = await import("@/app/api/tasks/route");

    const res = await GET(makeRequest({ headers: authHeaders(WORKER_WALLET) }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(mockGetOnChainTask).toHaveBeenCalledWith("pr_1");
    expect(json.tasks[0].on_chain).toEqual({
      state: "Delivered",
      amount_wei: "10000000",
      deadline: 1_800_000_000,
      reviewWindow: 86_400,
      submittedAt: 1_799_000_000,
      reviewDeadline: 1_799_086_400,
      specHash: "0x" + "aa".repeat(32),
      evidenceHash: "0x" + "bb".repeat(32),
      verdictHash: "0x" + "00".repeat(32),
      verdictPassed: false,
      disputedAt: 0,
      arbitrationDeadline: 7 * 24 * 60 * 60,
      arbitrationClock: true,
      worker: WORKER_WALLET,
      agent: AGENT_WALLET,
    });
  });

  it("enriches the public projection too — the v2 fields carry no task content", async () => {
    mockEscrowAddress = null;
    mockGetPublicTasks.mockResolvedValue([PUBLIC_TASK]);
    mockEscrowAddress = ESCROW;
    const { GET } = await import("@/app/api/tasks/route");

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tasks[0].on_chain.state).toBe("Delivered");
    expect(json.tasks[0].on_chain.specHash).toBe("0x" + "aa".repeat(32));
    expect(json.tasks[0]).not.toHaveProperty("task_description");
  });

  it("nulls on_chain for a task the chain read fails on, without failing the list", async () => {
    mockGetOnChainTask.mockRejectedValue(new Error("RPC down"));
    const { GET } = await import("@/app/api/tasks/route");

    const res = await GET(makeRequest({ headers: authHeaders(WORKER_WALLET) }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tasks[0].on_chain).toBeNull();
  });

  it("survives a live offer whose payment_request_id the view withholds (migration 021)", async () => {
    // tasks_public NULLs the id while a task is `pending`/`accepted`, because taskId is
    // keccak256 of it and `createTask` is permissionless first-come-first-served — an
    // unauthenticated observer could otherwise burn the id for 1 unit of USDC before the
    // agent funds. The list must still render; on_chain is simply not derivable.
    mockEscrowAddress = "0xescrow";
    mockGetPublicTasks.mockResolvedValue([
      { ...PUBLIC_TASK, status: "pending", payment_request_id: null },
    ]);
    const { GET } = await import("@/app/api/tasks/route");

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tasks).toHaveLength(1);
    expect(json.tasks[0].payment_request_id).toBeNull();
    expect(json.tasks[0].on_chain).toBeNull();
    // No id means no derivable taskId, so the chain must not be consulted at all.
    expect(mockGetOnChainTask).not.toHaveBeenCalled();
  });
});
