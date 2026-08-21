import { NextRequest } from "next/server";
import { verifyWalletSignature } from "@/lib/wallet/verify";
import { getSupabaseAdmin } from "@/lib/db/client";
import { log } from "@/lib/logging";
import { validateCategorySelection } from "@/lib/categories";
import { isValidEmail, rateUsdcError } from "@/lib/validation";
import { registerNotificationChannel } from "@/lib/db/notifications";

/** Maximum age (in seconds) for a registration message to be considered valid. */
const MAX_MESSAGE_AGE_S = 300; // 5 minutes

interface RegisterBody {
  message: string;
  signature: `0x${string}`;
  wallet: `0x${string}`;
}

interface RegistrationPayload {
  categories: string[];
  rate_usdc: number;
  nonce: string;
  timestamp: number;
  /** Optional contact channel so a worker can be told they've been hired (CC-005). */
  contact_email?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: RegisterBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { message, signature, wallet } = body;

  if (!message || !signature || !wallet) {
    return Response.json(
      { error: "Missing message, signature, or wallet" },
      { status: 400 },
    );
  }

  // Verify the signature matches the claimed wallet. Must go through a public
  // client (ERC-6492/1271-aware) rather than pure offline ecrecover -- Base
  // Account / Coinbase Smart Wallet is a contract account, not an EOA.
  let valid: boolean;
  try {
    valid = await verifyWalletSignature({
      address: wallet,
      message,
      signature,
    });
  } catch (err: unknown) {
    // This used to swallow the real reason entirely -- fine once this path was
    // known-working, actively harmful while diagnosing CC-069. The verification
    // failure reason (RPC/ERC-6492 detail, not user data) is safe to return as-is.
    const detail = err instanceof Error ? err.message : String(err);
    log("error", "register_signature_verification_error", { wallet, error: detail });
    return Response.json(
      { error: "Signature verification failed", detail },
      { status: 400 },
    );
  }

