import { NextRequest, NextResponse } from "next/server";
import { getHumanByWallet } from "@/lib/db/whitepages";
import { getSupabaseAdmin } from "@/lib/db/client";
import { verifyWalletSignature } from "@/lib/wallet/verify";
import { validateCategorySelection } from "@/lib/categories";
import { isValidWalletAddress } from "@/lib/validation";
import type { Availability } from "@/lib/db/types";
import { log } from "@/lib/logging";

export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet");

  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return NextResponse.json(
      { ok: false, error: "Valid wallet address required" },
      { status: 400 },
    );
  }

  const human = await getHumanByWallet(wallet);

  if (!human) {
    return NextResponse.json(
      { ok: false, error: "Worker not registered" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    ok: true,
    profile: {
      wallet: human.wallet,
      categories: human.categories,
      rate_usdc: human.rate_usdc,
      availability: human.availability,
    },
  });
}

// ── PATCH — worker profile edit (CC-021) ──────────────────────────────────────

/** Maximum age (in seconds) for a profile-update message to be considered valid. */
const MAX_MESSAGE_AGE_S = 300; // 5 minutes

const VALID_AVAILABILITY: ReadonlySet<string> = new Set(["available", "busy", "offline"]);

/** Upper bound for an hourly rate — anything above this is a typo or an attack, not a price. */
const MAX_RATE_USDC = 10_000;

interface ProfileUpdateBody {
  message: string;
  signature: `0x${string}`;
  wallet: `0x${string}`;
}

/**
 * The signed payload. `action` binds the signature to this endpoint so a message
 * signed for a different purpose (registration, dispute challenge) can never be
 * replayed here, and `wallet` binds it to the signer.
 */
interface ProfileUpdatePayload {
  action: "profile-update";
  wallet: string;
  timestamp: number;
  availability?: Availability;
  rate_usdc?: number;
  categories?: string[];
}

export async function PATCH(req: NextRequest): Promise<Response> {
  let body: ProfileUpdateBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { message, signature, wallet } = body;

  if (!message || !signature || !wallet || !isValidWalletAddress(wallet)) {
    return Response.json(
      { ok: false, error: "Missing or invalid message, signature, or wallet" },
      { status: 400 },
    );
  }

  // Verify the signature against the claimed wallet. Must go through the public
  // client (ERC-6492/1271-aware) — Base Account smart wallets don't produce raw
  // ECDSA signatures recoverable to the address. Same helper as /api/register.
  let valid: boolean;
  try {
    valid = await verifyWalletSignature({ address: wallet, message, signature });
  } catch (err: unknown) {
    // RPC/ERC-6492 detail, not user data — safe to surface (see register route).
    const detail = err instanceof Error ? err.message : String(err);
    log("error", "profile_signature_verification_error", { wallet, error: detail });
    return Response.json(
      { ok: false, error: "Signature verification failed", detail },
      { status: 400 },
    );
  }

  if (!valid) {
    log("warn", "profile_invalid_signature", {
      wallet,
      messageLength: message.length,
      signatureLength: signature.length,
    });
    return Response.json({ ok: false, error: "Invalid signature" }, { status: 401 });
  }

  // Normalise once, post-verification — `humans.wallet` is lowercase-enforced
  // (CC-002). Verification above used the original casing the client signed.
  const normalizedWallet = wallet.toLowerCase() as `0x${string}`;

  let parsed: ProfileUpdatePayload;
  try {
    parsed = JSON.parse(message) as ProfileUpdatePayload;
  } catch {
    return Response.json(
      { ok: false, error: "Signed message is not valid JSON" },
      { status: 400 },
    );
  }

  if (parsed.action !== "profile-update") {
    return Response.json(
      { ok: false, error: "Signed message is not a profile update" },
      { status: 400 },
    );
  }

  // The signature proved ownership of `wallet`; the payload must agree with it,
  // or the caller is presenting a message signed by someone else's session.
  if (
    typeof parsed.wallet !== "string" ||
    parsed.wallet.toLowerCase() !== normalizedWallet
  ) {
    return Response.json(
      { ok: false, error: "Signed wallet does not match request wallet" },
      { status: 400 },
    );
  }

  if (typeof parsed.timestamp !== "number") {
    return Response.json(
      { ok: false, error: "Missing timestamp" },
      { status: 400 },
    );
  }

  const nowS = Math.floor(Date.now() / 1000);
  const age = nowS - parsed.timestamp;
  if (age < 0 || age > MAX_MESSAGE_AGE_S) {
    return Response.json(
      { ok: false, error: `Message expired or clock skew. Must be within ${MAX_MESSAGE_AGE_S}s.` },
      { status: 400 },
    );
  }

  // At least one editable field must be present — an empty update is a client bug.
  if (
    parsed.availability === undefined &&
    parsed.rate_usdc === undefined &&
    parsed.categories === undefined
  ) {
    return Response.json(
      { ok: false, error: "Nothing to update. Provide availability, rate_usdc, or categories." },
      { status: 400 },
    );
  }

  const updates: {
    availability?: Availability;
    rate_usdc?: number;
    categories?: string[];
  } = {};

  if (parsed.availability !== undefined) {
    if (!VALID_AVAILABILITY.has(parsed.availability)) {
      return Response.json(
        { ok: false, error: "availability must be one of: available, busy, offline" },
        { status: 400 },
      );
    }
    updates.availability = parsed.availability;
  }

  if (parsed.rate_usdc !== undefined) {
    const rate = parsed.rate_usdc;
    // `Number.isFinite` rejects NaN/Infinity, which slip through `typeof === "number"`.
    // Two-decimal check via round-trip: 10.01 survives, 10.011 does not.
    if (
      !Number.isFinite(rate) ||
      rate <= 0 ||
      rate > MAX_RATE_USDC ||
      Math.round(rate * 100) / 100 !== rate
    ) {
      return Response.json(
        {
          ok: false,
          error: `rate_usdc must be a positive number up to ${MAX_RATE_USDC} with at most 2 decimal places`,
        },
        { status: 400 },
      );
    }
    updates.rate_usdc = rate;
  }

  if (parsed.categories !== undefined) {
    // Same rules as registration: min 1, max 2, valid slugs.
    const catResult = validateCategorySelection(parsed.categories);
    if (!catResult.valid) {
      return Response.json({ ok: false, error: catResult.error }, { status: 400 });
    }
    updates.categories = parsed.categories;
  }

  // Service role bypasses RLS (CC-021 update 2026-07-30: the migration 005
  // self-service policies are dormant — nothing mints a Supabase JWT).
  const supabase = getSupabaseAdmin();
  const { data: updated, error } = await supabase
    .from("humans")
    .update(updates)
    .eq("wallet", normalizedWallet)
    .select("wallet, categories, rate_usdc, availability")
    .single();

  if (error || !updated) {
    // `.single()` on a non-matching wallet errors rather than returning null —
    // an unregistered wallet lands here, not silently no-op.
    log("warn", "profile_update_failed", {
      wallet: normalizedWallet,
      error: error ? error.message : "no row returned",
    });
    return Response.json(
      { ok: false, error: "Worker not registered" },
      { status: 404 },
    );
  }

  log("info", "profile_updated", {
    wallet: normalizedWallet,
    fields: Object.keys(updates),
  });

  return Response.json({ ok: true, profile: updated });
}
