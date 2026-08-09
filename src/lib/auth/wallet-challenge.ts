/**
 * wallet-challenge.ts
 * Shared challenge-response wallet signature verification (NOR-178).
 * Issued via POST /api/basedhuman.mcp/challenge; consumed here by any
 * endpoint that needs to authenticate a caller as a specific wallet
 * (the MCP transport, /api/dispute).
 */

import { verifyWalletSignature } from "@/lib/wallet/verify";
import { getSupabaseAdmin } from "@/lib/db/client";

/**
 * Verify a challenge-response signature.
 * Returns the verified wallet address on success, throws on failure.
 */
export async function verifyChallengeSignature(
  claimedWallet: string,
  signature: `0x${string}`,
  nonce: string,
): Promise<string> {
  const supabase = getSupabaseAdmin();

  const { data: challenge, error } = await supabase
    .from("mcp_challenges")
    .select("wallet_address, nonce, expires_at, used_at, created_at")
    .eq("nonce", nonce)
    .single();

  if (error || !challenge) {
    throw new Error("Challenge not found or expired");
  }

  if (challenge.used_at) {
    throw new Error("Challenge already consumed");
  }

  if (new Date(challenge.expires_at) < new Date()) {
    throw new Error("Challenge expired");
  }

  if (challenge.wallet_address !== claimedWallet.toLowerCase()) {
    throw new Error("Challenge was issued for a different wallet");
  }

  const timestamp = Math.floor(new Date(challenge.created_at).getTime() / 1000);
  const challengeMessage = `carbon-contractors.com wants to verify wallet ownership\nNonce: ${nonce}\nTimestamp: ${timestamp}`;

  // Must go through a public client (ERC-6492/1271-aware) rather than pure
  // offline ecrecover -- Base Account / Coinbase Smart Wallet is a contract
  // account, not an EOA, and would fail signature verification otherwise.
  const valid = await verifyWalletSignature({
    address: claimedWallet as `0x${string}`,
    message: challengeMessage,
    signature,
  });

  if (!valid) {
    throw new Error("Signature does not match claimed wallet");
  }

  await supabase
    .from("mcp_challenges")
    .update({ used_at: new Date().toISOString() })
    .eq("nonce", nonce);

  return claimedWallet;
}
