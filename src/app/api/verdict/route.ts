/**
 * route.ts — /api/verdict
 *
 * REST surface of the verdict service (CC-092). Either party — the worker
 * (`to_human_wallet`) or the hiring agent (`from_agent_wallet`) — may request an
 * EIP-712 signed verdict:
 *
 *   - a worker presents a **passing** verdict to `escrow.claimWithVerdict` to be
 *     paid without waiting out the review window;
 *   - either party presents a **failing** verdict to `escrow.disputeTask`.
 *
 * The verdict's spec/evidence commitments are bound from the chain by
 * `issueSignedVerdictForTask`, not from this request's body.
 *
 * Requires wallet challenge-response authentication (CC-004/CC-093):
 * x-caller-wallet / x-caller-signature / x-caller-nonce headers.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Hex } from "viem";
import { getTaskByPaymentId } from "@/lib/db/tasks";
import { toTaskId } from "@/lib/contracts/escrow";
import {
  issueSignedVerdictForTask,
  VerdictServiceError,
  VERDICT_SERVICE_ERRORS,
} from "@/lib/contracts/verdict-service";
import { serializeVerdict } from "@/lib/contracts/verdict-signer";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";
import { verifyChallengeSignature } from "@/lib/auth/wallet-challenge";
import { isValidWalletAddress } from "@/lib/validation";

const BodySchema = z.object({
  payment_request_id: z.string().min(1),
  /** True for a passing verdict (claim), false for a failing one (dispute). */
  passed: z.boolean().default(true),
  /** Required when passed is false — becomes the verdict's breakdownHash. */
  failure_reason: z.string().max(1000).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const rawWallet = request.headers.get("x-caller-wallet");
    const signature = request.headers.get("x-caller-signature") as Hex | null;
    const nonce = request.headers.get("x-caller-nonce");

    if (!rawWallet || !isValidWalletAddress(rawWallet) || !signature || !nonce) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Wallet signature required. Get a nonce from /api/basedhuman.mcp/challenge, sign it, and retry with x-caller-wallet/x-caller-signature/x-caller-nonce headers.",
        },
        { status: 401 },
      );
    }

    let callerWallet: string;
    try {
      callerWallet = await verifyChallengeSignature(rawWallet, signature, nonce);
    } catch (err) {
      log("warn", "verdict_auth_failed", {
        wallet: rawWallet,
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        { ok: false, error: "Signature verification failed" },
        { status: 401 },
      );
    }

    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "Invalid body", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const { payment_request_id, passed, failure_reason } = parsed.data;

    const task = await getTaskByPaymentId(payment_request_id);
    if (!task) {
      return NextResponse.json(
        { ok: false, error: "Task not found" },
        { status: 404 },
      );
    }

    const normalizedCaller = callerWallet.toLowerCase();
    const isWorker = task.to_human_wallet.toLowerCase() === normalizedCaller;
    const isAgent = task.from_agent_wallet.toLowerCase() === normalizedCaller;

    if (!isWorker && !isAgent) {
      log("warn", "verdict_unauthorized", {
        payment_request_id,
        caller: callerWallet,
        worker: task.to_human_wallet,
        agent: task.from_agent_wallet,
      });
      return NextResponse.json(
        { ok: false, error: "Not authorized. Caller is not a party to this task." },
        { status: 403 },
      );
    }

    const signed = await issueSignedVerdictForTask({
      paymentRequestId: payment_request_id,
      passed,
      failureReason: failure_reason,
    });

    return NextResponse.json({
      ok: true,
      payment_request_id,
      taskId: toTaskId(payment_request_id),
      verdict: serializeVerdict(signed.verdict),
      digest: signed.digest,
      signature: signed.signature,
      signer: signed.signer,
    });
  } catch (err: unknown) {
    if (err instanceof VerdictServiceError) {
      const status =
        err.code === VERDICT_SERVICE_ERRORS.TASK_NOT_FOUND
          ? 404
          : err.code === VERDICT_SERVICE_ERRORS.MISSING_FAILURE_REASON
            ? 400
            : 409; // not_delivered, chain_unavailable
      return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status });
    }
    return safeErrorResponse(err, "verdict_request_failed");
  }
}
