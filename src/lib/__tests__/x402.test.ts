import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db/tasks
vi.mock("@/lib/db/tasks", () => ({
  createTask: vi.fn().mockResolvedValue({ id: "1", payment_request_id: "mock" }),
}));

// Mock contracts/escrow
vi.mock("@/lib/contracts/escrow", () => ({
  toTaskId: vi.fn().mockReturnValue("0x" + "ab".repeat(32)),
  getEscrowConfig: vi.fn().mockReturnValue({
    address: "0x1234567890123456789012345678901234567890",
    chainId: 84532,
    chainName: "Base Sepolia",
    usdcDecimals: 6,
  }),
}));

// Stub config env
vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_ANON_KEY", "key");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
vi.stubEnv("NEXT_PUBLIC_ONCHAINKIT_API_KEY", "key");
vi.stubEnv("NEXT_PUBLIC_BASE_URL", "http://localhost:3000");
vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");

import { initiateX402Payment } from "@/lib/payments/x402";

describe("x402 payment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates payment request with correct fields", async () => {
    const result = await initiateX402Payment({
      from_agent_wallet: "0x" + "a".repeat(40),
      to_human_wallet: "0x" + "b".repeat(40),
      task_description: "Build a smart contract for NFT minting",
      amount_usdc: 100,
      deadline_unix: Math.floor(Date.now() / 1000) + 3600,
    });

    expect(result.status).toBe("awaiting_funding");
    expect(result.payment_request_id).toBeTruthy();
    expect(result.amount_usdc).toBe(100);
    expect(result.amount_wei).toBe("100000000"); // 100 * 10^6
    expect(result.fund_url).toContain("/api/fund-task");
  });

  it("rejects zero amount", async () => {
    await expect(
      initiateX402Payment({
        from_agent_wallet: "0x" + "a".repeat(40),
        to_human_wallet: "0x" + "b".repeat(40),
        task_description: "Some task description here",
        amount_usdc: 0,
        deadline_unix: Math.floor(Date.now() / 1000) + 3600,
      })
    ).rejects.toThrow("amount_usdc must be > 0");
  });

  it("rejects invalid wallet address", async () => {
    await expect(
      initiateX402Payment({
        from_agent_wallet: "invalid",
        to_human_wallet: "0x" + "b".repeat(40),
        task_description: "Some task description here",
        amount_usdc: 50,
        deadline_unix: Math.floor(Date.now() / 1000) + 3600,
      })
    ).rejects.toThrow("from_agent_wallet must be a valid 0x address");
  });
});
