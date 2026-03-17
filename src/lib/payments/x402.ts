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

export interface X402PaymentRequest {
  from_agent_wallet: string;
  to_human_wallet: string;
  task_description: string;
  amount_usdc: number;
  deadline_unix: number;
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
  if (!req.from_agent_wallet.startsWith("0x")) {
    throw new Error("from_agent_wallet must be a valid 0x address");
  }
  if (!req.to_human_wallet.startsWith("0x")) {
    throw new Error("to_human_wallet must be a valid 0x address");
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
  });

  log("info", "payment_request_created", {
    payment_request_id,
    task_id_bytes32: taskIdBytes32,
    amount_usdc: req.amount_usdc,
    to_human_wallet: req.to_human_wallet,
  });

  return {
    status: "awaiting_funding",
    payment_request_id,
    task_id_bytes32: taskIdBytes32,
    escrow_contract: escrowConfig.address,
    amount_usdc: req.amount_usdc,
    amount_wei: amountWei,
    chain_id: escrowConfig.chainId,
    base_network: escrowConfig.chainName,
    instructions: [
      `1. Approve USDC spend: usdc.approve(${escrowConfig.address}, ${amountWei})`,
      `2. Fund escrow: escrow.createTask(${taskIdBytes32}, ${req.to_human_wallet}, ${amountWei}, ${req.deadline_unix})`,
      `3. Task will move to "active" once funding tx is confirmed.`,
    ].join("\n"),
    timestamp_unix: Math.floor(Date.now() / 1000),
  };
}
