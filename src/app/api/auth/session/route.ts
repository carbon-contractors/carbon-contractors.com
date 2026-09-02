/**
 * route.ts — /api/auth/session (NOR-322, ADR-0009)
 *
 * The one wallet signature per 30 days instead of one per request.
 *
 * POST   mint — the same wallet challenge-response proof as every other
 *        endpoint (get a nonce from /api/basedhuman.mcp/challenge, sign it),
 *        but the verified wallet mints a session instead of answering one call.
 *        Sets an httpOnly SameSite=Strict cookie and also returns the raw token
 *        for the Bearer transport (D2: one token, two transports). The token is
 *        shown exactly once; only its hash is stored.
 * GET    probe — 200 with the wallet while the session is valid, 401 when not.
 *        The dashboard uses this to decide whether a sign is needed.
 * DELETE revoke — {id} revokes one of the caller's sessions; {all: true} revokes
 *        every live session for the wallet and clears the cookie
 *        ("sign out everywhere", D5).
 *
 * A session is not a wallet (D3): nothing here authorises a fund movement, a
 * verdict signature, or a contract-side check.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyChallengeSignature } from "@/lib/auth/wallet-challenge";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  listSessions,
  mintSession,
  revokeAllSessions,
  revokeSession,
  tokenFromRequest,
  verifySessionToken,
} from "@/lib/auth/session";
import { isValidWalletAddress } from "@/lib/validation";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";

const MAX_NAME_LENGTH = 64;

interface SessionCookieSpec {
  name: string;
  value: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "strict";
  path: string;
  maxAge: number;
}

function sessionCookie(token: string, maxAge = SESSION_TTL_SECONDS): SessionCookieSpec {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    // Vercel is always HTTPS; local dev is not, and a Secure cookie on
    // http://localhost would silently never stick.
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => null);
    const { walletAddress, signature, nonce, name } = (body ?? {}) as {
      walletAddress?: string;
      signature?: `0x${string}`;
      nonce?: string;
      name?: string;
    };

    if (
      !walletAddress ||
      !isValidWalletAddress(walletAddress) ||
      !signature ||
      !nonce
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Wallet signature required. Get a nonce from /api/basedhuman.mcp/challenge, sign it, and send walletAddress/signature/nonce.",
        },
        { status: 401 },
      );
    }

    let wallet: string;
    try {
      wallet = await verifyChallengeSignature(walletAddress, signature, nonce);
    } catch (err) {
      log("warn", "session_mint_auth_failed", {
        wallet: walletAddress,
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        { ok: false, error: "Signature verification failed" },
        { status: 401 },
      );
    }

    const trimmedName =
      typeof name === "string" && name.trim()
        ? name.trim().slice(0, MAX_NAME_LENGTH)
        : "Dashboard";
    const { token, expiresAt } = await mintSession(wallet, trimmedName);
    log("info", "session_minted", { wallet, name: trimmedName });

    const res = NextResponse.json({
      ok: true,
      wallet,
      name: trimmedName,
      // Shown once, for the Bearer transport. Never logged, never stored raw.
      token,
      expires_at: expiresAt.toISOString(),
    });
    res.cookies.set(sessionCookie(token));
    return res;
  } catch (err: unknown) {
    return safeErrorResponse(err, "session_mint_failed");
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const token = tokenFromRequest(request);
    if (!token) {
      return NextResponse.json(
        { ok: false, error: "No session" },
        { status: 401 },
      );
    }
    const verified = await verifySessionToken(token);
    if (!verified) {
      return NextResponse.json(
        { ok: false, error: "Session expired or revoked" },
        { status: 401 },
      );
    }
    // The probe doubles as the session list (D5): same caller, same auth,
    // one round trip on dashboard load.
    const sessions = await listSessions(verified.wallet);
    return NextResponse.json({
      ok: true,
      wallet: verified.wallet,
      scopes: verified.scopes,
      expires_at: verified.expiresAt.toISOString(),
      sessions,
    });
  } catch (err: unknown) {
    return safeErrorResponse(err, "session_probe_failed");
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const token = tokenFromRequest(request);
    if (!token) {
      return NextResponse.json(
        { ok: false, error: "No session" },
        { status: 401 },
      );
    }
    const verified = await verifySessionToken(token);
    if (!verified) {
      return NextResponse.json(
        { ok: false, error: "Session expired or revoked" },
        { status: 401 },
      );
    }

    const body = await request.json().catch(() => null);
    const { id, all } = (body ?? {}) as { id?: string; all?: boolean };

    let revoked: number;
    if (all) {
      revoked = await revokeAllSessions(verified.wallet);
      log("info", "sessions_revoked_all", {
        wallet: verified.wallet,
        count: revoked,
      });
    } else if (typeof id === "string" && id) {
      const ok = await revokeSession(verified.wallet, id);
      if (!ok) {
        return NextResponse.json(
          { ok: false, error: "Session not found" },
          { status: 404 },
        );
      }
      revoked = 1;
      log("info", "session_revoked", { wallet: verified.wallet });
    } else {
      return NextResponse.json(
        { ok: false, error: "Provide a session id, or all: true" },
        { status: 400 },
      );
    }

    const res = NextResponse.json({ ok: true, revoked });
    if (all) {
      // Signing out everywhere ends this session too.
      res.cookies.set(sessionCookie("revoked", 0));
    }
    return res;
  } catch (err: unknown) {
    return safeErrorResponse(err, "session_revoke_failed");
  }
}
