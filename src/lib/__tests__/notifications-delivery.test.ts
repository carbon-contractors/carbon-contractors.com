import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

// ── Module mocks ───────────────────────────────────────────────────────────────
//
// Same pattern as mcp-request-human-work.test.ts. `testConfig` is hoisted rather
// than a plain const because the vi.mock factory for @/lib/config closes over it
// and runs while the imports below are still resolving.

const mockGetHumanByWallet = vi.fn();
const mockGetHumanById = vi.fn();
vi.mock("@/lib/db/whitepages", () => ({
  getHumanByWallet: (...args: unknown[]) => mockGetHumanByWallet(...args),
  getHumanById: (...args: unknown[]) => mockGetHumanById(...args),
  searchByCategory: vi.fn(),
  getAllHumans: vi.fn(),
  getDistinctCategories: vi.fn(),
}));

const mockGetChannelsForContractor = vi.fn();
vi.mock("@/lib/db/notifications", () => ({
  getChannelsForContractor: (...args: unknown[]) =>
    mockGetChannelsForContractor(...args),
}));

const { testConfig } = vi.hoisted(() => ({
  testConfig: {
    NOTIFICATION_WEBHOOK_SECRET: "test-webhook-secret",
    NOTIFICATION_EMAIL_WEBHOOK_URL: "https://email-gw.example.test/send",
    TELEGRAM_BOT_TOKEN: "test-telegram-token",
  } as Record<string, string | undefined>,
}));
vi.mock("@/lib/config", () => ({
  getConfig: () => testConfig,
}));

import {
  notifyContractor,
  dispatchToChannels,
} from "@/lib/notifications/delivery";
import type { NotificationChannel } from "@/lib/db/notifications";
import type { NotificationPayload } from "@/lib/notifications/types";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const CONTRACTOR_ID = "11111111-1111-4111-8111-111111111111";
// Must be valid 40-char hex — notifyContractor routes on that shape.
const WORKER_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const WORKER_WALLET_CHECKSUMMED = "0x1234567890ABCDEF1234567890abcdef12345678";

const RAW_EMAIL = "contractor@example.com";
const WEBHOOK_URL = "https://hooks.example.test/worker/SECRETTOKEN123";
const TELEGRAM_CHAT_ID = "987654321";
const DISCORD_URL = "https://discord.com/api/webhooks/123456/SECRET";

const SECRET_TASK_DESCRIPTION = "Photograph the switchboard in Rack Room 2";

function channel(
  type: NotificationChannel["type"],
  address: string,
  id = `${type}-channel`,
): NotificationChannel {
  return {
    id,
    contractor_id: CONTRACTOR_ID,
    type,
    address,
    accepts_auto_booking: false,
    created_at: "2026-08-22T00:00:00Z",
  };
}

const PAYLOAD: NotificationPayload = {
  taskId: "pr_test_001",
  amountUsdc: 25,
  offerExpiresAt: 1_775_000_000,
  taskDescription: SECRET_TASK_DESCRIPTION,
};

// Backoff of 1ms keeps the retry suite fast; the production default is 500ms.
const FAST_POLICY = { backoffBaseMs: 1 };

const fetchMock = vi.fn();

/** A minimal fetch Response-alike — postJson only reads `status` and `ok`. */
function res(status: number) {
  return { ok: status >= 200 && status < 300, status };
}

function lastCall(): { url: string; body: string; headers: Record<string, string> } {
  const call = fetchMock.mock.calls.at(-1)!;
  return {
    url: String(call[0]),
    body: call[1]?.body as string,
    headers: (call[1]?.headers ?? {}) as Record<string, string>,
  };
}

