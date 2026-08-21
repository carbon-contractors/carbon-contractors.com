import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Tests for /api/channels (CC-073) — notification channel CRUD for the
 * dashboard, guarded by the CC-004 challenge-response wallet signature.
 */

const mockGetChannelsForContractor = vi.fn();
const mockGetChannelById = vi.fn();
const mockRegisterNotificationChannel = vi.fn();
const mockRemoveNotificationChannel = vi.fn();
vi.mock("@/lib/db/notifications", () => ({
  getChannelsForContractor: (...args: unknown[]) =>
    mockGetChannelsForContractor(...args),
  getChannelById: (...args: unknown[]) => mockGetChannelById(...args),
  registerNotificationChannel: (...args: unknown[]) =>
    mockRegisterNotificationChannel(...args),
  removeNotificationChannel: (...args: unknown[]) =>
    mockRemoveNotificationChannel(...args),
}));

const mockGetHumanByWallet = vi.fn();
vi.mock("@/lib/db/whitepages", () => ({
  getHumanByWallet: (...args: unknown[]) => mockGetHumanByWallet(...args),
}));

const mockVerifyChallengeSignature = vi.fn();
vi.mock("@/lib/auth/wallet-challenge", () => ({
  verifyChallengeSignature: (...args: unknown[]) =>
    mockVerifyChallengeSignature(...args),
}));

const WORKER_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTRACTOR_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_CONTRACTOR_ID = "22222222-2222-2222-2222-222222222222";
const CHANNEL_ID = "33333333-3333-3333-3333-333333333333";

const AUTH_HEADERS = {
  "x-caller-wallet": WORKER_WALLET,
  "x-caller-signature": "0xsig",
  "x-caller-nonce": "nonce",
};

function makeRequest(
  method: "GET" | "POST" | "DELETE",
  opts: { headers?: Record<string, string>; body?: Record<string, unknown> },
) {
  return new Request("http://localhost/api/channels", {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }) as unknown as NextRequest;
}

function mockRegisteredHuman(wallet = WORKER_WALLET, id = CONTRACTOR_ID) {
  mockGetHumanByWallet.mockImplementation(async (w: string) =>
    w.toLowerCase() === wallet.toLowerCase()
      ? {
          id,
          wallet: wallet.toLowerCase(),
          categories: [],
          rate_usdc: 50,
          availability: "available",
          reputation_score: 50,
        }
      : null,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyChallengeSignature.mockResolvedValue(WORKER_WALLET);
});

// ── GET ────────────────────────────────────────────────────────────────────

