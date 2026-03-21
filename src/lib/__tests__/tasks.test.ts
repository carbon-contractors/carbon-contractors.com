import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Supabase client (reads use anon, writes use admin — both share mockFrom)
const mockFrom = vi.fn();
vi.mock("@/lib/db/client", () => ({
  getSupabase: () => ({ from: mockFrom }),
  getSupabaseAdmin: () => ({ from: mockFrom }),
}));

// Stub config env
vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_ANON_KEY", "key");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
vi.stubEnv("NEXT_PUBLIC_ONCHAINKIT_API_KEY", "key");
vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");

import { getTaskByPaymentId, updateTaskStatus, getReputationSummary } from "@/lib/db/tasks";

function chainable(result: { data: unknown; error: unknown }) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue(result),
    limit: vi.fn().mockResolvedValue(result),
    single: vi.fn().mockResolvedValue(result),
  };
  return chain;
}

describe("tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getTaskByPaymentId returns task when found", async () => {
    const task = { id: "1", payment_request_id: "abc", status: "active" };
    const chain = chainable({ data: task, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await getTaskByPaymentId("abc");
    expect(result).toEqual(task);
    expect(mockFrom).toHaveBeenCalledWith("tasks");
  });

  it("getTaskByPaymentId returns null when not found", async () => {
    const chain = chainable({
      data: null,
      error: { message: "not found", code: "PGRST116" },
    });
    mockFrom.mockReturnValue(chain);

    const result = await getTaskByPaymentId("nonexistent");
    expect(result).toBeNull();
  });

  it("getTaskByPaymentId throws on real errors", async () => {
    const chain = chainable({
      data: null,
      error: { message: "connection failed", code: "500" },
    });
    mockFrom.mockReturnValue(chain);

    await expect(getTaskByPaymentId("abc")).rejects.toThrow(
      "getTaskByPaymentId failed"
    );
  });

  it("updateTaskStatus calls update with correct args", async () => {
    // First call: select to fetch current status
    const selectChain = chainable({ data: { status: "active" }, error: null });
    // Second call: update
    const updateChain = chainable({ data: null, error: null });
    mockFrom
      .mockReturnValueOnce(selectChain)
      .mockReturnValueOnce(updateChain);

    await updateTaskStatus("abc", "completed");
    expect(mockFrom).toHaveBeenCalledWith("tasks");
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" })
    );
  });

  it("updateTaskStatus rejects invalid state transitions", async () => {
    const selectChain = chainable({ data: { status: "completed" }, error: null });
    mockFrom.mockReturnValue(selectChain);

    await expect(updateTaskStatus("abc", "active")).rejects.toThrow(
      "Invalid state transition: completed → active"
    );
  });

  it("getReputationSummary computes counts correctly", async () => {
    const now = new Date().toISOString();
    const tasks = [
      { status: "completed", amount_usdc: 100, created_at: now },
      { status: "completed", amount_usdc: 50, created_at: now },
      { status: "disputed", amount_usdc: 75, created_at: now },
      { status: "active", amount_usdc: 200, created_at: now },
    ];
    const chain = chainable({ data: tasks, error: null });
    // getTasksByWallet is called internally, which uses order
    mockFrom.mockReturnValue(chain);

    const summary = await getReputationSummary("0x123");
    expect(summary.total_tasks).toBe(4);
    expect(summary.completed).toBe(2);
    expect(summary.disputed).toBe(1);
    expect(summary.active).toBe(1);
    expect(summary.total_earned_usdc).toBe(150);
  });

  it("getReputationSummary handles empty task list", async () => {
    const chain = chainable({ data: [], error: null });
    mockFrom.mockReturnValue(chain);

    const summary = await getReputationSummary("0x456");
    expect(summary.total_tasks).toBe(0);
    expect(summary.completed).toBe(0);
    expect(summary.total_earned_usdc).toBe(0);
  });
});
