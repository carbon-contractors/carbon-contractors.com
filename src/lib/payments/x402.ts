/**
 * x402.ts
 * Task funding preparation for the Carbon Contractors escrow system.
 *
 * CC-081 Defect 1: this module never takes payment, and must never become an x402
 * payment recipient again. An x402 settlement is a bare ERC-20 transfer, so pointing
 * it at the escrow address deposited USDC into a contract with no `createTask` call,
 * no sweep and no rescue — permanently unrecoverable. The agent funds the escrow
 * itself, from its own wallet, via `USDC.approve` + `escrow.createTask`, which is what
 * the contract requires (`agent: msg.sender`). This module's job is to hand the agent
 * every parameter that call needs (v2 ABI, six arguments) and to persist the pending
 * task row the confirmation endpoint later checks against the chain.
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
  /**
   * Seconds after `submitWork` that the agent has to act — v2's second clock
   * (ADR-0001 D1). Bounded by the contract: 12 hours to 14 days.
   */
  review_window_seconds: number;
  /**
   * Parsed acceptance spec. Required since CC-081 Defect 1 — its hash is the
   * `specHash` argument to `createTask`, and a task funded without one would
   * commit to nothing, so it could only ever resolve in the worker's favour.
   */
  spec: ParsedSpec;
  /**
   * CC-094 / ADR-0005 D3: true when the worker holds a notification channel
   * with accepts_auto_booking — the offer auto-accepts and the row is born
   * 'accepted'. False (the default) leaves the row 'pending': an offer that
   * waits for the worker and lapses at expiry if they do not answer.
   */
  auto_accept?: boolean;
  /**
   * When the offer lapses, in seconds from now (ADR-0005 D4). Required unless
   * auto_accept — validated against the 15-minute to 7-day bounds below.
   */
  offer_expiry_seconds?: number;
}

export interface X402PaymentResponse {
  status: "awaiting_funding";
  payment_request_id: string;
  /** Every argument `escrow.createTask` needs, in ABI order plus addresses. */
  task_id_bytes32: string;
  worker: string;
  amount_usdc: number;
  amount_wei: string;
  deadline_unix: number;
  review_window_seconds: number;
  spec_hash: string;
  escrow_contract: string | null;
  chain_id: number;
  base_network: string;
  /** Not a payment URL — the confirmation endpoint the agent POSTs to after funding. */
  fund_url: string;
  /** CC-094: 'accepted' when auto-booked, 'pending' while the worker decides (ADR-0005 D3). */
  worker_status: "accepted" | "pending";
  /** When the pending offer lapses; null when already accepted (ADR-0005 D4). */
  offer_expiry_unix: number | null;
  /** The exact preimage the hash was taken over — echoed so the agent need not trust us. */
  acceptance_spec: string;
  spec_schema_version: number;
  /** Present only when something about the spec needs the agent's attention. */
  spec_warning?: string;
  instructions: string;
  timestamp_unix: number;
}

const USDC_DECIMALS = 6;

/** Mirrors `CarbonEscrow.MIN_REVIEW_WINDOW` — ADR-0001 calls this the incident-response floor. */
export const MIN_REVIEW_WINDOW_SECONDS = 12 * 60 * 60;
/** Mirrors `CarbonEscrow.MAX_REVIEW_WINDOW`. */
export const MAX_REVIEW_WINDOW_SECONDS = 14 * 24 * 60 * 60;

/**
 * ADR-0005 D4: the app-enforced bounds on an agent-set offer expiry. The lower
 * bound stops an offer that is unanswerable in practice being used to claim the
 * worker was unresponsive; the upper bound stops an agent parking a worker's
 * availability indefinitely at no cost — the offer is free, so without a
 * ceiling it is a free option on someone else's time.
 */
export const MIN_OFFER_EXPIRY_SECONDS = 15 * 60;
export const MAX_OFFER_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
/** Conservative default within the bounds — the distribution of real worker response times does not exist yet. */
export const DEFAULT_OFFER_EXPIRY_SECONDS = 24 * 60 * 60;