describe("GET /api/channels", () => {
  it("rejects an unsigned request with 401", async () => {
    const { GET } = await import("@/app/api/channels/route");
    const res = await GET(makeRequest("GET", {}));
    expect(res.status).toBe(401);
    expect(mockGetChannelsForContractor).not.toHaveBeenCalled();
  });

  it("rejects a request with an invalid wallet header with 401", async () => {
    const { GET } = await import("@/app/api/channels/route");
    const res = await GET(
      makeRequest("GET", {
        headers: {
          "x-caller-wallet": "not-a-wallet",
          "x-caller-signature": "0xsig",
          "x-caller-nonce": "nonce",
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a request whose signature fails verification with 401", async () => {
    mockVerifyChallengeSignature.mockRejectedValue(
      new Error("Signature does not match claimed wallet"),
    );
    const { GET } = await import("@/app/api/channels/route");
    const res = await GET(makeRequest("GET", { headers: AUTH_HEADERS }));
    expect(res.status).toBe(401);
    expect(mockGetHumanByWallet).not.toHaveBeenCalled();
  });

  it("returns 404 when the caller is not a registered worker", async () => {
    mockGetHumanByWallet.mockResolvedValue(null);
    const { GET } = await import("@/app/api/channels/route");
    const res = await GET(makeRequest("GET", { headers: AUTH_HEADERS }));
    expect(res.status).toBe(404);
  });

  it("lists channels for the verified wallet's contractor record", async () => {
    mockRegisteredHuman();
    const channels = [
      {
        id: CHANNEL_ID,
        contractor_id: CONTRACTOR_ID,
        type: "email",
        address: "worker@example.com",
        accepts_auto_booking: false,
        created_at: "2026-08-21T00:00:00Z",
      },
    ];
    mockGetChannelsForContractor.mockResolvedValue(channels);

    const { GET } = await import("@/app/api/channels/route");
    const res = await GET(makeRequest("GET", { headers: AUTH_HEADERS }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.channels).toEqual(channels);
    // The contractor lookup keys off the *verified* wallet, not a query param.
    expect(mockGetHumanByWallet).toHaveBeenCalledWith(WORKER_WALLET);
    expect(mockGetChannelsForContractor).toHaveBeenCalledWith(CONTRACTOR_ID);
  });
});

// ── POST ───────────────────────────────────────────────────────────────────

describe("POST /api/channels", () => {
  it("rejects an unsigned request with 401", async () => {
    const { POST } = await import("@/app/api/channels/route");
    const res = await POST(
      makeRequest("POST", {
        body: { type: "email", address: "worker@example.com" },
      }),
    );
    expect(res.status).toBe(401);
    expect(mockRegisterNotificationChannel).not.toHaveBeenCalled();
  });

  it("rejects an unknown channel type with 400", async () => {
    mockRegisteredHuman();
    const { POST } = await import("@/app/api/channels/route");
    const res = await POST(
      makeRequest("POST", {
        headers: AUTH_HEADERS,
        body: { type: "sms", address: "+61400000000" },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockRegisterNotificationChannel).not.toHaveBeenCalled();
  });

  it("rejects a missing address with 400", async () => {
    const { POST } = await import("@/app/api/channels/route");
    const res = await POST(
      makeRequest("POST", {
        headers: AUTH_HEADERS,
        body: { type: "email" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an invalid email destination with 400", async () => {
    mockRegisteredHuman();
    const { POST } = await import("@/app/api/channels/route");
    const res = await POST(
      makeRequest("POST", {
        headers: AUTH_HEADERS,
        body: { type: "email", address: "not-an-email" },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Invalid email");
    expect(mockRegisterNotificationChannel).not.toHaveBeenCalled();
  });

  it("rejects a plain-HTTP webhook destination with 400", async () => {
    mockRegisteredHuman();
    const { POST } = await import("@/app/api/channels/route");
    const res = await POST(
      makeRequest("POST", {
        headers: AUTH_HEADERS,
        body: { type: "webhook", address: "http://example.com/hook" },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("HTTPS");
    expect(mockRegisterNotificationChannel).not.toHaveBeenCalled();
  });

  it("rejects a non-URL webhook destination with 400", async () => {
    mockRegisteredHuman();
    const { POST } = await import("@/app/api/channels/route");
    const res = await POST(
      makeRequest("POST", {
        headers: AUTH_HEADERS,
        body: { type: "webhook", address: "example.com/hook" },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockRegisterNotificationChannel).not.toHaveBeenCalled();
  });

  it("rejects an @username Telegram destination with 400", async () => {
    mockRegisteredHuman();
    const { POST } = await import("@/app/api/channels/route");
    const res = await POST(
      makeRequest("POST", {
        headers: AUTH_HEADERS,
        body: { type: "telegram", address: "@worker" },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("numeric chat ID");
    expect(mockRegisterNotificationChannel).not.toHaveBeenCalled();
  });

  it("rejects an @handle Discord destination with 400", async () => {
    mockRegisteredHuman();
    const { POST } = await import("@/app/api/channels/route");
    const res = await POST(
      makeRequest("POST", {
        headers: AUTH_HEADERS,
        body: { type: "discord", address: "@worker" },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("numeric user ID");
    expect(mockRegisterNotificationChannel).not.toHaveBeenCalled();
  });

  it("returns 404 when the caller is not a registered worker", async () => {
    mockGetHumanByWallet.mockResolvedValue(null);
    const { POST } = await import("@/app/api/channels/route");
    const res = await POST(
      makeRequest("POST", {
        headers: AUTH_HEADERS,
        body: { type: "email", address: "worker@example.com" },
      }),
    );
    expect(res.status).toBe(404);
    expect(mockRegisterNotificationChannel).not.toHaveBeenCalled();
  });

  it("registers a valid email channel, trimmed and lowercased", async () => {
    mockRegisteredHuman();
    mockGetChannelsForContractor.mockResolvedValue([]);
    mockRegisterNotificationChannel.mockImplementation(
      async (input: { contractor_id: string; type: string; address: string }) => ({
        id: CHANNEL_ID,
        contractor_id: input.contractor_id,
        type: input.type,
        address: input.address,
        accepts_auto_booking: false,
        created_at: "2026-08-21T00:00:00Z",
      }),
    );

    const { POST } = await import("@/app/api/channels/route");
    const res = await POST(
      makeRequest("POST", {
        headers: AUTH_HEADERS,
        body: { type: "email", address: "  Worker@Example.COM " },
      }),
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.channel.address).toBe("worker@example.com");
    expect(mockRegisterNotificationChannel).toHaveBeenCalledWith({
      contractor_id: CONTRACTOR_ID,
      type: "email",
      address: "worker@example.com",
      accepts_auto_booking: false,
    });
  });

  it("accepts an HTTPS webhook URL", async () => {
    mockRegisteredHuman();
    mockGetChannelsForContractor.mockResolvedValue([]);
    mockRegisterNotificationChannel.mockResolvedValue({
      id: CHANNEL_ID,
      contractor_id: CONTRACTOR_ID,
      type: "webhook",
      address: "https://example.com/hook",
      accepts_auto_booking: false,
      created_at: "2026-08-21T00:00:00Z",
    });

    const { POST } = await import("@/app/api/channels/route");
    const res = await POST(
      makeRequest("POST", {
        headers: AUTH_HEADERS,
        body: { type: "webhook", address: "https://example.com/hook" },
      }),
    );
    expect(res.status).toBe(201);
  });

  it("accepts a negative Telegram group chat ID", async () => {
    mockRegisteredHuman();
    mockGetChannelsForContractor.mockResolvedValue([]);
    mockRegisterNotificationChannel.mockResolvedValue({
      id: CHANNEL_ID,
      contractor_id: CONTRACTOR_ID,
      type: "telegram",
      address: "-1001234567890",
      accepts_auto_booking: false,
      created_at: "2026-08-21T00:00:00Z",
    });

    const { POST } = await import("@/app/api/channels/route");
    const res = await POST(
      makeRequest("POST", {
        headers: AUTH_HEADERS,
        body: { type: "telegram", address: "-1001234567890" },
      }),
    );
    expect(res.status).toBe(201);
  });

  it("preserves the existing accepts_auto_booking flag on update", async () => {
    mockRegisteredHuman();
    mockGetChannelsForContractor.mockResolvedValue([
      {
        id: CHANNEL_ID,
        contractor_id: CONTRACTOR_ID,
        type: "webhook",
        address: "https://old.example.com/hook",
        accepts_auto_booking: true,
        created_at: "2026-08-21T00:00:00Z",
      },
    ]);
    mockRegisterNotificationChannel.mockResolvedValue({
      id: CHANNEL_ID,
      contractor_id: CONTRACTOR_ID,
      type: "webhook",
      address: "https://new.example.com/hook",
      accepts_auto_booking: true,
      created_at: "2026-08-21T00:00:00Z",
    });

    const { POST } = await import("@/app/api/channels/route");
    const res = await POST(
      makeRequest("POST", {
        headers: AUTH_HEADERS,
        body: { type: "webhook", address: "https://new.example.com/hook" },
      }),
    );

    expect(res.status).toBe(201);
    expect(mockRegisterNotificationChannel).toHaveBeenCalledWith(
      expect.objectContaining({ accepts_auto_booking: true }),
    );
  });

  it("passes an explicit accepts_auto_booking through", async () => {
    mockRegisteredHuman();
    mockGetChannelsForContractor.mockResolvedValue([]);
    mockRegisterNotificationChannel.mockResolvedValue({
      id: CHANNEL_ID,
      contractor_id: CONTRACTOR_ID,
      type: "email",
      address: "worker@example.com",
      accepts_auto_booking: true,
      created_at: "2026-08-21T00:00:00Z",
    });

    const { POST } = await import("@/app/api/channels/route");
    const res = await POST(
      makeRequest("POST", {
        headers: AUTH_HEADERS,
        body: {
          type: "email",
          address: "worker@example.com",
          accepts_auto_booking: true,
        },
      }),
    );

    expect(res.status).toBe(201);
    expect(mockRegisterNotificationChannel).toHaveBeenCalledWith(
      expect.objectContaining({ accepts_auto_booking: true }),
    );
  });

  it("does not leak the destination into the error response on DB failure", async () => {
    mockRegisteredHuman();
    mockGetChannelsForContractor.mockResolvedValue([]);
    mockRegisterNotificationChannel.mockRejectedValue(
      new Error("registerNotificationChannel failed: boom"),
    );

    const { POST } = await import("@/app/api/channels/route");
    const res = await POST(
      makeRequest("POST", {
        headers: AUTH_HEADERS,
        body: { type: "email", address: "worker@example.com" },
      }),
    );
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain("worker@example.com");
  });
});

// ── DELETE ─────────────────────────────────────────────────────────────────

describe("DELETE /api/channels", () => {
  it("rejects an unsigned request with 401", async () => {
    const { DELETE } = await import("@/app/api/channels/route");
    const res = await DELETE(
      makeRequest("DELETE", { body: { channel_id: CHANNEL_ID } }),
    );
    expect(res.status).toBe(401);
    expect(mockGetChannelById).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID channel_id with 400", async () => {
    const { DELETE } = await import("@/app/api/channels/route");
    const res = await DELETE(
      makeRequest("DELETE", {
        headers: AUTH_HEADERS,
        body: { channel_id: "not-a-uuid" },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockGetChannelById).not.toHaveBeenCalled();
  });

  it("returns 404 when the channel does not exist", async () => {
    mockGetChannelById.mockResolvedValue(null);
    const { DELETE } = await import("@/app/api/channels/route");
    const res = await DELETE(
      makeRequest("DELETE", {
        headers: AUTH_HEADERS,
        body: { channel_id: CHANNEL_ID },
      }),
    );
    expect(res.status).toBe(404);
    expect(mockRemoveNotificationChannel).not.toHaveBeenCalled();
  });

  it("rejects a validly-signed request from another wallet with 403", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(OTHER_WALLET);
    mockRegisteredHuman(OTHER_WALLET, OTHER_CONTRACTOR_ID);
    mockGetChannelById.mockResolvedValue({
      id: CHANNEL_ID,
      contractor_id: CONTRACTOR_ID,
      type: "email",
      address: "worker@example.com",
      accepts_auto_booking: false,
      created_at: "2026-08-21T00:00:00Z",
    });

    const { DELETE } = await import("@/app/api/channels/route");
    const res = await DELETE(
      makeRequest("DELETE", {
        headers: {
          ...AUTH_HEADERS,
          "x-caller-wallet": OTHER_WALLET,
        },
        body: { channel_id: CHANNEL_ID },
      }),
    );

    expect(res.status).toBe(403);
    expect(mockRemoveNotificationChannel).not.toHaveBeenCalled();
  });

  it("removes the channel when the owner's signature is valid", async () => {
    mockRegisteredHuman();
    mockGetChannelById.mockResolvedValue({
      id: CHANNEL_ID,
      contractor_id: CONTRACTOR_ID,
      type: "email",
      address: "worker@example.com",
      accepts_auto_booking: false,
      created_at: "2026-08-21T00:00:00Z",
    });
    mockRemoveNotificationChannel.mockResolvedValue(true);

    const { DELETE } = await import("@/app/api/channels/route");
    const res = await DELETE(
      makeRequest("DELETE", {
        headers: AUTH_HEADERS,
        body: { channel_id: CHANNEL_ID },
      }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.id).toBe(CHANNEL_ID);
    expect(mockRemoveNotificationChannel).toHaveBeenCalledWith(CHANNEL_ID);
  });
});
