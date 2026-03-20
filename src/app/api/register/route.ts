import { NextRequest } from "next/server";
import { verifyMessage } from "viem";
import { getSupabaseAdmin } from "@/lib/db/client";
import { log } from "@/lib/logging";

interface RegisterBody {
  message: string;
  signature: `0x${string}`;
  wallet: `0x${string}`;
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

  // Parse the signed message to extract registration data
  let parsed: { skills: string[]; rate_usdc: number };
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
  } catch {
    return Response.json(
      { error: "Invalid registration payload" },
      { status: 400 },
    );
  }

  // Upsert into humans table (service role bypasses RLS)
  const supabase = getSupabaseAdmin();
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