/**
 * prepareFunding
 * (kept as `initiateX402Payment` for import compatibility with existing call sites)
 *
 * Persists the task to Supabase as "pending" and returns every parameter the agent
 * needs to fund the escrow itself via `USDC.approve` + `escrow.createTask`.
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
  if (
    req.review_window_seconds < MIN_REVIEW_WINDOW_SECONDS ||
    req.review_window_seconds > MAX_REVIEW_WINDOW_SECONDS
  ) {
    throw new Error(
      `review_window_seconds must be between ${MIN_REVIEW_WINDOW_SECONDS} (12h) and ${MAX_REVIEW_WINDOW_SECONDS} (14d)`,
    );
  }

  // CC-094 / ADR-0005 D3+D4: resolve the offer shape before any row is written,
  // so an out-of-bounds expiry fails the whole call rather than creating an
  // offer that can never be honoured.
  const autoAccept = req.auto_accept ?? false;
  const offerExpirySeconds = req.offer_expiry_seconds ?? DEFAULT_OFFER_EXPIRY_SECONDS;
  if (!autoAccept) {
    if (
      offerExpirySeconds < MIN_OFFER_EXPIRY_SECONDS ||
      offerExpirySeconds > MAX_OFFER_EXPIRY_SECONDS
    ) {
      throw new Error(
        `offer_expiry_seconds must be between ${MIN_OFFER_EXPIRY_SECONDS} (15m) and ${MAX_OFFER_EXPIRY_SECONDS} (7d)`,
      );
    }
  }
  const nowUnix = Math.floor(Date.now() / 1000);
  const offerExpiryUnix = autoAccept ? null : nowUnix + offerExpirySeconds;
  const initialStatus: "accepted" | "pending" = autoAccept ? "accepted" : "pending";

  const payment_request_id = randomBytes(16).toString("hex");
  const taskIdBytes32 = toTaskId(payment_request_id);
  const escrowConfig = getEscrowConfig();

  // Convert USDC to wei (6 decimals)
  const amountWei = BigInt(
    Math.round(req.amount_usdc * 10 ** USDC_DECIMALS)
  ).toString();

  // Persist with the offer-stage status (CC-094): 'accepted' when the worker
  // pre-authorised auto-booking, otherwise 'pending' — an offer that waits for
  // them. The row only moves to "active" once the worker has accepted AND the
  // on-chain task is confirmed Funded (see /api/fund-task).
  await createTask({
    payment_request_id,
    from_agent_wallet: req.from_agent_wallet,
    to_human_wallet: req.to_human_wallet,
    task_description: req.task_description,
    amount_usdc: req.amount_usdc,
    deadline_unix: req.deadline_unix,
    tx_hash: "",
    escrow_contract: escrowConfig.address ?? "",
    acceptance_spec: req.spec.preimage,
    spec_hash: req.spec.hash,
    spec_schema_version: req.spec.version,
    status: initialStatus,
    offer_expiry_unix: offerExpiryUnix,
  });

  // CC-009 / ADR-0002 D9: never log the spec itself. It carries GPS coordinates and
  // site references. The hash is a commitment and safe; the preimage is task content.
  log("info", "payment_request_created", {
    payment_request_id,
    task_id_bytes32: taskIdBytes32,
    amount_usdc: req.amount_usdc,
    to_human_wallet: req.to_human_wallet,
    spec_hash: req.spec.hash,
    spec_schema_version: req.spec.version,
    worker_status: initialStatus,
    offer_expiry_unix: offerExpiryUnix,
  });

  const baseUrl = getConfig().NEXT_PUBLIC_BASE_URL;

  // A spec that commits to no criteria is well-formed and allowed, but there is
  // nothing to check, so the task can only resolve in the worker's favour. That is
  // a legitimate choice for a category that does not check — it should never be an
  // accident, so say so rather than swallowing it.
  const specWarning = req.spec.hasNoCriteria
    ? "acceptance_spec declares no criteria. There is nothing to check, so this task can only resolve in the worker's favour (ADR-0001 D6)."
    : undefined;

  return {
    status: "awaiting_funding",
    payment_request_id,
    task_id_bytes32: taskIdBytes32,
    worker: req.to_human_wallet,
    amount_usdc: req.amount_usdc,
    amount_wei: amountWei,
    deadline_unix: req.deadline_unix,
    review_window_seconds: req.review_window_seconds,
    spec_hash: req.spec.hash,
    escrow_contract: escrowConfig.address,
    chain_id: escrowConfig.chainId,
    base_network: escrowConfig.chainName,
    fund_url: `${baseUrl}/api/fund-task`,
    worker_status: initialStatus,
    offer_expiry_unix: offerExpiryUnix,
    acceptance_spec: req.spec.preimage,
    spec_schema_version: req.spec.version,
    ...(specWarning ? { spec_warning: specWarning } : {}),
    instructions: [
      `Fund the escrow from your own wallet on ${escrowConfig.chainName} (chain id ${escrowConfig.chainId}):`,
      ...(autoAccept
        ? []
        : [
            `0. Wait for the worker to accept the offer — the task is '${initialStatus}' until they do`,
            `   (they have until unix ${offerExpiryUnix}). /api/fund-task refuses a task that is not 'accepted'.`,
          ]),
      `1. Approve the escrow to spend your USDC: usdc.approve("${escrowConfig.address}", ${amountWei}).`,
      `2. Create the task: escrow.createTask("${taskIdBytes32}", "${req.to_human_wallet}", ${amountWei}, ${req.deadline_unix}, ${req.review_window_seconds}, "${req.spec.hash}").`,
      `   Verify spec_hash yourself: keccak256 of the UTF-8 bytes of acceptance_spec below.`,
      `3. Confirm: POST { "payment_request_id": "${payment_request_id}" } to /api/fund-task.`,
      `   That endpoint is not a payment endpoint — it reads the chain, checks the task is Funded,`,
      `   and only then moves the task to "active". Until you fund it, nothing is owed.`,
    ].join("\n"),
    timestamp_unix: Math.floor(Date.now() / 1000),
  };
}
