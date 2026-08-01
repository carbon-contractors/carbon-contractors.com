/**
 * route.ts — /api/dispute
 *
 * REST endpoint for workers to initiate task disputes from the dashboard.
 * Updates database status only — the worker must also call
 * escrow.disputeTask() on-chain via their connected wallet.
 *
 * Requires the same wallet challenge-response signature as the MCP transport
 * (CC-004): the caller must prove ownership of the wallet assigned to the
 * task as `to_human_wallet`. Get a nonce from
 * POST /api/basedhuman.mcp/challenge, sign the returned message, and send
 * the result as x-caller-wallet / x-caller-signature / x-caller-nonce headers.
 */

import { NextRequest, NextResponse } from "next/server";
import { getTaskByPaymentId, updateTaskStatus } from "@/lib/db/tasks";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";
import { verifyChallengeSignature } from "@/lib/auth/wallet-challenge";
import { isValidWalletAddress } from "@/lib/validation";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const rawWallet = request.headers.get("x-caller-wallet");
    const signature = request.headers.get("x-caller-signature") as `0x${string}` | null;
    const nonce = request.headers.get("x-caller-nonce");

    if (!rawWallet || !isValidWalletAddress(rawWallet) || !signature || !nonce) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Wallet signature required. Get a nonce from /api/basedhuman.mcp/challenge, sign it, and retry with x-caller-wallet/x-caller-signature/x-caller-nonce headers.",
        },
        { status: 401 }
      );
    }

    let callerWallet: string;
    try {
      callerWallet = await verifyChallengeSignature(rawWallet, signature, nonce);
    } catch (err) {
      log("warn", "dispute_auth_failed", {
        wallet: rawWallet,
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        { ok: false, error: "Signature verification failed" },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { payment_request_id } = body as { payment_request_id: string };

    if (!payment_request_id) {
      return NextResponse.json(
        { ok: false, error: "payment_request_id required" },
        { status: 400 }
      );
    }

    const task = await getTaskByPaymentId(payment_request_id);
    if (!task) {
      return NextResponse.json(
        { ok: false, error: "Task not found" },
        { status: 404 }
      );
    }

    if (task.to_human_wallet.toLowerCase() !== callerWallet.toLowerCase()) {
      log("warn", "dispute_unauthorized", {
        payment_request_id,
        caller: callerWallet,
        assigned_worker: task.to_human_wallet,
      });
      return NextResponse.json(
        { ok: false, error: "Not authorized. Only the assigned worker may dispute this task." },
        { status: 403 }
      );
    }

    if (task.status !== "active" && task.status !== "pending") {
      return NextResponse.json(
        { ok: false, error: `Task is ${task.status}, cannot dispute` },
        { status: 409 }
      );
    }

    await updateTaskStatus(payment_request_id, "disputed");

    log("info", "task_disputed_dashboard", {
      payment_request_id,
      amount_usdc: task.amount_usdc,
      worker: task.to_human_wallet,
    });

    return NextResponse.json({
      ok: true,
      payment_request_id,
      status: "disputed",
    });
  } catch (err: unknown) {
    return safeErrorResponse(err, "dispute_failed");
  }
}
