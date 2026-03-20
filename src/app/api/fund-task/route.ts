/**
 * route.ts — /api/fund-task
 *
 * x402-protected endpoint for funding task escrow.
 * Flow:
 *   1. Agent calls request_human_work MCP tool → gets payment_request_id + amount
 *   2. Agent POSTs here with { payment_request_id }
 *   3. x402 facilitator verifies USDC payment (amount matches task)
 *   4. On success, task status moves to "active"
 *
 * The x402 facilitator (x402.org) handles payment verification and settlement.
 * Payment is sent to the platform wallet (NEXT_PUBLIC_ESCROW_CONTRACT or
 * PLATFORM_WALLET_ADDRESS). The platform then manages escrow release on
 * task completion.
 */

import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "x402-next";
import { getTaskByPaymentId, updateTaskStatus } from "@/lib/db/tasks";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";
import { getConfig } from "@/lib/config";
import type { Address } from "viem";

function getPlatformWallet(): Address {
  const config = getConfig();
  return (config.NEXT_PUBLIC_ESCROW_CONTRACT ??
    config.PLATFORM_WALLET_ADDRESS ??
    "") as Address;
}

function getNetwork(): "base" | "base-sepolia" {
  return getConfig().NEXT_PUBLIC_BASE_NETWORK === "mainnet"
    ? "base"
    : "base-sepolia";
}

/**
 * Inner handler — runs only after x402 payment is verified.
 */
async function fundTaskHandler(
  request: NextRequest
): Promise<NextResponse> {
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

    // x402 payment verified by facilitator — activate the task
    await updateTaskStatus(payment_request_id, "active");

    log("info", "task_funded_x402", {
      payment_request_id,
      amount_usdc: task.amount_usdc,
      from_agent: task.from_agent_wallet,
      to_worker: task.to_human_wallet,
    });

    return NextResponse.json({
      ok: true,
      payment_request_id,
      status: "active",
      amount_usdc: task.amount_usdc,
      message: "Payment verified. Task is now active.",
    });
  } catch (err: unknown) {
    return safeErrorResponse(err, "fund_task_failed");
  }
}

/**
 * Dynamic route config — reads the task amount from the DB
 * so the x402 price matches what the agent agreed to pay.
 */
async function dynamicRouteConfig(req: NextRequest) {
  try {
    const body = await req.clone().json();
    const { payment_request_id } = body as {
      payment_request_id: string;
    };

    if (payment_request_id) {
      const task = await getTaskByPaymentId(payment_request_id);
      if (task) {
        return {
          price: `$${task.amount_usdc}`,
          network: getNetwork(),
          config: {
            description: `Carbon Contractors task funding: ${task.task_description.slice(0, 100)}`,
          },
        };
      }
    }
  } catch {
    // Fall through to default price
  }

  // Default: minimum price for discovery/invalid requests
  return {
    price: "$0.01",
    network: getNetwork(),
    config: {
      description: "Carbon Contractors task funding",
    },
  };
}

export const POST = withX402(
  fundTaskHandler,
  getPlatformWallet(),
  dynamicRouteConfig
);
