/**
 * x402.ts
 * x402 payment request handler for the Carbon Contractors escrow system.
 *
 * Phase 3: Returns escrow contract details + on-chain task ID so the agent
 * can fund the escrow via USDC approve + createTask on-chain. The platform
 * tracks the task in Supabase alongside the on-chain state.
 */

import { randomBytes } from "crypto";
import { createTask } from "@/lib/db/tasks";
import { log } from "@/lib/logging";
import { toTaskId, getEscrowConfig } from "@/lib/contracts/escrow";
import { getConfig } from "@/lib/config";
import { isValidWalletAddress } from "@/lib/validation";
import type { ParsedSpec } from "@/lib/spec/hash";

export interface X402PaymentRequest {
  from_agent_wallet: string;
  to_human_wallet: string;
  task_description: string;
  amount_usdc: number;
  deadline_unix: number;
  /** Parsed acceptance spec, or null when the agent supplied none (CC-084). */
  spec?: ParsedSpec | null;
}

export interface X402PaymentResponse {
  status: "awaiting_funding";
  payment_request_id: string;
  task_id_bytes32: string;
  escrow_contract: string | null;
  amount_usdc: number;
  amount_wei: string;
  chain_id: number;
  base_network: string;
  fund_url: string;
  /**
   * Pass verbatim as `specHash` to `createTask`. Null when no spec was supplied.
   * Verify it yourself: keccak256 of the UTF-8 bytes of `acceptance_spec` below.
   */
  spec_hash: string | null;
  /** The exact preimage the hash was taken over — echoed so the agent need not trust us. */
  acceptance_spec: string | null;
  spec_schema_version: number | null;
  /** Present only when something about the spec needs the agent's attention. */
  spec_warning?: string;
  instructions: string;
  timestamp_unix: number;
}

const USDC_DECIMALS = 6;

/**
 * initiateX402Payment
 * Creates a payment request and persists the task to Supabase.
 * Returns the on-chain task ID and escrow address so the agent
 * can fund it via USDC.approve() + escrow.createTask().
 */
export async function initiateX402Payment(
  req: X402PaymentRequest
): Promise<X402PaymentResponse> {
  if (req.amount_usdc <= 0) {
    throw new Error("amount_usdc must be > 0");
  }
  if (!isValidWalletAddress(req.from_agent_wallet)) {
    throw new Error("from_agent_wallet must be a valid 0x address (40 hex chars)");
  }
  if (!isValidWalletAddress(req.to_human_wallet)) {
    throw new Error("to_human_wallet must be a valid 0x address (40 hex chars)");
  }

  const payment_request_id = randomBytes(16).toString("hex");
  const taskIdBytes32 = toTaskId(payment_request_id);
  const escrowConfig = getEscrowConfig();

  // Convert USDC to wei (6 decimals)
  const amountWei = BigInt(
    Math.round(req.amount_usdc * 10 ** USDC_DECIMALS)
  ).toString();

  // Persist to database with "pending" status — will move to "active"
  // once on-chain funding is confirmed.
  await createTask({
    payment_request_id,
    from_agent_wallet: req.from_agent_wallet,
    to_human_wallet: req.to_human_wallet,
    task_description: req.task_description,
    amount_usdc: req.amount_usdc,
    deadline_unix: req.deadline_unix,
    tx_hash: "",
    escrow_contract: escrowConfig.address ?? "",
    acceptance_spec: req.spec?.preimage ?? null,
    spec_hash: req.spec?.hash ?? null,
    spec_schema_version: req.spec?.version ?? null,
  });

  // CC-009 / ADR-0002 D9: never log the spec itself. It carries GPS coordinates and
  // site references. The hash is a commitment and safe; the preimage is task content.
  log("info", "payment_request_created", {
    payment_request_id,
    task_id_bytes32: taskIdBytes32,
    amount_usdc: req.amount_usdc,
    to_human_wallet: req.to_human_wallet,
    spec_hash: req.spec?.hash ?? null,
    spec_schema_version: req.spec?.version ?? null,
  });

  const baseUrl = getConfig().NEXT_PUBLIC_BASE_URL;

  // ADR-0001: a dispute requires a signed FAILING verdict, and there is nothing to
  // fail against without machine-checkable criteria. A task with none therefore always
  // resolves to the worker. That is a legitimate choice for a category that does not
  // check — it should never be an accident, so say so rather than swallowing it.
  const specWarning = !req.spec
    ? "No acceptance_spec supplied. There is nothing to check, so this task can only resolve in the worker's favour — a dispute requires a signed failing verdict (ADR-0001 D6)."
    : req.spec.hasNoCriteria
      ? "acceptance_spec declares no criteria. There is nothing to check, so this task can only resolve in the worker's favour (ADR-0001 D6)."
      : undefined;

  return {
    status: "awaiting_funding",
    payment_request_id,
    task_id_bytes32: taskIdBytes32,
    escrow_contract: escrowConfig.address,
    amount_usdc: req.amount_usdc,
    amount_wei: amountWei,
    chain_id: escrowConfig.chainId,
    base_network: escrowConfig.chainName,
    fund_url: `${baseUrl}/api/fund-task`,
    spec_hash: req.spec?.hash ?? null,
    acceptance_spec: req.spec?.preimage ?? null,
    spec_schema_version: req.spec?.version ?? null,
    ...(specWarning ? { spec_warning: specWarning } : {}),
    instructions: [
      `1. POST to /api/fund-task with { "payment_request_id": "${payment_request_id}" }`,
      `   The endpoint is x402-protected — your HTTP client must support x402 auto-payment.`,
      `   Use @x402/fetch wrapFetchWithPayment() to handle 402 responses automatically.`,
      `2. The facilitator will verify ${req.amount_usdc} USDC payment on ${escrowConfig.chainName}.`,
      `3. On success, task moves to "active" and the worker is notified.`,
    ].join("\n"),
    timestamp_unix: Math.floor(Date.now() / 1000),
  };
}
