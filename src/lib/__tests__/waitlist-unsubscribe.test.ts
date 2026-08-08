import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { createMockSupabase } from "./helpers/mock-supabase";

const mockRateLimit = vi.fn();
vi.mock("@/lib/ratelimit", () => ({
  apiRateLimiter: { limit: (...args: unknown[]) => mockRateLimit(...args) },
}));

let mockClient: ReturnType<typeof createMockSupabase>["mockClient"];
let mockChainable: ReturnType<typeof createMockSupabase>["chainable"];
vi.mock("@/lib/db/client", () => ({
  getSupabaseAdmin: () => mockClient,
}));

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/waitlist", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("DELETE /api/waitlist (CC-067)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimit.mockResolvedValue({ success: true, remaining: 59, retryAfterS: 0 });
    const mocks = createMockSupabase({ data: null, error: null });
    mockClient = mocks.mockClient;
    mockChainable = mocks.chainable;
  });

  it("removes a matching email from the waitlist", async () => {
    const { DELETE } = await import("@/app/api/waitlist/route");
    const res = await DELETE(makeRequest({ email: "worker@example.com" }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(mockClient.from).toHaveBeenCalledWith("waitlist");
    expect(mockChainable.delete).toHaveBeenCalled();
    expect(mockChainable.eq).toHaveBeenCalledWith("email", "worker@example.com");
  });

  it("returns the same generic success response for an email that was never on the list", async () => {
    // Supabase's delete().eq() returns no error whether or not a row matched —
    // this test documents that the response can't be used as an existence oracle.
    const { DELETE } = await import("@/app/api/waitlist/route");
    const res = await DELETE(makeRequest({ email: "never-signed-up@example.com" }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.message).toContain("If that email was on our list");
  });

  it("lowercases and trims the email before deleting", async () => {
    const { DELETE } = await import("@/app/api/waitlist/route");
    await DELETE(makeRequest({ email: "  Worker@Example.com  " }));

    expect(mockChainable.eq).toHaveBeenCalledWith("email", "worker@example.com");
  });

  it("rejects an invalid email with 400 and does not touch the database", async () => {
    const { DELETE } = await import("@/app/api/waitlist/route");
    const res = await DELETE(makeRequest({ email: "not-an-email" }));

    expect(res.status).toBe(400);
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it("is rate limited", async () => {
    mockRateLimit.mockResolvedValue({ success: false, remaining: 0, retryAfterS: 30 });

    const { DELETE } = await import("@/app/api/waitlist/route");
    const res = await DELETE(makeRequest({ email: "worker@example.com" }));

    expect(res.status).toBe(429);
    expect(mockClient.from).not.toHaveBeenCalled();
  });
});
