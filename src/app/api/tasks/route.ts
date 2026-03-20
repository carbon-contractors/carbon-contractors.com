/**
 * route.ts — /api/tasks (GET)
 * Returns tasks assigned to a wallet address.
 * Optionally enriches with on-chain escrow state.
 */

import { NextRequest } from "next/server";
import { getTasksByWallet } from "@/lib/db/tasks";
import { getOnChainTask, getEscrowConfig } from "@/lib/contracts/escrow";
import { safeErrorResponse } from "@/lib/errors";

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet");

  if (!wallet || !WALLET_RE.test(wallet)) {
    return Response.json(
      { error: "Missing or invalid wallet parameter (0x + 40 hex chars)" },
      { status: 400 },
    );
  }

  try {
    const tasks = await getTasksByWallet(wallet);

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

    log("info", "tasks_fetched", { wallet, count: enriched.length });

    return Response.json({ ok: true, tasks: enriched });
  } catch (err: unknown) {
    return safeErrorResponse(err, "tasks_fetch_failed", { wallet });
  }
}
