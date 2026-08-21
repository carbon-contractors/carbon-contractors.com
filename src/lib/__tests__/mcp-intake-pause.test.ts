import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpServer } from "@/lib/mcp/server";
import { _resetConfig } from "@/lib/config";

// Mock database and external modules
vi.mock("@/lib/db/whitepages", () => ({
  searchByCategory: vi.fn().mockResolvedValue([]),
  getAllHumans: vi.fn().mockResolvedValue([]),
  getHumanByWallet: vi.fn().mockResolvedValue({
    id: "h_1",
    wallet_address: "0x1111111111111111111111111111111111111111",
    name: "Alice",
  }),
  getHumanById: vi.fn(),
  getDistinctCategories: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/ratelimit", () => ({
  taskCreationRateLimiter: {
    limit: vi.fn().mockResolvedValue({ success: true, retryAfterS: 0 }),
  },
  generalRateLimiter: {
    limit: vi.fn().mockResolvedValue({ success: true, retryAfterS: 0 }),
  },
}));

vi.mock("@/lib/logging", () => ({
  log: vi.fn(),
}));

describe("Emergency Intake Kill Switch (ADR-0003 D4 / CC-086)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    _resetConfig();
  });

  it("blocks request_human_work when NEXT_PUBLIC_INTAKE_PAUSED=true with informative payload", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTAKE_PAUSED", "true");
    vi.stubEnv(
      "NEXT_PUBLIC_INTAKE_PAUSE_NOTICE",
      "Emergency invariant investigation in progress."
    );
    _resetConfig();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = createMcpServer({ callerWallet: "0x2222222222222222222222222222222222222222" }) as any;

    const tool = server._registeredTools["request_human_work"];
    expect(tool).toBeDefined();

    const result = await tool.handler({
      to_human_wallet: "0x1111111111111111111111111111111111111111",
      task_description: "Audit the contract parameters",
      amount_usdc: 100,
      deadline_hours: 24,
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.intake_paused).toBe(true);
    expect(parsed.claims_active).toBe(true);
    expect(parsed.retry_after_s).toBe(300);
    expect(parsed.error).toContain("Emergency invariant investigation in progress.");
  });

  it("allows search_whitepages even when intake is paused", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTAKE_PAUSED", "true");
    _resetConfig();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = createMcpServer({ callerWallet: "0x2222222222222222222222222222222222222222" }) as any;

    const tool = server._registeredTools["search_whitepages"];
    expect(tool).toBeDefined();

    const result = await tool.handler({ category: "development" });
    expect(result.isError).toBeUndefined();
  });
});
