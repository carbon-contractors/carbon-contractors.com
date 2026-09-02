import { describe, expect, vi } from "vitest";
import { createMockSupabase } from "./helpers/mock-supabase";

/**
 * NOR-330 — slash records. The load-bearing property is the unique tx_hash:
 * one on-chain slash, one row, and a re-run surfaces 23505 in the message so
 * the recorder can treat it as a no-op.
 */

const { mockClient, chainable } = createMockSupabase({ data: null, error: null });

vi.mock("@/lib/db/client", () => ({
  getSupabaseAdmin: () => mockClient,
}));

import { createSlashRecord, listSlashRecords } from "@/lib/db/slashes";

const WALLET = "0x1234567890abcdef1234567890abcdef12345678";

describe("slash records (NOR-330)", () => {
  it("inserts with a lowercase wallet and a nullable task link", async () => {
    (chainable.single as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "r1", wallet: WALLET, amount_usdc: 5, payment_request_id: null, tx_hash: "0xtx", slashed_at: "t" },
      error: null,
    });
    const record = await createSlashRecord({
      wallet: WALLET.toUpperCase(),
      amount_usdc: 5,
      tx_hash: "0xtx",
    });
    expect(record.id).toBe("r1");
    const payload = chainable.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.wallet).toBe(WALLET);
    expect(payload.payment_request_id).toBeNull();
    expect(payload.tx_hash).toBe("0xtx");
  });

  it("keeps the 23505 code in the message on a duplicate tx", async () => {
    (chainable.single as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: { code: "23505", message: "duplicate key" },
    });
    await expect(
      createSlashRecord({ wallet: WALLET, amount_usdc: 5, tx_hash: "0xdup" }),
    ).rejects.toThrow("(23505)");
  });

  it("lists a wallet's slashes newest first", async () => {
    (chainable.order as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ id: "r2" }, { id: "r1" }],
      error: null,
    });
    const rows = await listSlashRecords(WALLET);
    expect(rows).toHaveLength(2);
    expect(chainable.eq).toHaveBeenCalledWith("wallet", WALLET);
    expect(chainable.order).toHaveBeenCalledWith("slashed_at", { ascending: false });
  });
});
