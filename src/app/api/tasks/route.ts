/**
 * route.ts — /api/tasks (GET)
 *
 * Returns tasks for an authenticated party (worker or hiring agent).
 * Unauthenticated requests can only receive the public feed (tasks_public),
 * which strictly omits task_description and acceptance_spec (CC-093, migration 011).
 *
 * Authentication uses challenge-response wallet signatures:
 *   x-caller-wallet, x-caller-signature, x-caller-nonce
 */

import { NextRequest, NextResponse } from "next/server";
import { getTasksForParty, getPublicTasks } from "@/lib/db/tasks";
import { getOnChainTask, getEscrowConfig } from "@/lib/contracts/escrow";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";
import { verifyChallengeSignature } from "@/lib/auth/wallet-challenge";
import { isValidWalletAddress } from "@/lib/validation";

export async function GET(req: NextRequest): Promise<Response> {
  const rawWallet = req.headers.get("x-caller-wallet");
  const signature = req.headers.get("x-caller-signature") as `0x${string}` | null;
  const nonce = req.headers.get("x-caller-nonce");
  const queryWallet = req.nextUrl.searchParams.get("wallet");

  // If caller provided challenge-response headers, authenticate them
  if (rawWallet || signature || nonce) {
    if (!rawWallet || !isValidWalletAddress(rawWallet) || !signature || !nonce) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Invalid authentication headers. Expected x-caller-wallet, x-caller-signature, and x-caller-nonce.",
        },
        { status: 401 },
      );
    }

    let callerWallet: string;
    try {
      callerWallet = await verifyChallengeSignature(rawWallet, signature, nonce);
    } catch (err) {
      log("warn", "tasks_auth_failed", {
        wallet: rawWallet,
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        { ok: false, error: "Signature verification failed" },
        { status: 401 },
      );
    }

    try {
      const tasks = await getTasksForParty(callerWallet);

      // Enrich with on-chain state where possible
      const escrowConfig = getEscrowConfig();
      const enriched = await Promise.all(
        tasks.map(async (task) => {
          let onChain = null;
          if (escrowConfig.address && task.payment_request_id) {
            try {
              const onChainTask = await getOnChainTask(task.payment_request_id);
              onChain = {
                state: onChainTask.state,
                amount_wei: onChainTask.amount.toString(),
                deadline: Number(onChainTask.deadline),
              };
            } catch {
              onChain = null;
            }
          }
          return { ...task, on_chain: onChain };
        }),
      );

      log("info", "tasks_fetched_authenticated", {
        wallet: callerWallet,
        count: enriched.length,
      });

      return NextResponse.json({
        ok: true,
        authenticated: true,
        wallet: callerWallet,
        tasks: enriched,
      });
    } catch (err: unknown) {
      return safeErrorResponse(err, "tasks_fetch_failed", { wallet: callerWallet });
    }
  }

  // If unauthenticated caller tries to query tasks for a specific wallet:
  if (queryWallet) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Authentication required. Task descriptions and acceptance specs are private. Authenticate via wallet challenge signature headers (CC-093).",
      },
      { status: 401 },
    );
  }

  // Unauthenticated generic GET /api/tasks returns the public projection
  try {
    const publicTasks = await getPublicTasks();
    log("info", "tasks_fetched_public", { count: publicTasks.length });
    return NextResponse.json({
      ok: true,
      authenticated: false,
      tasks: publicTasks,
    });
  } catch (err: unknown) {
    return safeErrorResponse(err, "tasks_public_fetch_failed");
  }
}
