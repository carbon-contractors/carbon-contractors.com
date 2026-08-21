import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetTasksForParty = vi.fn();
const mockGetPublicTasks = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getTasksForParty: (...args: unknown[]) => mockGetTasksForParty(...args),
  getPublicTasks: (...args: unknown[]) => mockGetPublicTasks(...args),
}));

const mockVerifyChallengeSignature = vi.fn();
vi.mock("@/lib/auth/wallet-challenge", () => ({
  verifyChallengeSignature: (...args: unknown[]) => mockVerifyChallengeSignature(...args),
}));

const mockGetOnChainTask = vi.fn();
const mockGetEscrowConfig = vi.fn(() => ({ address: "0x1234567890123456789012345678901234567890" }));
vi.mock("@/lib/contracts/escrow", () => ({
  getOnChainTask: (...args: unknown[]) => mockGetOnChainTask(...args),
  getEscrowConfig: () => mockGetEscrowConfig(),
}));

const WORKER_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const AGENT_WALLET = "0x9876543210fedcba9876543210fedcba98765432";

function makeGetRequest(opts: {
  url?: string;
  headers?: Record<string, string>;
}) {
  return new NextRequest(opts.url ?? "http://localhost/api/tasks", {
    method: "GET",
    headers: opts.headers ?? {},
  });
}

describe("GET /api/tasks (CC-093 auth & CC-084 spec)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an unauthenticated request targeting a specific wallet with 401", async () => {
    const { GET } = await import("@/app/api/tasks/route");
    const req = makeGetRequest({ url: `http://localhost/api/tasks?wallet=${WORKER_WALLET}` });
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/Authentication required/i);
    expect(mockGetTasksForParty).not.toHaveBeenCalled();
  });

  it("serves public task feed projection when called unauthenticated without wallet query", async () => {
    mockGetPublicTasks.mockResolvedValue([
      {
        id: "task-pub-1",
        payment_request_id: "pr_pub_1",
        from_agent_wallet: AGENT_WALLET,
        to_human_wallet: WORKER_WALLET,
        amount_usdc: 50,
        deadline_unix: 1787300000,
        status: "active",
        tx_hash: "0xtx1",
        escrow_contract: "0xescrow1",
        created_at: "2026-08-21T00:00:00Z",
      },
    ]);

    const { GET } = await import("@/app/api/tasks/route");
    const req = makeGetRequest({ url: "http://localhost/api/tasks" });
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.authenticated).toBe(false);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].task_description).toBeUndefined();
    expect(data.tasks[0].acceptance_spec).toBeUndefined();
    expect(mockGetPublicTasks).toHaveBeenCalled();
  });

  it("rejects a request with incomplete challenge headers with 401", async () => {
    const { GET } = await import("@/app/api/tasks/route");
    const req = makeGetRequest({
      headers: {
        "x-caller-wallet": WORKER_WALLET,
        // missing signature and nonce
      },
    });
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.ok).toBe(false);
    expect(mockGetTasksForParty).not.toHaveBeenCalled();
  });

  it("rejects a request whose signature fails verification with 401", async () => {
    mockVerifyChallengeSignature.mockRejectedValue(new Error("Signature verification failed"));
    const { GET } = await import("@/app/api/tasks/route");
    const req = makeGetRequest({
      headers: {
        "x-caller-wallet": WORKER_WALLET,
        "x-caller-signature": "0xinvalid",
        "x-caller-nonce": "nonce-123",
      },
    });
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/Signature verification failed/i);
    expect(mockGetTasksForParty).not.toHaveBeenCalled();
  });

  it("returns full task details including description and acceptance spec for authenticated worker", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(WORKER_WALLET);
    mockGetTasksForParty.mockResolvedValue([
      {
        id: "task-1",
        payment_request_id: "pr_1",
        from_agent_wallet: AGENT_WALLET,
        to_human_wallet: WORKER_WALLET,
        task_description: "Inspect solar inverters on roof",
        amount_usdc: 150,
        deadline_unix: 1787400000,
        status: "active",
        tx_hash: "0xtx2",
        escrow_contract: "0xescrow1",
        acceptance_spec: '{"schema_version":1,"criteria":{"min_artefacts":4}}',
        spec_hash: "0x95488785ad9098de2b47cd8e031a10509c63766075e0b2de83f5a1902e8466a4",
        spec_schema_version: 1,
        created_at: "2026-08-21T01:00:00Z",
      },
    ]);
    mockGetOnChainTask.mockResolvedValue({
      state: "Funded",
      amount: BigInt(150000000),
      deadline: BigInt(1787400000),
    });

    const { GET } = await import("@/app/api/tasks/route");
    const req = makeGetRequest({
      headers: {
        "x-caller-wallet": WORKER_WALLET,
        "x-caller-signature": "0xvalidaa",
        "x-caller-nonce": "nonce-456",
      },
    });
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.authenticated).toBe(true);
    expect(data.wallet).toBe(WORKER_WALLET);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].task_description).toBe("Inspect solar inverters on roof");
    expect(data.tasks[0].acceptance_spec).toBe('{"schema_version":1,"criteria":{"min_artefacts":4}}');
    expect(data.tasks[0].spec_hash).toBe(
      "0x95488785ad9098de2b47cd8e031a10509c63766075e0b2de83f5a1902e8466a4",
    );
    expect(data.tasks[0].on_chain.state).toBe("Funded");
    expect(mockGetTasksForParty).toHaveBeenCalledWith(WORKER_WALLET);
  });

  it("returns full task details for authenticated hiring agent", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(AGENT_WALLET);
    mockGetTasksForParty.mockResolvedValue([
      {
        id: "task-1",
        payment_request_id: "pr_1",
        from_agent_wallet: AGENT_WALLET,
        to_human_wallet: WORKER_WALLET,
        task_description: "Inspect solar inverters on roof",
        amount_usdc: 150,
        deadline_unix: 1787400000,
        status: "active",
        tx_hash: "0xtx2",
        escrow_contract: "0xescrow1",
        acceptance_spec: null,
        spec_hash: null,
        spec_schema_version: null,
        created_at: "2026-08-21T01:00:00Z",
      },
    ]);
    mockGetOnChainTask.mockResolvedValue({
      state: "Funded",
      amount: BigInt(150000000),
      deadline: BigInt(1787400000),
    });

    const { GET } = await import("@/app/api/tasks/route");
    const req = makeGetRequest({
      headers: {
        "x-caller-wallet": AGENT_WALLET,
        "x-caller-signature": "0xagent_sig",
        "x-caller-nonce": "nonce-789",
      },
    });
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.authenticated).toBe(true);
    expect(data.wallet).toBe(AGENT_WALLET);
    expect(data.tasks).toHaveLength(1);
    expect(mockGetTasksForParty).toHaveBeenCalledWith(AGENT_WALLET);
  });
});
