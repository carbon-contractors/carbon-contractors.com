/**
 * route.ts — /api/dispute
 *
 * REST endpoint for workers to initiate task disputes from the dashboard.
 * Updates database status only — the worker must also call
 * escrow.disputeTask() on-chain via their connected wallet.
 */

import { NextRequest, NextResponse } from "next/server";
import { getTaskByPaymentId, updateTaskStatus } from "@/lib/db/tasks";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
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
