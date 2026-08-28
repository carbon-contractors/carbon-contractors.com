import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * The test `challenge.test.ts` never had: **issue a challenge, then verify against it.**
 *
 * That file asserts the issued message contains the nonce, and stops there. So nothing
 * noticed that the two halves built the string from two different clocks — the route
 * stamped `Date.now()` (Vercel) and the verifier rebuilt from `created_at` (Postgres).
 * They agree only when both land inside the same whole second, so insert latency plus
 * host skew produced an intermittent "Signature does not match claimed wallet": a server
 * clock fault wearing a wallet fault's error message.
 *
 * These tests pin the property that makes that impossible — the issued message and the
 * verified message are byte-identical **however far apart the two clocks are**.
 */

const WALLET = "0x1234567890abcdef1234567890abcdef12345678";

// Postgres now() at insert. Deliberately far from the app clock stubbed below.
const DB_CREATED_AT = "2026-08-28T04:17:09.482Z";

const mockFrom = vi.fn();
vi.mock("@/lib/db/client", () => ({ getSupabaseAdmin: () => ({ from: mockFrom }) }));

const mockVerifyWalletSignature = vi.fn();
vi.mock("@/lib/wallet/verify", () => ({
  verifyWalletSignature: (...a: unknown[]) => mockVerifyWalletSignature(...a),
}));

/** The route's insert chain: .insert(...).select(...).single() */
function stubIssue() {
  mockFrom.mockReturnValue({
    delete: () => ({ lt: () => Promise.resolve({ error: null }) }),
    insert: () => ({
      select: () => ({
        single: () => Promise.resolve({ data: { created_at: DB_CREATED_AT }, error: null }),
      }),
    }),
  });
}

/** The verifier's read chain: .select(...).eq(...).single(), plus the used_at update. */
function stubVerify(nonce: string) {
  mockFrom.mockReturnValue({
    select: () => ({
      eq: () => ({
        single: () =>
          Promise.resolve({
            data: {
              wallet_address: WALLET.toLowerCase(),
              nonce,
              expires_at: new Date(Date.now() + 60_000).toISOString(),
              used_at: null,
              created_at: DB_CREATED_AT,
            },
            error: null,
          }),
      }),
    }),
    update: () => ({ eq: () => Promise.resolve({ error: null }) }),
  });
}

async function issueMessage(): Promise<{ nonce: string; message: string }> {
  stubIssue();
  const { POST } = await import("@/app/api/basedhuman.mcp/challenge/route");
  const req = new Request("http://localhost/api/basedhuman.mcp/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress: WALLET }),
  });
  const res = await POST(req as unknown as NextRequest);
  expect(res.status).toBe(200);
  // The nonce is generated inside the route, so the caller cannot know it in advance —
  // take it from the response, exactly as a real agent does.
  const json = await res.json();
  return { nonce: json.nonce, message: json.message };
}

describe("challenge issue → verify round trip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyWalletSignature.mockResolvedValue(true);
  });
  afterEach(() => vi.useRealTimers());

  it("issues and verifies the identical message when the app clock is far from the DB clock", async () => {
    // The app is 47 seconds ahead of Postgres. Under the old code the issued message and
    // the rebuilt one differed, and every signature failed.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(DB_CREATED_AT) + 47_000));

    const { nonce, message } = await issueMessage();
    vi.useRealTimers();

    stubVerify(nonce);
    const { verifyChallengeSignature } = await import("@/lib/auth/wallet-challenge");
    await verifyChallengeSignature(WALLET, "0xsig", nonce);

    const verified = mockVerifyWalletSignature.mock.calls[0][0].message;
    expect(verified).toBe(message);
  });

  it("stamps the message from the DB row, not from the process clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(DB_CREATED_AT) + 3_600_000)); // an hour out

    const { message } = await issueMessage();
    vi.useRealTimers();

    const expected = Math.floor(Date.parse(DB_CREATED_AT) / 1000);
    expect(message).toContain(`Timestamp: ${expected}`);
  });

  it("survives an app clock on the far side of a second boundary", async () => {
    // The original bug needed no skew at all — a few hundred milliseconds of insert
    // latency crossing a second boundary was enough, which is why it was intermittent.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(DB_CREATED_AT) + 700));

    const { nonce, message } = await issueMessage();
    vi.useRealTimers();

    stubVerify(nonce);
    const { verifyChallengeSignature } = await import("@/lib/auth/wallet-challenge");
    await verifyChallengeSignature(WALLET, "0xsig", nonce);

    expect(mockVerifyWalletSignature.mock.calls[0][0].message).toBe(message);
  });

  it("fails the insert loudly rather than issuing a message it cannot verify", async () => {
    // No created_at back means no way to build the message the verifier will rebuild.
    // A 500 is correct; inventing a timestamp would recreate the original bug.
    mockFrom.mockReturnValue({
      delete: () => ({ lt: () => Promise.resolve({ error: null }) }),
      insert: () => ({
        select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }),
      }),
    });
    const { POST } = await import("@/app/api/basedhuman.mcp/challenge/route");
    const res = await POST(
      new Request("http://localhost/api/basedhuman.mcp/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: WALLET }),
      }) as unknown as NextRequest,
    );
    expect(res.status).toBe(500);
  });
});
