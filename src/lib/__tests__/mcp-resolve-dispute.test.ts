import { describe, it, expect, vi } from "vitest";

/**
 * `resolve_dispute` was removed under `ADR-0001` D2 (2026-08-26).
 *
 * This file used to assert the tool worked. It worked exactly as designed and the design
 * was the defect: it authorised `task.from_agent_wallet === callerWallet` — the hiring
 * agent — and then executed that ruling with the platform's owner key. So an agent could
 * fund, wait for delivery, dispute, and resolve in its own favour, with `onlyOwner`
 * notarising one interested party's decision and the worker holding no recourse at all.
 *
 * The tests are inverted rather than deleted, on the CC-080 precedent
 * (`signer.test.ts`, "no longer exports completeTaskOnChain"): a removal that nothing
 * asserts is a removal that gets quietly undone. What this file pins now is the absence.
 *
 * There is deliberately no replacement tool. Arbitration is owner-operated until the
 * adjudication tier exists (`ADR-0007`, proposed) — the owner resolves through
 * `scripts/admin/verify-escrow-lifecycle.ts` with the KMS key (`CC-059`).
 */

vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: vi.fn(),
  updateTaskStatus: vi.fn(),
  createTask: vi.fn(),
  getTasksForParties: vi.fn(),
  getPublicTasks: vi.fn(),
  lapseExpiredOffers: vi.fn(),
  countCommittedTasks: vi.fn(),
  findTaskByIdempotencyKey: vi.fn(),
  markTaskFunded: vi.fn(),
  WORKER_CONCURRENCY_CAP: 3,
}));

vi.mock("@/lib/contracts/escrow", () => ({
  getOnChainTask: vi.fn(),
  getTaskResolvedOutcome: vi.fn(),
  getEscrowConfig: () => ({
    address: "0xEscrow00000000000000000000000000000000",
    chainId: 84532,
    chainName: "Base Sepolia",
  }),
  toTaskId: (paymentRequestId: string) => `0xtaskid-${paymentRequestId}`,
}));

const AGENT_WALLET = "0xagentagentagentagentagentagentagentagen";

async function registeredTools(): Promise<Record<string, unknown>> {
  const { createMcpServer } = await import("@/lib/mcp/server");
  // The MCP SDK keeps each registered tool on `_registeredTools[name]`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = createMcpServer({ callerWallet: AGENT_WALLET }) as any;
  return server._registeredTools;
}

describe("resolve_dispute is gone (ADR-0001 D2)", () => {
  it("is not a registered MCP tool", async () => {
    const tools = await registeredTools();
    expect(tools["resolve_dispute"]).toBeUndefined();
  });

  it("exposes no adjudication tool under any other name either", async () => {
    // The failure this guards against is not "someone re-adds resolve_dispute" — it is
    // "someone re-adds the capability under a friendlier name". Arbitration has no MCP
    // surface at all right now, and that is the decision, not an oversight.
    const names = Object.keys(await registeredTools());
    const adjudication = names.filter((n) =>
      /resolve|arbitrat|adjudicat|settle|rule/i.test(n),
    );
    expect(
      adjudication,
      `no MCP tool may adjudicate a dispute until the ADR-0007 tier exists; found: ${adjudication.join(", ")}`,
    ).toEqual([]);
  });

  it("still exposes dispute_task — raising a dispute is not the same authority", async () => {
    // D2 splits these deliberately. Either party may RAISE a dispute (and must present a
    // signed failing verdict to do it); neither party may RESOLVE one.
    const tools = await registeredTools();
    expect(tools["dispute_task"]).toBeDefined();
  });

  it("keeps the owner path intact — resolveDisputeOnChain still exists for scripts", async () => {
    // Removing the tool must not remove the capability: the escrow's `resolveDispute` is
    // onlyOwner, and `scripts/admin/verify-escrow-lifecycle.ts` drives it through the KMS
    // signer to prove the CC-059 path works. Deleting this export would break that proof.
    const signer = await import("@/lib/contracts/signer");
    expect(typeof signer.resolveDisputeOnChain).toBe("function");
  });

  it("no longer imports the signer into the MCP server", async () => {
    // A dangling import is how the capability creeps back: the next person wiring a tool
    // finds it already in scope. Asserted on the source rather than at runtime, because an
    // unused import is invisible to the module graph once bundled.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/mcp/server.ts", "utf8");
    expect(src).not.toMatch(/import\s*\{[^}]*resolveDisputeOnChain[^}]*\}/);
  });
});
