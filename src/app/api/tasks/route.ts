/**
 * route.ts — /api/tasks (GET)
 *
 * CC-093: task_description is only served to a caller who proves ownership of
 * a party's wallet, via the same challenge-response signature as /api/dispute
 * and the MCP transport (x-caller-wallet / x-caller-signature / x-caller-nonce
 * headers, nonce from POST /api/basedhuman.mcp/challenge).
 *
 * - Signed caller W receives full task records where to_human_wallet == W or
 *   from_agent_wallet == W. The verified wallet IS the query — ?wallet= is
 *   ignored on this path so the two can never disagree.
 * - Unsigned callers receive the tasks_public projection (migration 011), which
 *   excludes task_description. Asking for ?wallet= without a signature is a
 *   401: there is no legitimate wallet-scoped read without proving ownership.
 */

import { NextRequest } from "next/server";
import {
  getTasksForParties,
  getPublicTasks,
  lapseExpiredOffers,
  type TaskRecord,
  type PublicTaskRecord,
} from "@/lib/db/tasks";
import { getOnChainTask, getEscrowConfig } from "@/lib/contracts/escrow";
import { verifyChallengeSignature } from "@/lib/auth/wallet-challenge";
import { sessionWalletFromRequest } from "@/lib/auth/session";
import { isValidWalletAddress } from "@/lib/validation";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";

export async function GET(req: NextRequest) {
  const rawWallet = req.headers.get("x-caller-wallet");
  const signature = req.headers.get("x-caller-signature") as `0x${string}` | null;
  const nonce = req.headers.get("x-caller-nonce");
  const hasAuthHeaders = Boolean(rawWallet || signature || nonce);

  try {
    // CC-094: lapse expired offers inline on fetch, so no list ever shows a
    // dead offer as live. Best-effort — a failure here must not fail the read.
    await lapseExpiredOffers();

    let tasks: (TaskRecord | PublicTaskRecord)[];
    let authenticated = false;
    let callerWallet: string | null = null;

    // ADR-0009: a valid session (cookie or bearer) authenticates without a
    // prompt. Machine callers keep the challenge path (ADR-0009 D6).
    const sessionWallet = await sessionWalletFromRequest(req);
    if (sessionWallet) {
      callerWallet = sessionWallet;
    }

    if (!callerWallet && hasAuthHeaders) {
      if (!rawWallet || !isValidWalletAddress(rawWallet) || !signature || !nonce) {
        return Response.json(
          {
            ok: false,
            error:
              "Wallet signature required. Get a nonce from /api/basedhuman.mcp/challenge, sign it, and retry with x-caller-wallet/x-caller-signature/x-caller-nonce headers.",
          },
          { status: 401 },
        );
      }

      try {
        callerWallet = await verifyChallengeSignature(rawWallet, signature, nonce);
      } catch (err) {
        log("warn", "tasks_auth_failed", {
          wallet: rawWallet,
          error: err instanceof Error ? err.message : String(err),
        });
        return Response.json(
          { ok: false, error: "Signature verification failed" },
          { status: 401 },
        );
      }

    }

    if (callerWallet) {
      tasks = await getTasksForParties(callerWallet);
      authenticated = true;
      log("info", "tasks_fetched", {
        wallet: callerWallet,
        count: tasks.length,
        authenticated: true,
      });
    } else if (req.nextUrl.searchParams.get("wallet")) {
      return Response.json(
        {
          ok: false,
          error:
            "Wallet-scoped task reads require a wallet signature. Get a nonce from /api/basedhuman.mcp/challenge, sign it, and retry with x-caller-wallet/x-caller-signature/x-caller-nonce headers.",
        },
        { status: 401 },
      );
    } else {
      tasks = await getPublicTasks();
      log("info", "tasks_fetched", { count: tasks.length, authenticated: false });
    }

    // Enrich with on-chain state where possible
    const escrowConfig = getEscrowConfig();
    const enriched = await Promise.all(
      tasks.map(async (task) => {
        let onChain = null;
        if (escrowConfig.address && task.payment_request_id) {
          try {
            const onChainTask = await getOnChainTask(task.payment_request_id);
            // CC-092: the full v2 projection, so the dashboard can drive the
            // write paths without another read — specHash is the specVersionAck
            // submitWork echoes, reviewDeadline gates releaseAfterReview, and
            // verdictHash/verdictPassed say whether a verdict was already
            // presented. BigInts become strings (amount_wei) or numbers
            // (timestamps, uint64/uint32 — safe as JS numbers).
            onChain = {
              state: onChainTask.state,
              amount_wei: onChainTask.amount.toString(),
              deadline: Number(onChainTask.deadline),
              reviewWindow: onChainTask.reviewWindow,
              submittedAt: Number(onChainTask.submittedAt),
              reviewDeadline: Number(onChainTask.reviewDeadline),
              // ADR-0006 D3. arbitrationClock says whether the DEPLOYED contract has
              // the clock at all — the dashboard needs it to decide whether the timeout
              // claim exists, because offering a button for a function the deployment
              // does not have reverts and reads to a worker as being refused.
              disputedAt: Number(onChainTask.disputedAt),
              arbitrationDeadline: Number(onChainTask.arbitrationDeadline),
              arbitrationClock: onChainTask.arbitrationClock,
              specHash: onChainTask.specHash,
              evidenceHash: onChainTask.evidenceHash,
              verdictHash: onChainTask.verdictHash,
              verdictPassed: onChainTask.verdictPassed,
              worker: onChainTask.worker,
              agent: onChainTask.agent,
            };
          } catch {
            onChain = null;
          }
        }
        return { ...task, on_chain: onChain };
      }),
    );

    return Response.json({ ok: true, authenticated, tasks: enriched });
  } catch (err: unknown) {
    return safeErrorResponse(err, "tasks_fetch_failed");
  }
}
