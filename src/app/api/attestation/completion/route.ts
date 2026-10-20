/**
 * GET /api/attestation/completion?payment_request_id=… — the worker's signed completion
 * attestation (CC-036, ADR-0008 D1/A3).
 *
 * The off-chain EAS attestation the worker keeps: the durable copy of their record
 * (ADR-0006 D7), signed by the verdict signer, sent by nobody. Deterministic (A3.2), so
 * fetching it again returns the same attestation rather than a new one.
 *
 * Worker only, judged against the **on-chain** worker, never the DB (CC-037). Auth is the
 * ADR-0009 session, else the challenge-response headers — the same two doors as
 * `/api/verdict`.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyChallengeSignature } from "@/lib/auth/wallet-challenge";
import { sessionWalletFromRequest } from "@/lib/auth/session";
import { isValidWalletAddress } from "@/lib/validation";
import {
  CompletionAttestationError,
  signCompletionAttestation,
} from "@/lib/attestation/completion";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";

const PAYMENT_REQUEST_ID = /^[a-f0-9]{32}$/;

export async function GET(request: NextRequest): Promise<NextResponse> {
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

  const paymentRequestId = new URL(request.url).searchParams.get("payment_request_id") ?? "";
  if (!PAYMENT_REQUEST_ID.test(paymentRequestId)) {
    return NextResponse.json(
      { ok: false, error: "payment_request_id must be the 32-character hex id of the task" },
      { status: 400 },
    );
  }

  try {
    const attestation = await signCompletionAttestation(paymentRequestId, callerWallet);
    log("info", "completion_attestation_signed", {
      payment_request_id: paymentRequestId,
      uid: attestation.sig.uid,
    });
    return NextResponse.json({ ok: true, attestation });
  } catch (err) {
    if (err instanceof CompletionAttestationError) {
      const status = err.reason === "forbidden" ? 403 : 409;
      return NextResponse.json({ ok: false, error: err.message, reason: err.reason }, { status });
    }
    return safeErrorResponse(err, "completion_attestation_failed");
  }
}
