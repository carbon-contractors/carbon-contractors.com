import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * NOR-322 / ADR-0009 — /api/auth/session. Mint sets an httpOnly SameSite=Strict
 * cookie and shows the raw token once; the probe 401s without a session; revoke
 * all clears the cookie.
 */

const mockVerifyChallenge = vi.fn();
vi.mock("@/lib/auth/wallet-challenge", () => ({
  verifyChallengeSignature: (...args: unknown[]) => mockVerifyChallenge(...args),
}));

const mockMint = vi.fn();
const mockVerify = vi.fn();
const mockRevokeAll = vi.fn();
const mockList = vi.fn();
vi.mock("@/lib/auth/session", async (importOriginal) => {
  // Keep the real token parsing and cookie constants; stub only what touches
  // the database.
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...actual,
    mintSession: (...args: unknown[]) => mockMint(...args),
    verifySessionToken: (...args: unknown[]) => mockVerify(...args),
    revokeAllSessions: (...args: unknown[]) => mockRevokeAll(...args),
    listSessions: (...args: unknown[]) => mockList(...args),
  };
});

vi.mock("@/lib/logging", () => ({ log: vi.fn() }));

const WALLET = "0x1234567890abcdef1234567890abcdef12345678";

function makeRequest(
  method: string,
  opts: { headers?: Record<string, string>; body?: Record<string, unknown> } = {},
) {
  return new Request(`http://localhost/api/auth/session`, {
    method,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/auth/session (mint)", () => {
  it("sets an httpOnly SameSite=Strict cookie and shows the token once", async () => {
    mockVerifyChallenge.mockResolvedValue(WALLET);
    mockMint.mockResolvedValue({
      token: "ccs_raw",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    mockList.mockResolvedValue([]);

    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(
      makeRequest("POST", {
        body: { walletAddress: WALLET, signature: "0xsig", nonce: "n1", name: "Dashboard" },
      }),
    );
    const data = await res.json();

    expect(data.ok).toBe(true);
    expect(data.wallet).toBe(WALLET);
    expect(data.token).toBe("ccs_raw");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("cc_session=");
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=strict");
  });

  it("401s without a verifiable signature", async () => {
    mockVerifyChallenge.mockRejectedValue(new Error("bad"));
    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(
      makeRequest("POST", { body: { walletAddress: WALLET, signature: "0xsig", nonce: "n1" } }),
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/auth/session (probe)", () => {
  it("401s with no token", async () => {
    const { GET } = await import("@/app/api/auth/session/route");
    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(401);
  });

  it("returns the wallet and live sessions for a valid token", async () => {
    mockVerify.mockResolvedValue({
      wallet: WALLET,
      sessionId: "s1",
      scopes: ["session:full"],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    mockList.mockResolvedValue([{ id: "s1", name: "Dashboard" }]);

    const { GET } = await import("@/app/api/auth/session/route");
    const res = await GET(makeRequest("GET", { headers: { cookie: "cc_session=ccs_raw" } }));
    const data = await res.json();

    expect(data.ok).toBe(true);
    expect(data.wallet).toBe(WALLET);
    expect(data.sessions).toHaveLength(1);
  });
});

describe("DELETE /api/auth/session (revoke)", () => {
  it("revokes everything and clears the cookie on all: true", async () => {
    mockVerify.mockResolvedValue({
      wallet: WALLET,
      sessionId: "s1",
      scopes: ["session:full"],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    mockRevokeAll.mockResolvedValue(3);

    const { DELETE } = await import("@/app/api/auth/session/route");
    const res = await DELETE(
      makeRequest("DELETE", {
        headers: { cookie: "cc_session=ccs_raw" },
        body: { all: true },
      }),
    );
    const data = await res.json();

    expect(data).toEqual({ ok: true, revoked: 3 });
    expect(mockRevokeAll).toHaveBeenCalledWith(WALLET);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("cc_session=");
    expect(setCookie.toLowerCase()).toContain("max-age=0");
  });
});
