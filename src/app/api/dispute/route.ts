/**
 * route.ts — /api/dispute
 *
 * Records a dispute in the database. CC-092 / ADR-0001 D2: v2 has no
 * bare-assertion dispute — the request must carry a **signed failing verdict**
 * (obtained from POST /api/verdict with passed=false) and its signature, and
 * those are validated here before anything is recorded. Either party to the
 * task (`to_human_wallet` or `from_agent_wallet`) may dispute.
 *
 * This route updates database status only. The caller must also submit
 * `escrow.disputeTask(taskId, verdict, signature)` on-chain from their own
 * wallet to freeze the escrowed funds — the platform is not in that path.
 *
 * Requires wallet challenge-response authentication (CC-004):
 * x-caller-wallet / x-caller-signature / x-caller-nonce headers.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Hex } from "viem";
import { getTaskByPaymentId, updateTaskStatus } from "@/lib/db/tasks";
import { toTaskId } from "@/lib/contracts/escrow";
import {
  verifyPresentedVerdict,
  type SerializedVerdict,
} from "@/lib/contracts/verdict-signer";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";
import { verifyChallengeSignature } from "@/lib/auth/wallet-challenge";
import { isValidWalletAddress } from "@/lib/validation";

const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x-prefixed bytes32");

const BodySchema = z.object({
  payment_request_id: z.string().min(1),
  reason: z.string().min(10).max(500),
  /** Exactly as returned by POST /api/verdict (passed=false). */
  verdict: z.object({
    taskId: bytes32,
    specHash: bytes32,
    evidenceHash: bytes32,
    checkerHash: bytes32,
    passed: z.boolean(),
    breakdownHash: bytes32,
    expiry: z.string(),
    nonce: z.string(),
  }),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "expected a 0x-prefixed 65-byte signature"),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const rawWallet = request.headers.get("x-caller-wallet");
    const authSignature = request.headers.get("x-caller-signature") as Hex | null;
    const nonce = request.headers.get("x-caller-nonce");

    if (!rawWallet || !isValidWalletAddress(rawWallet) || !authSignature || !nonce) {
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
      callerWallet = await verifyChallengeSignature(rawWallet, authSignature, nonce);
    } catch (err) {
      log("warn", "dispute_auth_failed", {
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
        {
          ok: false,
          error:
            "Invalid request. A dispute must carry a signed failing verdict (verdict + signature from /api/verdict) — a bare assertion cannot be recorded.",
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }
    const { payment_request_id, reason, verdict, signature } = parsed.data;

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

    // ADR-0001 D2: either party may dispute.
    if (!isWorker && !isAgent) {
      log("warn", "dispute_unauthorized", {
        payment_request_id,
        caller: callerWallet,
        assigned_worker: task.to_human_wallet,
        hiring_agent: task.from_agent_wallet,
      });
      return NextResponse.json(
        { ok: false, error: "Not authorized. Caller is not a party to this task." },
        { status: 403 },
      );
    }

    if (task.status !== "active" && task.status !== "pending") {
      return NextResponse.json(
        { ok: false, error: `Task is ${task.status}, cannot dispute` },
        { status: 409 },
      );
    }

    // Validate the verdict before recording anything: it must be failing,
    // unexpired, name this task, and recover to the platform verdict signer.
    const verdictCheck = await verifyPresentedVerdict({
      paymentRequestId: payment_request_id,
      serialized: verdict as SerializedVerdict,
      signature: signature as Hex,
      requirePassing: false,
    });
    if (!verdictCheck.ok) {
      log("warn", "dispute_verdict_rejected", {
        payment_request_id,
        caller: callerWallet,
        reason: verdictCheck.reason,
      });
      return NextResponse.json(
        { ok: false, error: `Verdict refused: ${verdictCheck.reason}` },
        { status: 400 },
      );
    }

    await updateTaskStatus(payment_request_id, "disputed");

    log("info", "task_disputed_dashboard", {
      payment_request_id,
      reason,
      amount_usdc: task.amount_usdc,
      caller: callerWallet,
      verdictDigest: verdictCheck.digest,
    });

    return NextResponse.json({
      ok: true,
      payment_request_id,
      status: "disputed",
      task_id_bytes32: toTaskId(payment_request_id),
      verdict_digest: verdictCheck.digest,
    });
  } catch (err: unknown) {
    return safeErrorResponse(err, "dispute_failed");
  }
}
