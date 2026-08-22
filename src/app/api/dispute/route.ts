/**
 * route.ts — /api/dispute
 *
 * CC-092 / ADR-0001 D2: rewritten for CarbonEscrow v2. Two changes from the
 * pre-v2 route, and they go together:
 *
 * 1. **Either party may dispute** (`to_human_wallet` or `from_agent_wallet`),
 *    matching the contract's on-chain `NotParty` grant — the app-layer half of
 *    CC-081 Defect 2.
 * 2. **A dispute requires a signed failing verdict.** v2's `disputeTask`
 *    accepts nothing else — there is no bare-assertion dispute, because one
 *    would hand the agent both outcomes. So this route either computes a
 *    verdict from a caller-supplied evidence bundle (via the same
 *    `computeAndSignVerdict` /api/verdict uses) or accepts that the task is
 *    already `Disputed` on-chain; anything else is refused before it reaches
 *    the chain.
 *
 * Like every other write here, the platform transacts nowhere: the caller
 * receives the signed verdict tuple and presents `disputeTask(taskId, verdict,
 * signature)` from their own wallet (ADR-0001 Amendment 1 A1.1).
 *
 * Auth is the same wallet challenge-response signature as the MCP transport
 * (CC-004): prove ownership of a party wallet via
 * POST /api/basedhuman.mcp/challenge, then send the result as
 * x-caller-wallet / x-caller-signature / x-caller-nonce headers.
 */

import { NextRequest, NextResponse } from "next/server";
import { getTaskByPaymentId, updateTaskStatus } from "@/lib/db/tasks";
import { getOnChainTask, getEscrowConfig, toTaskId } from "@/lib/contracts/escrow";
import { computeAndSignVerdict, VerdictInputError } from "@/lib/contracts/verdict-service";
import { serializeVerdict } from "@/lib/contracts/verdict-json";
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
    const { payment_request_id, evidence_bundle } = body as {
      payment_request_id?: string;
      evidence_bundle?: string;
    };

    if (!payment_request_id) {
      return NextResponse.json(
        { ok: false, error: "payment_request_id required" },
        { status: 400 }
      );
    }
    if (evidence_bundle !== undefined && typeof evidence_bundle !== "string") {
      return NextResponse.json(
        { ok: false, error: "evidence_bundle, when supplied, must be a JSON string" },
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

    // ADR-0001 D2: either party may dispute — control over release (the agent's
    // completeTask) is not authority over adjudication.
    const callerIsWorker = task.to_human_wallet.toLowerCase() === callerWallet.toLowerCase();
    const callerIsAgent = task.from_agent_wallet.toLowerCase() === callerWallet.toLowerCase();
    if (!callerIsWorker && !callerIsAgent) {
      log("warn", "dispute_unauthorized", {
        payment_request_id,
        caller: callerWallet,
        worker: task.to_human_wallet,
        agent: task.from_agent_wallet,
      });
      return NextResponse.json(
        { ok: false, error: "Not authorized. Only a party to this task (worker or hiring agent) may dispute it." },
        { status: 403 }
      );
    }

    if (task.status !== "active" && task.status !== "pending" && task.status !== "disputed") {
      return NextResponse.json(
        { ok: false, error: `Task is ${task.status}, cannot dispute` },
        { status: 409 }
      );
    }

    const taskIdBytes32 = toTaskId(payment_request_id);
    const escrowConfig = getEscrowConfig();

    // Path A — the caller supplies the evidence bundle, so this route can obtain
    // the signed failing verdict the contract requires. A passing verdict is a
    // reason NOT to dispute, not a stronger dispute.
    if (evidence_bundle !== undefined) {
      let computed;
      try {
        computed = await computeAndSignVerdict(task, evidence_bundle);
      } catch (err) {
        if (err instanceof VerdictInputError) {
          return NextResponse.json({ ok: false, error: err.message }, { status: 409 });
        }
        return safeErrorResponse(err, "dispute_verdict_failed");
      }

      if (computed.verdict.passed) {
        return NextResponse.json(
          {
            ok: false,
            error: "Cannot dispute: verdict passed. The evidence satisfies the committed acceptance spec.",
            verdict: serializeVerdict(computed.verdict),
            checks: computed.checks,
          },
          { status: 400 }
        );
      }

      if (task.status !== "disputed") {
        await updateTaskStatus(payment_request_id, "disputed");
      }

      log("info", "task_disputed_with_verdict", {
        payment_request_id,
        amount_usdc: task.amount_usdc,
        caller: callerWallet,
        caller_role: callerIsWorker ? "worker" : "agent",
      });

      return NextResponse.json({
        ok: true,
        payment_request_id,
        status: "disputed",
        task_id_bytes32: taskIdBytes32,
        escrow_contract: escrowConfig.address,
        verdict: serializeVerdict(computed.verdict),
        signature: computed.signature,
        checks: computed.checks,
        on_chain_submitted: false,
        note: "Present the verdict on-chain from your own wallet: escrow.disputeTask(taskId, verdict, signature). This must land before the review window closes.",
      });
    }

    // Path B — no evidence bundle. The only dispute this route can record
    // without one is one that already happened on-chain.
    let onChainState: string | null = null;
    if (escrowConfig.address) {
      try {
        onChainState = (await getOnChainTask(payment_request_id)).state;
      } catch {
        onChainState = null;
      }
    }

    if (onChainState === "Disputed" || onChainState === "Arbitrating" || onChainState === "Resolved") {
      if (task.status !== "disputed") {
        await updateTaskStatus(payment_request_id, "disputed");
      }
      log("info", "task_dispute_recorded_from_chain", {
        payment_request_id,
        onChainState,
        caller: callerWallet,
      });
      return NextResponse.json({
        ok: true,
        payment_request_id,
        status: "disputed",
        task_id_bytes32: taskIdBytes32,
        escrow_contract: escrowConfig.address,
        on_chain_state: onChainState,
        on_chain_submitted: true,
        note: "The dispute is already on-chain; the database now reflects it.",
      });
    }

    return NextResponse.json(
      {
        ok: false,
        error:
          "A dispute requires a signed failing verdict — supply the task's evidence bundle as evidence_bundle (a JSON string) so one can be computed. On-chain state is " +
          (onChainState ?? "unreadable") +
          ", so there is no existing dispute to record.",
      },
      { status: 400 }
    );
  } catch (err: unknown) {
    return safeErrorResponse(err, "dispute_failed");
  }
}
