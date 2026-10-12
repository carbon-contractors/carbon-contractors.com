import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * ADR-0010 D2 — POST /api/evidence/upload-url grants one short-lived PUT, only
 * to the assigned worker, only while the task is active in the DB and Funded
 * on-chain, only when the agent supplied a credential, and never logs the grant.
 */

const mockSessionWallet = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  sessionWalletFromRequest: (...a: unknown[]) => mockSessionWallet(...a),
}));
vi.mock("@/lib/auth/wallet-challenge", () => ({
  verifyChallengeSignature: vi.fn().mockRejectedValue(new Error("no")),
}));

const mockGetTask = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: (...a: unknown[]) => mockGetTask(...a),
}));

const mockGetCredential = vi.fn();
vi.mock("@/lib/db/upload-credentials", () => ({
  getUploadCredential: (...a: unknown[]) => mockGetCredential(...a),
}));

const mockOnChain = vi.fn();
vi.mock("@/lib/contracts/escrow", () => ({
  getOnChainTask: (...a: unknown[]) => mockOnChain(...a),
}));

const mockConfigured = vi.fn();
vi.mock("@/lib/evidence/credential-crypto", () => ({
  isEvidenceEncryptionConfigured: () => mockConfigured(),
  decryptCredential: vi.fn().mockResolvedValue({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    region: "ap-southeast-2",
  }),
}));

const mockLog = vi.fn();
vi.mock("@/lib/logging", () => ({ log: (...a: unknown[]) => mockLog(...a) }));

const WORKER = "0x1234567890abcdef1234567890abcdef12345678";
const SPEC = JSON.stringify({
  schema_version: 1,
  criteria: { min_artefacts: 2 },
  evidence_bucket: { provider: "s3", target: "s3://agent-evidence" },
});

function task(overrides: Record<string, unknown> = {}) {
  return {
    payment_request_id: "pr_1",
    to_human_wallet: WORKER,
    status: "active",
    acceptance_spec: SPEC,
    ...overrides,
  };
}

function req(body: unknown): NextRequest {
  return new Request("http://localhost/api/evidence/upload-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const BODY = { payment_request_id: "pr_1", filename: "bay 1.jpg", content_type: "image/jpeg", size_bytes: 2_000_000 };

async function call(body: unknown = BODY) {
  const { POST } = await import("@/app/api/evidence/upload-url/route");
  const res = await POST(req(body));
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigured.mockReturnValue(true);
  mockSessionWallet.mockResolvedValue(WORKER);
  mockGetTask.mockResolvedValue(task());
  mockGetCredential.mockResolvedValue({
    payment_request_id: "pr_1",
    provider: "s3",
    credential_envelope: "{}",
    max_upload_bytes: 10 * 1024 * 1024,
  });
  mockOnChain.mockResolvedValue({ state: "Funded" });
});

describe("POST /api/evidence/upload-url", () => {
  it("grants a signed PUT under the task prefix, fitted to the declared file", async () => {
    const { status, json } = await call();
    expect(status).toBe(200);
    const url = new URL(json.upload_url);
    expect(url.host).toBe("agent-evidence.s3.ap-southeast-2.amazonaws.com");
    expect(url.pathname).toMatch(/^\/tasks\/pr_1\/[0-9a-f]{16}-bay-1\.jpg$/);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(json.method).toBe("PUT");
    expect(json.headers).toEqual({ "Content-Type": "image/jpeg" });
    expect(json.uri).toBe(`https://${url.host}${url.pathname}`);
  });

  it("never logs the grant URL or the credential", async () => {
    await call();
    const logged = JSON.stringify(mockLog.mock.calls);
    expect(logged).not.toContain("X-Amz-Signature");
    expect(logged).not.toContain("AKIAEXAMPLE");
    expect(logged).not.toContain("secret");
  });

  it("503s when encryption is not configured on the deployment", async () => {
    mockConfigured.mockReturnValue(false);
    expect((await call()).status).toBe(503);
  });

  it("401s without a session or a valid challenge", async () => {
    mockSessionWallet.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });

  it("403s for anyone but the task's worker", async () => {
    mockSessionWallet.mockResolvedValue("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect((await call()).status).toBe(403);
  });

  it("409s when the task is not active, not Funded, or has no credential", async () => {
    mockGetTask.mockResolvedValue(task({ status: "accepted" }));
    expect((await call()).status).toBe(409);

    mockGetTask.mockResolvedValue(task());
    mockOnChain.mockResolvedValue({ state: "Delivered" });
    const delivered = await call();
    expect(delivered.status).toBe(409);
    expect(delivered.json.error).toContain("already been submitted");

    mockOnChain.mockResolvedValue({ state: "Funded" });
    mockGetCredential.mockResolvedValue(null);
    const none = await call();
    expect(none.status).toBe(409);
    expect(none.json.error).toContain("paste a link");
  });

  it("400s on a disallowed type or a file over the agent's cap", async () => {
    expect((await call({ ...BODY, content_type: "text/html" })).status).toBe(400);
    expect((await call({ ...BODY, size_bytes: 11 * 1024 * 1024 })).status).toBe(400);
    expect((await call({ payment_request_id: "pr_1" })).status).toBe(400);
  });

  it("404s for an unknown task", async () => {
    mockGetTask.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
});
