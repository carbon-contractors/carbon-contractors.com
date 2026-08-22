/**
 * route.ts — /api/fund-task
 *
 * Confirmation endpoint for task funding — **not a payment endpoint** (CC-081 Defect 1).
 *
 * This route used to be an x402 payment recipient. An x402 settlement is a bare
 * ERC-20 transfer, so paying it deposited USDC straight into CarbonEscrow without
 * calling `createTask` — and the contract has no `receive`, sweep, rescue or
 * owner-withdraw, so that money was permanently unrecoverable by anyone, including
 * the owner. The platform would then have flipped the DB to `active` for a task that
 * did not exist on-chain.
 *
 * Flow now:
 *   1. Agent calls request_human_work MCP tool → gets payment_request_id plus every
 *      parameter `escrow.createTask` needs (v2 ABI: taskId, worker, amount, deadline,
 *      reviewWindow, specHash)
 *   2. Agent funds the escrow itself, from its own wallet, via
 *      `USDC.approve` + `escrow.createTask` — `createTask` records `msg.sender` as the
 *      agent, which is what the contract requires
 *   3. Agent POSTs here with { payment_request_id }
 *   4. This endpoint reads `getTask(taskId)` from the chain and only moves the DB to
 *      "active" once the on-chain task is `Funded` and matches the row (worker,
 *      amount). The chain is the authority on money; the DB is a projection (Defect 3).
 *
 * Unauthenticated by design: the on-chain read is the gate. Flipping a row to
 * `active` early changes nothing about the money — the caller cannot make the
 * contract say `Funded` without actually funding it.
 */

import { NextRequest, NextResponse } from "next/server";
import { getTaskByPaymentId, markTaskFunded } from "@/lib/db/tasks";
import { getOnChainTask, getEscrowConfig, getCurrentBlockTimestamp } from "@/lib/contracts/escrow";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";

const USDC_DECIMALS = 6;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { payment_request_id } = body as {
      payment_request_id: string;
    };

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

    if (task.status !== "pending") {
      return NextResponse.json(
        {
          ok: false,
          error: `Task is already ${task.status}`,
        },
        { status: 409 }
      );
    }

    const escrowConfig = getEscrowConfig();
    if (!escrowConfig.address) {
      // Config problem, not a client problem — and never silently "confirm" a task
      // the chain could not vouch for.
      log("error", "fund_task_escrow_not_configured", { payment_request_id });
      return NextResponse.json(
        { ok: false, error: "Escrow contract is not configured" },
        { status: 503 }
      );
    }

    // The authority read: what does the chain say (Defect 3)?
    let onChainTask;
    try {
      onChainTask = await getOnChainTask(payment_request_id);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "fund_task_chain_read_failed", {
        payment_request_id,
        error: message,
      });
      return NextResponse.json(
        { ok: false, error: "Could not read on-chain escrow state" },
        { status: 502 }
      );
    }

    if (onChainTask.state === "None") {
      return NextResponse.json(
        {
          ok: false,
          status: "pending",
          on_chain_state: "None",
          error:
            "No on-chain task at this id yet. Fund the escrow with USDC.approve + escrow.createTask, then retry.",
        },
        { status: 409 }
      );
    }

    // Funded or later — the escrow holds (or held) the money, so activation is
    // legitimate. But the row and the chain must agree on *whose* task it is and
    // for *how much*, or the DB would be a projection of something that never
    // happened. Wallets are lowercase in the DB (migration 014); the chain returns
    // checksummed.
    const expectedAmountWei = BigInt(
      Math.round(task.amount_usdc * 10 ** USDC_DECIMALS)
    );
    if (
      onChainTask.worker.toLowerCase() !== task.to_human_wallet.toLowerCase() ||
      onChainTask.amount !== expectedAmountWei
    ) {
      log("error", "fund_task_chain_mismatch", {
        payment_request_id,
        on_chain_worker: onChainTask.worker,
        db_worker: task.to_human_wallet,
        on_chain_amount_wei: onChainTask.amount.toString(),
        expected_amount_wei: expectedAmountWei.toString(),
      });
      return NextResponse.json(
        {
          ok: false,
          on_chain_state: onChainTask.state,
          error:
            "On-chain task does not match this task row (worker or amount). Refusing to activate.",
        },
        { status: 409 }
      );
    }

    // CC-092: the funding timestamp the eventual verdict service needs for
    // captured_after: "task_funding_block_timestamp" — captured here, where the
    // chain is already being read, rather than scanned for later via TaskCreated.
    const fundedAt = await getCurrentBlockTimestamp();
    await markTaskFunded(payment_request_id, fundedAt);

    log("info", "task_funded_on_chain_confirmed", {
      payment_request_id,
      on_chain_state: onChainTask.state,
      amount_usdc: task.amount_usdc,
      from_agent: task.from_agent_wallet,
      to_worker: task.to_human_wallet,
      funded_at: fundedAt,
    });

    return NextResponse.json({
      ok: true,
      payment_request_id,
      status: "active",
      on_chain_state: onChainTask.state,
      amount_usdc: task.amount_usdc,
      message:
        "On-chain task confirmed Funded. Task is now active.",
    });
  } catch (err: unknown) {
    return safeErrorResponse(err, "fund_task_failed");
  }
}
