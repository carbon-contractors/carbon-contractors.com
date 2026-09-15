import { describe, it, expect, vi, beforeEach } from "vitest";
// Static, not dynamic: `vi.mock` is hoisted above it (see mcp-request-human-work.test.ts).
import { createMcpServer } from "@/lib/mcp/server";

const mockGetHumanByWallet = vi.fn();
vi.mock("@/lib/db/whitepages", () => ({
  getHumanByWallet: (...args: unknown[]) => mockGetHumanByWallet(...args),
  searchByCategory: vi.fn(),
  getAllHumans: vi.fn(),
  getHumanById: vi.fn(),
  getDistinctCategories: vi.fn(),
}));

const mockRegisterNotificationChannel = vi.fn();
const mockGetChannelsForContractor = vi.fn();
vi.mock("@/lib/db/notifications", () => ({
  registerNotificationChannel: (...args: unknown[]) =>
    mockRegisterNotificationChannel(...args),
  getChannelsForContractor: (...args: unknown[]) =>
    mockGetChannelsForContractor(...args),
}));

const WORKER_WALLET = "0xWORKERworkerWORKERworkerWORKERworkerWORK";
const CALLER_CONTRACTOR_ID = "caller-contractor-uuid";

async function callRegisterChannel(
  args: Record<string, unknown>,
  callerWallet: string | null = WORKER_WALLET,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = createMcpServer({ callerWallet }) as any;
  const tool = server._registeredTools["register_notification_channel"];
  const result = await tool.handler(args);
  return { result, tool, json: JSON.parse(result.content[0].text) };
}

describe("register_notification_channel MCP tool (CC-045)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetHumanByWallet.mockResolvedValue({
      id: CALLER_CONTRACTOR_ID,
      wallet: WORKER_WALLET.toLowerCase(),
      categories: ["delivery-errands"],
      rate_usdc: 40,
      availability: "available",
      reputation_score: 80,
    });
    mockRegisterNotificationChannel.mockImplementation(
      async (input: Record<string, unknown>) => ({
        id: "channel-uuid",
        ...input,
      }),
    );
  });

  it("rejects an unauthenticated caller", async () => {
    const { json } = await callRegisterChannel(
      {
        type: "email",
        address: "worker@example.com",
        accepts_auto_booking: true,
      },
      null,
    );

    expect(json.ok).toBe(false);
    expect(json.code).toBe("UNAUTHENTICATED");
    expect(mockRegisterNotificationChannel).not.toHaveBeenCalled();
  });

  it("binds the channel to the authenticated caller's own contractor record, ignoring any contractor_id argument", async () => {
    const VICTIM_UUID = "00000000-0000-0000-0000-000000000000";
    const { json } = await callRegisterChannel({
      type: "email",
      address: "Worker@Example.com",
      accepts_auto_booking: false,
      // Smuggled past the schema (direct handler invocation) — must be ignored.
      contractor_id: VICTIM_UUID,
    });

    expect(json.ok).toBe(true);
    expect(mockRegisterNotificationChannel).toHaveBeenCalledTimes(1);
    const call = mockRegisterNotificationChannel.mock.calls[0][0];
    expect(call.contractor_id).toBe(CALLER_CONTRACTOR_ID);
    expect(call.contractor_id).not.toBe(VICTIM_UUID);
    // Email is normalised (trimmed, lowercased) exactly as /api/channels does.
    expect(call.address).toBe("worker@example.com");
  });

  it("no longer exposes contractor_id in its input schema", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = createMcpServer({ callerWallet: WORKER_WALLET }) as any;
    const tool = server._registeredTools["register_notification_channel"];
    const params: string[] = Object.keys(tool.inputSchema?.shape ?? {});
    expect(params).toContain("type");
    expect(params).toContain("address");
    expect(params).toContain("accepts_auto_booking");
    expect(params).not.toContain("contractor_id");
  });

  it("rejects an authenticated wallet with no contractor record", async () => {
    mockGetHumanByWallet.mockResolvedValue(null);

    const { json } = await callRegisterChannel({
      type: "email",
      address: "ghost@example.com",
      accepts_auto_booking: false,
    });

    expect(json.ok).toBe(false);
    expect(json.code).toBe("CONTRACTOR_NOT_FOUND");
    expect(mockRegisterNotificationChannel).not.toHaveBeenCalled();
  });

  it.each([
    ["webhook", "http://insecure.example/hook", "must be an HTTPS URL"],
    ["webhook", "not-a-url", "must be an HTTPS URL"],
    ["telegram", "@username", "numeric chat ID"],
    ["telegram", "abc123", "numeric chat ID"],
    ["discord", "username#1234", "numeric user ID"],
    ["email", "not-an-email", "Invalid email address"],
  ])(
    "rejects an invalid %s address (%s)",
    async (type, address, messageFragment) => {
      const { json } = await callRegisterChannel({
        type,
        address,
        accepts_auto_booking: true,
      });

      expect(json.ok).toBe(false);
      expect(json.code).toBe("INVALID_ARGUMENT");
      expect(json.reason).toBe("invalid_channel_address");
      expect(json.error).toContain(messageFragment);
      expect(mockRegisterNotificationChannel).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["email", "worker@example.com", "worker@example.com"],
    [
      "webhook",
      "https://hooks.example.com/deliver",
      "https://hooks.example.com/deliver",
    ],
    ["telegram", "-1001234567890", "-1001234567890"],
    ["discord", "290926444765396993", "290926444765396993"],
  ])("accepts and stores a valid %s address", async (type, address, stored) => {
    const { json } = await callRegisterChannel({
      type,
      address,
      accepts_auto_booking: true,
    });

    expect(json.ok).toBe(true);
    const call = mockRegisterNotificationChannel.mock.calls[0][0];
    expect(call.type).toBe(type);
    expect(call.address).toBe(stored);
  });

  it("never echoes the channel address back in the response", async () => {
    const { result } = await callRegisterChannel({
      type: "email",
      address: "private@example.com",
      accepts_auto_booking: false,
    });

    expect(result.content[0].text).not.toContain("private@example.com");
  });
});
