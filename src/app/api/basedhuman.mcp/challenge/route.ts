/**
 * route.ts — /api/basedhuman.mcp/challenge
 *
 * Issues single-use, time-limited nonces for SIWE-style MCP authentication.
 * Agent calls this first, signs the nonce, then includes signature in MCP requests.
 */

import { NextRequest } from "next/server";
import { randomBytes } from "crypto";
import { getSupabaseAdmin } from "@/lib/db/client";
import { isValidWalletAddress } from "@/lib/validation";
import { buildChallengeMessage } from "@/lib/auth/wallet-challenge";
import { log } from "@/lib/logging";

const CHALLENGE_TTL_S = 60; // 60 seconds

export async function POST(req: NextRequest): Promise<Response> {
  let body: { walletAddress?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { walletAddress } = body;
  if (!walletAddress || !isValidWalletAddress(walletAddress)) {
    return Response.json(
      { error: "Valid walletAddress required (0x-prefixed, 40 hex chars)" },
      { status: 400 },
    );
  }

  const nonce = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_S * 1000);

  const supabase = getSupabaseAdmin();

  // Purge expired challenges (best-effort cleanup, same pattern as used_nonces)
  await supabase
    .from("mcp_challenges")
    .delete()
    .lt("expires_at", new Date().toISOString());

  // `created_at` is read BACK from the row rather than assumed, because it is the
  // timestamp the verifier rebuilds the message from — it is Postgres `now()`, not this
  // process's clock. Issuing a message stamped with `Date.now()` and verifying one
  // stamped with `created_at` is what made signature checks fail intermittently.
  const { data: row, error } = await supabase
    .from("mcp_challenges")
    .insert({
      wallet_address: walletAddress.toLowerCase(),
      nonce,
      expires_at: expiresAt.toISOString(),
    })
    .select("created_at")
    .single();

  if (error || !row?.created_at) {
    log("error", "challenge_create_failed", {
      error: error?.message ?? "insert returned no created_at",
    });
    return Response.json({ error: "Failed to create challenge" }, { status: 500 });
  }

  log("info", "mcp_challenge_issued", { wallet: walletAddress });

  return Response.json({
    nonce,
    expiresAt: Math.floor(expiresAt.getTime() / 1000),
    message: buildChallengeMessage(nonce, row.created_at),
  });
}
