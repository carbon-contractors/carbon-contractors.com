import { NextRequest } from "next/server";
import { verifyMessage } from "viem";
import { getSupabaseAdmin } from "@/lib/db/client";
import { log } from "@/lib/logging";

/** Maximum age (in seconds) for a registration message to be considered valid. */
const MAX_MESSAGE_AGE_S = 300; // 5 minutes

interface RegisterBody {
  message: string;
  signature: `0x${string}`;
  wallet: `0x${string}`;
}

interface RegistrationPayload {
  skills: string[];
  rate_usdc: number;
  nonce: string;
  timestamp: number;
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

  // Verify the signature matches the claimed wallet
  let valid: boolean;
  try {
    valid = await verifyMessage({
      address: wallet,
      message,
      signature,
    });
  } catch {
    return Response.json({ error: "Signature verification failed" }, { status: 400 });
  }

  if (!valid) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Parse the signed message to extract registration data + replay protection fields
  let parsed: RegistrationPayload;
  try {
    parsed = JSON.parse(message);
    if (
      !Array.isArray(parsed.skills) ||
      parsed.skills.length === 0 ||
      typeof parsed.rate_usdc !== "number" ||
      parsed.rate_usdc <= 0
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
      { error: "Invalid registration payload. Required: skills, rate_usdc, nonce, timestamp." },
      { status: 400 },
    );
  }

  // Verify timestamp is within the acceptable window
  const nowS = Math.floor(Date.now() / 1000);
  const age = nowS - parsed.timestamp;
  if (age < 0 || age > MAX_MESSAGE_AGE_S) {
    return Response.json(
      { error: `Message expired or clock skew. Must be within ${MAX_MESSAGE_AGE_S}s.` },
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
    log("warn", "registration_nonce_replay", { wallet, nonce: parsed.nonce });
    return Response.json(
      { error: "Nonce already used. Generate a new registration message." },
      { status: 409 },
    );
  }

  // Consume the nonce
  const { error: nonceError } = await supabase.from("used_nonces").insert({
    nonce: parsed.nonce,
    wallet,
  });

  if (nonceError) {
    // Unique constraint violation = concurrent replay attempt
    log("warn", "registration_nonce_conflict", { wallet, nonce: parsed.nonce });
    return Response.json(
      { error: "Nonce already used. Generate a new registration message." },
      { status: 409 },
    );
  }

  // Upsert into humans table (service role bypasses RLS)
  const { error } = await supabase.from("humans").upsert(
    {
      wallet: wallet,
      skills: parsed.skills,
      rate_usdc: parsed.rate_usdc,
      availability: "available",
      reputation_score: 50, // default starting reputation
    },
    { onConflict: "wallet" },
  );

  if (error) {
    log("error", "registration_failed", {
      wallet,
      error: error.message,
    });
    return Response.json(
      { error: "Registration failed" },
      { status: 500 },
    );
  }

  log("info", "worker_registered", {
    wallet,
    skills: parsed.skills,
    rate_usdc: parsed.rate_usdc,
  });

  return Response.json({ ok: true, wallet });
}
