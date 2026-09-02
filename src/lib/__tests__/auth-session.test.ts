import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "./helpers/mock-supabase";

/**
 * NOR-322 / ADR-0009 — the session library. What matters here: only the token
 * hash is stored, verification refuses revoked and expired sessions, the
 * sliding window is throttled, revocation is wallet-scoped, and the token can
 * arrive by bearer header or cookie.
 */

const { mockClient, chainable } = createMockSupabase({ data: null, error: null });

vi.mock("@/lib/db/client", () => ({
  getSupabaseAdmin: () => mockClient,
}));

import {
  SESSION_COOKIE,
  SCOPE_FULL,
  hashToken,
  listSessions,
  mintSession,
  revokeAllSessions,
  revokeSession,
  tokenFromRequest,
  verifySessionToken,
} from "@/lib/auth/session";

const WALLET = "0xabcabcabcabcabcabcabcabcabcabcabcabcabc";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://cc.test/api/probe", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Tests that stub select's resolution would otherwise break the chain for
  // later tests — put it back to returning the chainable.
  chainable.select.mockReturnValue(chainable);
});

describe("token hashing (ADR-0009: only the hash is stored)", () => {
  it("is deterministic and does not contain the token", () => {
    const h = hashToken("ccs_secret");
    expect(h).toBe(hashToken("ccs_secret"));
    expect(h).not.toContain("secret");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("mintSession", () => {
  it("stores a 256-bit token hash, the full scope and a lowercase wallet", async () => {
    await mintSession(WALLET.toUpperCase(), "Dashboard");

    expect(mockClient.from).toHaveBeenCalledWith("sessions");
    const payload = chainable.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.wallet).toBe(WALLET);
    expect(payload.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.scopes).toEqual([SCOPE_FULL]);
    expect(payload.name).toBe("Dashboard");
    expect(typeof payload.expires_at).toBe("string");
  });
});

describe("verifySessionToken", () => {
  it("returns null for an unknown token", async () => {
    (chainable.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: null,
    });
    await expect(verifySessionToken("ccs_nope")).resolves.toBeNull();
  });

  it("returns null for a revoked session", async () => {
    (chainable.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "s1", wallet: WALLET, scopes: [SCOPE_FULL], revoked_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), last_used_at: new Date().toISOString() },
      error: null,
    });
    await expect(verifySessionToken("ccs_revoked")).resolves.toBeNull();
  });

  it("returns null for an expired session", async () => {
    (chainable.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "s1", wallet: WALLET, scopes: [SCOPE_FULL], revoked_at: null, expires_at: new Date(Date.now() - 60_000).toISOString(), last_used_at: new Date().toISOString() },
      error: null,
    });
    await expect(verifySessionToken("ccs_old")).resolves.toBeNull();
  });

  it("verifies a live session without writing when inside the slide throttle", async () => {
    (chainable.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "s1", wallet: WALLET, scopes: [SCOPE_FULL], revoked_at: null, expires_at: new Date(Date.now() + 60_000).toISOString(), last_used_at: new Date().toISOString() },
      error: null,
    });
    const verified = await verifySessionToken("ccs_live");
    expect(verified?.wallet).toBe(WALLET);
    expect(chainable.update).not.toHaveBeenCalled();
  });
});

describe("revocation", () => {
  it("scopes a single revoke to the caller's own wallet", async () => {
    (chainable.select as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ id: "s1" }],
      error: null,
    });
    await revokeSession(WALLET, "s1");
    const eqCalls = chainable.eq.mock.calls.map((c: unknown[]) => c[0]);
    expect(eqCalls).toContain("wallet");
    expect(chainable.update).toHaveBeenCalled();
  });

  it("counts revoked rows for revoke-all", async () => {
    (chainable.select as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ id: "a" }, { id: "b" }],
      error: null,
    });
    await expect(revokeAllSessions(WALLET)).resolves.toBe(2);
    const isCalls = chainable.is.mock.calls.map((c: unknown[]) => c.slice(0, 2));
    expect(isCalls).toContainEqual(["revoked_at", null]);
  });
});

describe("listSessions", () => {
  it("only lists live sessions for the wallet", async () => {
    (chainable.order as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ id: "s1", name: "Dashboard", scopes: [SCOPE_FULL], created_at: "t", last_used_at: "t", expires_at: "t" }],
      error: null,
    });
    const rows = await listSessions(WALLET);
    expect(rows).toHaveLength(1);
    const eqCalls = chainable.eq.mock.calls.map((c: unknown[]) => c[0]);
    expect(eqCalls).toContain("wallet");
    expect(chainable.is).toHaveBeenCalledWith("revoked_at", null);
    expect(chainable.gt).toHaveBeenCalledWith("expires_at", expect.any(String));
  });
});

describe("tokenFromRequest", () => {
  it("prefers the bearer header", () => {
    const r = req({ authorization: "Bearer ccs_byheader", cookie: `${SESSION_COOKIE}=ccs_bycookie` });
    expect(tokenFromRequest(r)).toBe("ccs_byheader");
  });

  it("reads the session cookie", () => {
    const r = req({ cookie: `other=1; ${SESSION_COOKIE}=ccs_bycookie` });
    expect(tokenFromRequest(r)).toBe("ccs_bycookie");
  });

  it("returns null with neither", () => {
    expect(tokenFromRequest(req())).toBeNull();
  });
});
