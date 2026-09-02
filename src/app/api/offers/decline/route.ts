/**
 * route.ts — /api/offers/decline
 *
 * The worker's "no" to a pending offer (CC-094 / ADR-0005 D6). Declining is
 * free and carries no reputational penalty in v1 — it frees the agent to
 * re-target immediately, and it is exactly the answer the system needs to
 * hear. Money never moved, so there is nothing to unwind.
 *
 * Requires the same wallet challenge-response signature as the MCP transport
 * (CC-093): get a nonce from POST /api/basedhuman.mcp/challenge, sign the
 * returned message, and send the result as x-caller-wallet / x-caller-signature
 * / x-caller-nonce headers. The caller must be the wallet offered the task
 * (to_human_wallet).
 */

import { NextRequest, NextResponse } from "next/server";
import { respondToOffer } from "@/lib/offers";
import { verifyChallengeSignature } from "@/lib/auth/wallet-challenge";
import { sessionWalletFromRequest } from "@/lib/auth/session";
import { isValidWalletAddress } from "@/lib/validation";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";

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
        { status: 401 },
      );
    }

    // ADR-0009: a valid session (cookie or bearer) authenticates without a
    // prompt; machine callers keep the challenge path (D6).
    const sessionWallet = await sessionWalletFromRequest(request);
    let callerWallet: string;
    if (sessionWallet) {
      callerWallet = sessionWallet;
    } else {
      try {
        callerWallet = await verifyChallengeSignature(rawWallet, signature, nonce);
      } catch (err) {
        log("warn", "offer_decline_auth_failed", {
          wallet: rawWallet,
          error: err instanceof Error ? err.message : String(err),
        });
        return NextResponse.json(
          { ok: false, error: "Signature verification failed" },
          { status: 401 },
        );
      }
    }

    const body = await request.json();
    const { payment_request_id } = body as { payment_request_id: string };

    if (!payment_request_id) {
      return NextResponse.json(
        { ok: false, error: "payment_request_id required" },
        { status: 400 },
      );
    }

    const result = await respondToOffer(callerWallet, payment_request_id, "decline");
    if (!result.ok) {
      return NextResponse.json(result, { status: result.httpStatus });
    }
    return NextResponse.json(result);
  } catch (err: unknown) {
    return safeErrorResponse(err, "offer_decline_failed");
  }
}
