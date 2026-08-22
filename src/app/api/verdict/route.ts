/**
 * route.ts — POST /api/verdict (CC-092)
 *
 * Computes and signs a verdict for a task, against a caller-supplied evidence
 * bundle. Authenticated the same way as /api/tasks (CC-093) and /api/dispute — the
 * challenge-response signature (x-caller-wallet / x-caller-signature /
 * x-caller-nonce headers, nonce from POST /api/basedhuman.mcp/challenge) — because
 * the acceptance spec this reads can carry GPS coordinates and site references
 * (CLAUDE.md's reasoning for keeping it out of tasks_public), and it should only be
 * reachable by the task's own worker or hiring agent, matching the on-chain
 * NotParty posture of disputeTask/claimWithVerdict.
 *
 * Stateless (CC-092 design note 1): the request body carries the evidence bundle
 * every time. Nothing here writes it anywhere.
 */

import { NextRequest, NextResponse } from "next/server";
import { getTaskByPaymentId } from "@/lib/db/tasks";
import { verifyChallengeSignature } from "@/lib/auth/wallet-challenge";
import { isValidWalletAddress } from "@/lib/validation";
import { computeAndSignVerdict, VerdictInputError } from "@/lib/contracts/verdict-service";
import { serializeVerdict } from "@/lib/contracts/verdict-json";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";

export async function POST(request: NextRequest): Promise<NextResponse> {
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

  try {
    const body = await request.json();
    const { payment_request_id, evidence_bundle } = body as {
      payment_request_id?: string;
      evidence_bundle?: string;
    };

    if (!payment_request_id || typeof evidence_bundle !== "string") {
      return NextResponse.json(
        { ok: false, error: "payment_request_id and evidence_bundle (a JSON string) are required" },
        { status: 400 },
      );
    }

    const task = await getTaskByPaymentId(payment_request_id);
    if (!task) {
      return NextResponse.json({ ok: false, error: "Task not found" }, { status: 404 });
    }

    const isParty =
      task.to_human_wallet.toLowerCase() === callerWallet.toLowerCase() ||
      task.from_agent_wallet.toLowerCase() === callerWallet.toLowerCase();
    if (!isParty) {
      // Matches disputeTask's on-chain NotParty — a verdict is not public even
      // though the parties themselves are (CC-093's precedent for this task).
      return NextResponse.json(
        { ok: false, error: "Caller is not a party to this task" },
        { status: 403 },
      );
    }

    const { verdict, signature: verdictSignature, checks } = await computeAndSignVerdict(
      task,
      evidence_bundle,
    );

    log("info", "verdict_computed", {
      payment_request_id,
      caller: callerWallet,
      passed: verdict.passed,
    });

    return NextResponse.json({
      ok: true,
      verdict: serializeVerdict(verdict),
      signature: verdictSignature,
      checks,
    });
  } catch (err: unknown) {
    if (err instanceof VerdictInputError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 409 });
    }
    return safeErrorResponse(err, "verdict_computation_failed");
  }
}
