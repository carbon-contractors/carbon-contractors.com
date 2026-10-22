/**
 * POST /api/attestation/publish — a signed delegated request that publishes the worker's
 * completion on chain, from the worker's own wallet and at their own gas (CC-036,
 * ADR-0008 D2, A2.3). Body: `{ "payment_request_id": "…" }`.
 *
 * Every call signs a **fresh** request at the attester's current EAS nonce — which is why
 * this is a POST and the off-chain copy (`/api/attestation/completion`) is a GET. The
 * response is meant to be submitted at once: it is stale as soon as any other delegated
 * request lands, and on EAS 1.1+ it expires after an hour. A stale one reverts and is
 * simply re-requested (A2.3).
 *
 * Worker only, judged against the on-chain worker before anything is signed (CC-037).
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyChallengeSignature } from "@/lib/auth/wallet-challenge";
import { sessionWalletFromRequest } from "@/lib/auth/session";
import { isValidWalletAddress } from "@/lib/validation";
import { CompletionAttestationError } from "@/lib/attestation/completion";
import { signDelegatedCompletionRequest } from "@/lib/attestation/delegated";
import { UnknownAttestEnvelopeError } from "@/lib/attestation/envelope";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";

const PAYMENT_REQUEST_ID = /^[a-f0-9]{32}$/;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const sessionWallet = await sessionWalletFromRequest(request);
  let callerWallet: string;
  if (sessionWallet) {
    callerWallet = sessionWallet;
  } else {
    const rawWallet = request.headers.get("x-caller-wallet");
    const signature = request.headers.get("x-caller-signature") as `0x${string}` | null;
    const nonce = request.headers.get("x-caller-nonce");
    if (!rawWallet || !isValidWalletAddress(rawWallet) || !signature || !nonce) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Sign in, or get a nonce from /api/basedhuman.mcp/challenge, sign it, and retry with x-caller-wallet/x-caller-signature/x-caller-nonce headers.",
        },
        { status: 401 },
      );
    }
    try {
      callerWallet = await verifyChallengeSignature(rawWallet, signature, nonce);
    } catch {
      return NextResponse.json({ ok: false, error: "Signature verification failed" }, { status: 401 });
    }
  }

  let paymentRequestId: unknown;
  try {
    paymentRequestId = ((await request.json()) as { payment_request_id?: unknown }).payment_request_id;
  } catch {
    paymentRequestId = undefined;
  }
  if (typeof paymentRequestId !== "string" || !PAYMENT_REQUEST_ID.test(paymentRequestId)) {
    return NextResponse.json(
      { ok: false, error: "payment_request_id must be the 32-character hex id of the task" },
      { status: 400 },
    );
  }

  try {
    const publish = await signDelegatedCompletionRequest(paymentRequestId, callerWallet);
    log("info", "delegated_attestation_signed", {
      payment_request_id: paymentRequestId,
      nonce: publish.nonce,
      envelope: publish.envelope,
    });
    return NextResponse.json({ ok: true, publish });
  } catch (err) {
    if (err instanceof CompletionAttestationError) {
      const status = err.reason === "forbidden" ? 403 : 409;
      return NextResponse.json({ ok: false, error: err.message, reason: err.reason }, { status });
    }
    if (err instanceof UnknownAttestEnvelopeError) {
      // EAS changed under us. Loud, and not the caller's fault — but nothing was signed.
      log("error", "delegated_attestation_unknown_envelope", { type_hash: err.typeHash });
      return NextResponse.json(
        { ok: false, error: "On-chain publishing is temporarily unavailable", reason: "refused" },
        { status: 503 },
      );
    }
    return safeErrorResponse(err, "delegated_attestation_failed");
  }
}