  if (!valid) {
    // viem's public-client verifyMessage converts most on-chain verification
    // failures (ERC-6492/1271 revert, etc.) into a clean `false` rather than
    // throwing -- this is the path most likely to actually fire, not the catch
    // above. Log enough to diagnose which verification mode was attempted.
    log("warn", "register_invalid_signature", {
      wallet,
      messageLength: message.length,
      signatureLength: signature.length,
    });
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Normalise once, post-verification — every write and lookup path below
  // and elsewhere in the app (whitepages.ts) treats `humans.wallet` as
  // lowercase (CC-002). Verification above used the original casing, which
  // is what the client actually signed.
  const normalizedWallet = wallet.toLowerCase() as `0x${string}`;

  // Parse the signed message to extract registration data + replay protection fields
  let parsed: RegistrationPayload;
  try {
    parsed = JSON.parse(message);
    if (
      !Array.isArray(parsed.categories) ||
      typeof parsed.rate_usdc !== "number"
    ) {
      throw new Error("Invalid registration data");
    }
    if (typeof parsed.nonce !== "string" || parsed.nonce.length < 8) {
      throw new Error("Missing or invalid nonce (min 8 characters)");
    }
    if (typeof parsed.timestamp !== "number") {
      throw new Error("Missing timestamp");
    }
  } catch {
    return Response.json(
      { error: "Invalid registration payload. Required: categories, rate_usdc, nonce, timestamp." },
      { status: 400 },
    );
  }

  // Rate bounds and 2-decimal check — the NUMERIC(10,2) column turns anything
  // above its ceiling into a 500 and silently rounds extra decimals (CC-022).
  const rateError = rateUsdcError(parsed.rate_usdc);
  if (rateError) {
    return Response.json({ error: rateError }, { status: 400 });
  }

  // Trim/lowercase before validating — the signed payload may carry incidental
  // whitespace from a form input, and the check should apply to the value
  // actually written, not the raw one.
  const contactEmail =
    typeof parsed.contact_email === "string"
      ? parsed.contact_email.trim().toLowerCase()
      : undefined;

  if (contactEmail && !isValidEmail(contactEmail)) {
    return Response.json({ error: "Invalid contact_email" }, { status: 400 });
  }

  // Validate category selection (min 1, max 2, valid slugs)
  const catResult = validateCategorySelection(parsed.categories);
  if (!catResult.valid) {
    return Response.json({ error: catResult.error }, { status: 400 });
  }

  // Verify timestamp is within the acceptable window
  const nowS = Math.floor(Date.now() / 1000);
  const age = nowS - parsed.timestamp;
  if (age < 0 || age > MAX_MESSAGE_AGE_S) {
    // CC-023: the timestamp comes from the client's clock, so a rejection here
    // almost always means a skewed device clock — name the cause and the remedy
    // rather than leaving the worker at a dead end.
    return Response.json(
      {
        error:
          "Device clock is out of sync with the server. Please check your device date/time settings and enable automatic network time.",
        detail: `Your message was timestamped ${Math.abs(age)}s ${age < 0 ? "ahead of" : "behind"} the server; the allowed window is ${MAX_MESSAGE_AGE_S}s.`,
      },
      { status: 400 },
    );
  }

  // Check nonce has not been used before (replay protection)
  const supabase = getSupabaseAdmin();

  // Purge stale nonces older than 1 hour (best-effort cleanup)
  const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  await supabase.from("used_nonces").delete().lt("consumed_at", oneHourAgo);

  const { data: existingNonce } = await supabase
    .from("used_nonces")
    .select("nonce")
    .eq("nonce", parsed.nonce)
    .single();

  if (existingNonce) {
    log("warn", "registration_nonce_replay", { wallet: normalizedWallet, nonce: parsed.nonce });
    return Response.json(
      { error: "Nonce already used. Generate a new registration message." },
      { status: 409 },
    );
  }

  // Consume the nonce
  const { error: nonceError } = await supabase.from("used_nonces").insert({
    nonce: parsed.nonce,
    wallet: normalizedWallet,
  });

  if (nonceError) {
    // Unique constraint violation = concurrent replay attempt
    log("warn", "registration_nonce_conflict", { wallet: normalizedWallet, nonce: parsed.nonce });
    return Response.json(
      { error: "Nonce already used. Generate a new registration message." },
      { status: 409 },
    );
  }

  // Upsert into humans table (service role bypasses RLS)
  const { data: humanRow, error } = await supabase
    .from("humans")
    .upsert(
      {
        wallet: normalizedWallet,
        categories: parsed.categories,
        rate_usdc: parsed.rate_usdc,
        availability: "available",
        reputation_score: 50, // default starting reputation
      },
      { onConflict: "wallet" },
    )
    .select("id")
    .single();

  if (error) {
    log("error", "registration_failed", {
      wallet: normalizedWallet,
      error: error.message,
    });
    return Response.json(
      { error: "Registration failed" },
      { status: 500 },
    );
  }

  // Best-effort: a worker who skipped this, or whose channel write fails, is
  // still registered — contact capture is a secondary write, not the
  // transaction that matters. Never log the address itself (it's PII).
  if (contactEmail) {
    try {
      await registerNotificationChannel({
        contractor_id: humanRow.id,
        type: "email",
        address: contactEmail,
        accepts_auto_booking: false,
      });
      log("info", "contact_channel_registered", { wallet: normalizedWallet, type: "email" });
    } catch (channelErr: unknown) {
      log("warn", "contact_channel_registration_failed", {
        wallet: normalizedWallet,
        error: channelErr instanceof Error ? channelErr.message : String(channelErr),
      });
    }
  }

  log("info", "worker_registered", {
    wallet: normalizedWallet,
    categories: parsed.categories,
    rate_usdc: parsed.rate_usdc,
  });

  return Response.json({ ok: true, wallet: normalizedWallet });
}
