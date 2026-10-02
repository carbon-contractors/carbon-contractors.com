/**
 * route.ts — POST /api/evidence/upload-url (ADR-0010 D2)
 *
 * Mints one short-lived pre-signed PUT so the assigned worker's browser can
 * upload one evidence file straight into the hiring agent's bucket. The
 * platform never touches the bytes (D1): it validates, signs, and gets out of
 * the way.
 *
 * Grants only when ALL hold:
 *   - the caller is authenticated (ADR-0009 session, or the CC-093 challenge
 *     headers for non-browser callers) and is the task's worker;
 *   - the task is `active` in the DB and `Funded` on-chain — once submitWork
 *     lands the evidence bundle is frozen (D4), so no further grant can help;
 *   - the agent supplied a credential (task_upload_credentials) for an s3/gcs
 *     evidence_bucket in its committed spec;
 *   - the file's declared type is allowlisted and its size within the cap.
 *
 * The returned URL is a bearer grant: it is never logged, and the signature
 * covers content-type and content-length so it fits exactly this one file.
 */

import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sessionWalletFromRequest } from "@/lib/auth/session";
import { verifyChallengeSignature } from "@/lib/auth/wallet-challenge";
import { getTaskByPaymentId } from "@/lib/db/tasks";
import { getUploadCredential } from "@/lib/db/upload-credentials";
import { getOnChainTask } from "@/lib/contracts/escrow";
import { parseAndHashSpec } from "@/lib/spec/hash";
import {
  decryptCredential,
  isEvidenceEncryptionConfigured,
} from "@/lib/evidence/credential-crypto";
import { presignUrl } from "@/lib/evidence/presign";
import {
  PLATFORM_MAX_UPLOAD_BYTES,
  UPLOAD_URL_TTL_SECONDS,
  checkUploadRequest,
  objectKeyFor,
  objectUri,
  resolveBucketLocation,
} from "@/lib/evidence/upload-policy";
import { isValidWalletAddress } from "@/lib/validation";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";

const BodySchema = z.object({
  payment_request_id: z.string().min(1).max(200),
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(100),
  size_bytes: z.number().int().positive(),
});

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

async function authenticate(request: NextRequest): Promise<string | null> {
  const sessionWallet = await sessionWalletFromRequest(request);
  if (sessionWallet) return sessionWallet.toLowerCase();
  const rawWallet = request.headers.get("x-caller-wallet");
  const signature = request.headers.get("x-caller-signature") as `0x${string}` | null;
  const nonce = request.headers.get("x-caller-nonce");
  if (!rawWallet || !isValidWalletAddress(rawWallet) || !signature || !nonce) return null;
  try {
    return (await verifyChallengeSignature(rawWallet, signature, nonce)).toLowerCase();
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    if (!isEvidenceEncryptionConfigured()) {
      return fail(503, "Evidence upload is not enabled on this deployment — paste a link to your file instead.");
    }

    const caller = await authenticate(request);
    if (!caller) {
      return fail(401, "Sign in to upload evidence.");
    }

    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, "payment_request_id, filename, content_type and size_bytes are required.");
    }
    const { payment_request_id, filename, content_type, size_bytes } = parsed.data;

    const task = await getTaskByPaymentId(payment_request_id);
    if (!task) return fail(404, "Task not found.");
    if (task.to_human_wallet.toLowerCase() !== caller) {
      return fail(403, "Only this task's worker can upload evidence for it.");
    }
    if (task.status !== "active") {
      return fail(409, "Evidence can only be uploaded while the task is active.");
    }

    const credentialRow = await getUploadCredential(payment_request_id);
    if (!credentialRow) {
      return fail(
        409,
        "The hiring agent didn't provide a storage bucket for this task, so files can't be uploaded here — paste a link to where your file is hosted instead.",
      );
    }

    const onChain = await getOnChainTask(payment_request_id);
    if (onChain.state !== "Funded") {
      return fail(
        409,
        onChain.state === "None"
          ? "This task isn't funded on-chain yet, so there's nothing to upload evidence for."
          : "Work has already been submitted for this task — the evidence is final and can't be added to.",
      );
    }

    const cap = Math.min(credentialRow.max_upload_bytes, PLATFORM_MAX_UPLOAD_BYTES);
    const check = checkUploadRequest(content_type, size_bytes, cap);
    if (!check.ok) return fail(400, check.error);

    if (!task.acceptance_spec) return fail(409, "This task has no acceptance spec to upload against.");
    const bucket = parseAndHashSpec(task.acceptance_spec).spec.evidence_bucket;
    if (!bucket) {
      return fail(409, "This task's spec names no evidence bucket.");
    }

    const credential = await decryptCredential(credentialRow.credential_envelope, payment_request_id);
    const resolved = resolveBucketLocation(bucket.provider, bucket.target, {
      region: credential.region,
      endpoint: credential.endpoint,
    });
    if (!resolved.ok) {
      // Validated at request_human_work time, so this is drift, not user error.
      log("error", "evidence_upload_bucket_unresolvable", { payment_request_id });
      return fail(500, "The hiring agent's bucket settings are invalid — tell the agent, or paste a link instead.");
    }

    const key = objectKeyFor(payment_request_id, randomBytes(8).toString("hex"), filename);
    const uploadUrl = presignUrl({
      method: "PUT",
      location: resolved.location,
      key,
      credential,
      expiresSeconds: UPLOAD_URL_TTL_SECONDS,
      headers: {
        "content-type": check.contentType,
        "content-length": String(check.sizeBytes),
      },
    });

    // Identifiers and sizes only — never the URL (a bearer grant) or the key material.
    log("info", "evidence_upload_grant_issued", {
      payment_request_id,
      provider: resolved.location.provider,
      content_type: check.contentType,
      size_bytes: check.sizeBytes,
    });

    return NextResponse.json({
      ok: true,
      upload_url: uploadUrl,
      method: "PUT",
      headers: { "Content-Type": check.contentType },
      uri: objectUri(resolved.location, key),
      expires_at: Math.floor(Date.now() / 1000) + UPLOAD_URL_TTL_SECONDS,
    });
  } catch (err: unknown) {
    return safeErrorResponse(err, "evidence_upload_url_failed");
  }
}