function allLogOutput(): string {
  return (
    (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls as unknown[][]
  )
    .map((args) => args.map(String).join(" "))
    .join("\n");
}

describe("notification delivery (CC-095)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    // log() writes single-line JSON to console.log; capture it for PII assertions.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(res(200));
    mockGetHumanByWallet.mockResolvedValue({
      id: CONTRACTOR_ID,
      wallet: WORKER_WALLET.toLowerCase(),
    });
    mockGetHumanById.mockResolvedValue({ id: CONTRACTOR_ID });
    mockGetChannelsForContractor.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── Per-channel success ─────────────────────────────────────────────────────

  it("delivers to a webhook channel with a signed JSON envelope", async () => {
    mockGetChannelsForContractor.mockResolvedValue([
      channel("webhook", WEBHOOK_URL),
    ]);
    const results = await notifyContractor(
      WORKER_WALLET,
      "offer_received",
      PAYLOAD,
      FAST_POLICY,
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      channelType: "webhook",
      outcome: "delivered",
      attempts: 1,
    });

    const { url, body, headers } = lastCall();
    expect(url).toBe(WEBHOOK_URL);
    const envelope = JSON.parse(body);
    expect(envelope).toMatchObject({
      version: 1,
      event: "offer_received",
      task_id: "pr_test_001",
      amount_usdc: 25,
      task_description: SECRET_TASK_DESCRIPTION,
    });
    expect(envelope.message.title).toBe("New task offer");

    // The HMAC covers `${timestamp}.${body}` and is verifiable at the receiver.
    const timestamp = headers["x-cc-timestamp"];
    expect(timestamp).toMatch(/^\d+$/);
    const expected = createHmac("sha256", "test-webhook-secret")
      .update(`${timestamp}.${body}`)
      .digest("hex");
    expect(headers["x-cc-signature"]).toBe(`sha256=${expected}`);
  });

  it("delivers to an email channel via the configured gateway transport", async () => {
    mockGetChannelsForContractor.mockResolvedValue([
      channel("email", RAW_EMAIL),
    ]);
    const results = await notifyContractor(
      WORKER_WALLET,
      "payment_claimable",
      PAYLOAD,
      FAST_POLICY,
    );

    expect(results[0]).toMatchObject({
      channelType: "email",
      outcome: "delivered",
      attempts: 1,
    });

    const { url, body, headers } = lastCall();
    expect(url).toBe("https://email-gw.example.test/send");
    const sent = JSON.parse(body);
    expect(sent.to).toBe(RAW_EMAIL);
    expect(sent.subject).toContain("Payment claimable");
    expect(sent.text).toContain("pr_test_001");
    expect(sent.text).toContain("25 USDC");
    // Signed like any other outbound payload.
    expect(headers["x-cc-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("delivers to a telegram channel via the Bot API", async () => {
    mockGetChannelsForContractor.mockResolvedValue([
      channel("telegram", TELEGRAM_CHAT_ID),
    ]);
    const results = await notifyContractor(
      WORKER_WALLET,
      "offer_expiring",
      PAYLOAD,
      FAST_POLICY,
    );

    expect(results[0]).toMatchObject({
      channelType: "telegram",
      outcome: "delivered",
      attempts: 1,
    });

    const { url, body } = lastCall();
    expect(url).toBe("https://api.telegram.org/bottest-telegram-token/sendMessage");
    const sent = JSON.parse(body);
    expect(sent.chat_id).toBe(TELEGRAM_CHAT_ID);
    expect(sent.text).toContain("Task offer expiring soon");
    expect(sent.text).toContain("pr_test_001");
    expect(sent.text).toMatch(/2026-\d{2}-\d{2}T/); // offerExpiresAt as ISO
  });

  it("delivers to a discord channel via its webhook URL", async () => {
    mockGetChannelsForContractor.mockResolvedValue([
      channel("discord", DISCORD_URL),
    ]);
    const results = await notifyContractor(
      WORKER_WALLET,
      "task_funded",
      PAYLOAD,
      FAST_POLICY,
    );

    expect(results[0]).toMatchObject({
      channelType: "discord",
      outcome: "delivered",
      attempts: 1,
    });

    const { url, body } = lastCall();
    expect(url).toBe(DISCORD_URL);
    const sent = JSON.parse(body);
    expect(sent.content).toContain("**Task funded**");
    expect(sent.content).toContain("pr_test_001");
  });

  it("dispatches to all registered channels in parallel", async () => {
    mockGetChannelsForContractor.mockResolvedValue([
      channel("email", RAW_EMAIL, "ch-email"),
      channel("webhook", WEBHOOK_URL, "ch-webhook"),
      channel("telegram", TELEGRAM_CHAT_ID, "ch-telegram"),
      channel("discord", DISCORD_URL, "ch-discord"),
    ]);
    const results = await notifyContractor(
      CONTRACTOR_ID,
      "verdict_signed",
      PAYLOAD,
      FAST_POLICY,
    );

    expect(results).toHaveLength(4);
    expect(results.every((r) => r.outcome === "delivered")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // Resolved by UUID, not wallet.
    expect(mockGetHumanById).toHaveBeenCalledWith(CONTRACTOR_ID);
    expect(mockGetHumanByWallet).not.toHaveBeenCalled();
  });

  // ── Retry and failure semantics ─────────────────────────────────────────────

  it("retries a webhook 500 and delivers once it clears", async () => {
    fetchMock
      .mockResolvedValueOnce(res(500))
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(200));
    const results = await dispatchToChannels(
      [channel("webhook", WEBHOOK_URL)],
      "task_funded",
      PAYLOAD,
      FAST_POLICY,
    );

    expect(results[0]).toMatchObject({ outcome: "delivered", attempts: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries timeouts and network faults (both transient)", async () => {
    const abort = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    fetchMock
      .mockRejectedValueOnce(abort)
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(res(200));
    const results = await dispatchToChannels(
      [channel("telegram", TELEGRAM_CHAT_ID)],
      "task_funded",
      PAYLOAD,
      FAST_POLICY,
    );

    expect(results[0]).toMatchObject({ outcome: "delivered", attempts: 3 });
  });

  it("reports a permanent failure visibly after exhausting the retry budget", async () => {
    fetchMock.mockResolvedValue(res(500));
    const results = await dispatchToChannels(
      [channel("webhook", WEBHOOK_URL)],
      "task_funded",
      PAYLOAD,
      { ...FAST_POLICY, maxAttempts: 3 },
    );

    expect(results[0]).toMatchObject({
      outcome: "failed",
      attempts: 3,
      error: "http_500",
    });
    // Visible, not silent: the exhausted failure is logged at error level.
    const errorLines = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((args: unknown[]) => String(args[0]))
      .filter((line: string) => line.includes('"notification_delivery_result"'));
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain('"level":"error"');
    expect(errorLines[0]).toContain('"outcome":"failed"');
  });

  it("does not retry a 4xx — the worker's endpoint rejected it outright", async () => {
    fetchMock.mockResolvedValue(res(404));
    const results = await dispatchToChannels(
      [channel("discord", DISCORD_URL)],
      "task_funded",
      PAYLOAD,
      FAST_POLICY,
    );

    expect(results[0]).toMatchObject({
      outcome: "failed",
      attempts: 1,
      error: "http_404",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails visibly when a transport is unconfigured rather than skipping silently", async () => {
    const savedToken = testConfig.TELEGRAM_BOT_TOKEN;
    const savedGateway = testConfig.NOTIFICATION_EMAIL_WEBHOOK_URL;
    testConfig.TELEGRAM_BOT_TOKEN = undefined;
    testConfig.NOTIFICATION_EMAIL_WEBHOOK_URL = undefined;
    try {
      const results = await dispatchToChannels(
        [channel("telegram", TELEGRAM_CHAT_ID), channel("email", RAW_EMAIL)],
        "offer_received",
        PAYLOAD,
        FAST_POLICY,
      );

      expect(results[0]).toMatchObject({
        outcome: "failed",
        error: "telegram_unconfigured",
      });
      expect(results[1]).toMatchObject({
        outcome: "failed",
        error: "email_transport_unconfigured",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      testConfig.TELEGRAM_BOT_TOKEN = savedToken;
      testConfig.NOTIFICATION_EMAIL_WEBHOOK_URL = savedGateway;
    }
  });

  it("contains an adapter that throws instead of rejecting the dispatch", async () => {
    fetchMock.mockRejectedValue(new Error("unexpected"));
    const results = await dispatchToChannels(
      [channel("webhook", WEBHOOK_URL)],
      "task_funded",
      PAYLOAD,
      FAST_POLICY,
    );
    // Network faults are retried then reported — a rejected promise never escapes.
    expect(results[0]).toMatchObject({ outcome: "failed", error: "network_error" });
  });

  // ── PII never reaches a log line ────────────────────────────────────────────

  it("logs no email address, channel URL, or task content — only masked handles", async () => {
    mockGetChannelsForContractor.mockResolvedValue([
      channel("email", RAW_EMAIL),
      channel("webhook", WEBHOOK_URL),
      channel("discord", DISCORD_URL),
    ]);
    fetchMock.mockResolvedValue(res(500)); // force the failure path's logs too
    const results = await notifyContractor(
      WORKER_WALLET,
      "offer_received",
      PAYLOAD,
      FAST_POLICY,
    );

    expect(results.every((r) => r.outcome === "failed")).toBe(true);

    const logged = allLogOutput();
    expect(logged).not.toBe("");
    expect(logged).not.toContain(RAW_EMAIL);
    expect(logged).not.toContain("example.com"); // email domain
    expect(logged).not.toContain(WEBHOOK_URL);
    expect(logged).not.toContain("SECRETTOKEN123"); // webhook credential in URL
    expect(logged).not.toContain(DISCORD_URL);
    expect(logged).not.toContain(SECRET_TASK_DESCRIPTION);
    expect(logged).not.toContain("switchboard");
    // The masked handle is present instead, so lines remain correlatable.
    expect(logged).toMatch(/"channel_address_masked":"#[0-9a-f]{12}"/);
  });

  // ── Payload structuring ─────────────────────────────────────────────────────

  it("structures each event's message from the same payload", async () => {
    mockGetChannelsForContractor.mockResolvedValue([
      channel("discord", DISCORD_URL),
    ]);
    await notifyContractor(WORKER_WALLET, "payment_claimable", PAYLOAD, FAST_POLICY);

    let sent = JSON.parse(lastCall().body);
    expect(sent.content).toContain("claimable");
    expect(sent.content).toContain("25 USDC");

    await notifyContractor(WORKER_WALLET, "verdict_signed", { taskId: "pr_x" }, FAST_POLICY);
    sent = JSON.parse(lastCall().body);
    expect(sent.content).toContain("verdict");
    // No amount in the payload → no amount in the message.
    expect(sent.content).not.toContain("USDC");
  });

  it("rejects a malformed payload loudly rather than delivering it", async () => {
    await expect(
      notifyContractor(
        WORKER_WALLET,
        "offer_received",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { taskId: "" } as any,
      ),
    ).rejects.toThrow(/invalid payload/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("truncates chat-channel text to the receiver's length limit", async () => {
    mockGetChannelsForContractor.mockResolvedValue([
      channel("discord", DISCORD_URL),
    ]);
    await notifyContractor(
      WORKER_WALLET,
      "offer_received",
      { ...PAYLOAD, taskDescription: "x".repeat(2_000) },
      FAST_POLICY,
    );
    const sent = JSON.parse(lastCall().body);
    expect(sent.content.length).toBeLessThanOrEqual(2_000);
    expect(sent.content.endsWith("…")).toBe(true);
  });

  // ── Contractor resolution ───────────────────────────────────────────────────

  it("normalises a mixed-case wallet before the DB lookup (migration 014)", async () => {
    mockGetChannelsForContractor.mockResolvedValue([
      channel("telegram", TELEGRAM_CHAT_ID),
    ]);
    await notifyContractor(
      WORKER_WALLET_CHECKSUMMED,
      "offer_received",
      PAYLOAD,
      FAST_POLICY,
    );

    expect(mockGetHumanByWallet).toHaveBeenCalledWith(WORKER_WALLET);
  });

  it("returns empty for an unknown contractor and logs it, without fetching", async () => {
    mockGetHumanByWallet.mockResolvedValue(null);
    const results = await notifyContractor(
      WORKER_WALLET,
      "offer_received",
      PAYLOAD,
      FAST_POLICY,
    );

    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(allLogOutput()).toContain("notification_contractor_not_found");
  });

  it("returns empty for a contractor with no registered channels", async () => {
    const results = await notifyContractor(
      WORKER_WALLET,
      "offer_received",
      PAYLOAD,
      FAST_POLICY,
    );

    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns empty when the channel load fails, rather than throwing", async () => {
    mockGetChannelsForContractor.mockRejectedValue(
      new Error("getChannelsForContractor failed: connection refused"),
    );
    const results = await notifyContractor(
      WORKER_WALLET,
      "offer_received",
      PAYLOAD,
      FAST_POLICY,
    );

    expect(results).toEqual([]);
    // The DB fault's own message must not leak into the log — it can embed params.
    const logged = allLogOutput();
    expect(logged).toContain("notification_channel_load_failed");
    expect(logged).not.toContain("connection refused");
  });
});
