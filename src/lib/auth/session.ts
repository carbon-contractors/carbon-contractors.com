/**
 * session.ts — server-side session minting and verification (NOR-322, ADR-0009).
 *
 * The boundary is ADR-0009 D3's sentence: a session is not a wallet. It
 * authorises off-chain API calls for the holder's own data — task lists,
 * profile, channels, offer decisions, evidence submission — and can never move
 * funds, sign a verdict, or satisfy a contract-side check. Every on-chain
 * authorisation remains a native wallet prompt.
 *
 * Tokens are opaque 256-bit random values shown to the client exactly once;
 * only their SHA-256 hash is stored. That makes revocation a row update (D5)
 * rather than a denylist, and means a database read never yields a usable
 * token. 30 days, sliding, per D5 — fixed by the ADR, so deliberately a
 * constant and not an env var.
 */

import { createHash, randomBytes } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/db/client";

export const SESSION_COOKIE = "cc_session";
export const SESSION_TTL_DAYS = 30;
export const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;

/** The one scope human sessions ship with; delegation scopes are reserved, not built (ADR-0009 D4). */
export const SCOPE_FULL = "session:full";

/** How long a token may ride without refreshing its sliding window. */
const SLIDE_THROTTLE_MS = 60 * 60 * 1000;

export interface ActiveSession {
  id: string;
  name: string | null;
  scopes: string[];
  created_at: string;
  last_used_at: string;
  expires_at: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Mint a session for a wallet whose ownership was just proven by challenge. */
export async function mintSession(
  wallet: string,
  name: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = `ccs_${randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("sessions").insert({
    wallet: wallet.toLowerCase(),
    token_hash: hashToken(token),
    scopes: [SCOPE_FULL],
    name,
    expires_at: expiresAt.toISOString(),
  });
  if (error) {
    throw new Error(`mintSession failed: ${error.message}`);
  }
  return { token, expiresAt };
}

export interface VerifiedSession {
  wallet: string;
  sessionId: string;
  scopes: string[];
  expiresAt: Date;
}

/**
 * Verify a presented token. Returns null for unknown, revoked or expired
 * sessions; otherwise the wallet it authenticates, with the sliding window
 * refreshed (throttled so a burst of calls does not write per request).
 */
export async function verifySessionToken(
  token: string,
): Promise<VerifiedSession | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sessions")
    .select("id, wallet, scopes, revoked_at, expires_at, last_used_at")
    .eq("token_hash", hashToken(token))
    .maybeSingle();
  if (error) {
    throw new Error(`verifySessionToken failed: ${error.message}`);
  }
  if (!data || data.revoked_at) {
    return null;
  }
  const expiresAt = new Date(data.expires_at as string);
  if (expiresAt.getTime() <= Date.now()) {
    return null;
  }
  const wallet = data.wallet as string;
  const sessionId = data.id as string;
  const scopes = (data.scopes as string[] | null) ?? [SCOPE_FULL];
  const lastUsed = new Date(data.last_used_at as string);
  if (Date.now() - lastUsed.getTime() > SLIDE_THROTTLE_MS) {
    const next = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
    const { error: slideError } = await supabase
      .from("sessions")
      .update({
        last_used_at: new Date().toISOString(),
        expires_at: next.toISOString(),
      })
      .eq("id", sessionId);
    if (slideError) {
      throw new Error(`verifySessionToken slide failed: ${slideError.message}`);
    }
    return { wallet, sessionId, scopes, expiresAt: next };
  }
  return { wallet, sessionId, scopes, expiresAt };
}

/** The caller's live sessions, newest first — the dashboard session list (D5). */
export async function listSessions(wallet: string): Promise<ActiveSession[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sessions")
    .select("id, name, scopes, created_at, last_used_at, expires_at")
    .eq("wallet", wallet.toLowerCase())
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`listSessions failed: ${error.message}`);
  }
  return (data ?? []) as ActiveSession[];
}

/** Revoke one session the caller owns. True when a row was actually revoked. */
export async function revokeSession(
  wallet: string,
  sessionId: string,
): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("wallet", wallet.toLowerCase())
    .select("id");
  if (error) {
    throw new Error(`revokeSession failed: ${error.message}`);
  }
  return (data?.length ?? 0) > 0;
}

/** Revoke every live session for a wallet — "sign out everywhere" (D5). */
export async function revokeAllSessions(wallet: string): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("wallet", wallet.toLowerCase())
    .is("revoked_at", null)
    .select("id");
  if (error) {
    throw new Error(`revokeAllSessions failed: ${error.message}`);
  }
  return data?.length ?? 0;
}

/**
 * Pull the presented token from a request — `Authorization: Bearer` first
 * (ADR-0009 D2's non-browser transport), then the session cookie. Reads the
 * raw Cookie header rather than NextRequest's cookie API so the helper works
 * on plain Request objects, which is also what the route tests construct.
 */
export function tokenFromRequest(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token) return token;
  }
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      const value = decodeURIComponent(rest.join("="));
      return value || null;
    }
  }
  return null;
}

/**
 * The wallet a valid session authenticates, or null. Never throws — a session
 * problem is an authentication absence, and each route decides its own 401.
 */
export async function sessionWalletFromRequest(
  req: Request,
): Promise<string | null> {
  const token = tokenFromRequest(req);
  if (!token) return null;
  try {
    const verified = await verifySessionToken(token);
    return verified?.wallet ?? null;
  } catch {
    return null;
  }
}
