/**
 * route.ts — /api/reputation
 *
 * GET /api/reputation?wallet=0x...
 * Returns computed reputation score, task history, stake data, and score breakdown.
 *
 * build probe cc-040 (2026-09-16): comment-only change to force a non-cached
 * Vercel preview build; no executable change; safe to delete.
 */

import { NextRequest, NextResponse } from "next/server";
import { getFullReputation } from "@/lib/reputation";
import { listSlashRecords } from "@/lib/db/slashes";
import { safeErrorResponse } from "@/lib/errors";

// build probe cc-040 (2026-09-16): exported constant forces a real (non-cached)
// Vercel build — executable surface change on master's tree; safe to delete.
export const PROBE_BUILD_FORCED = true;

export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet");

  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return NextResponse.json(
      { ok: false, error: "Valid wallet address required (?wallet=0x...)" },
      { status: 400 }
    );
  }

  try {
    const reputation = await getFullReputation(wallet);
    // NOR-330: the resolution-time records that explain the on-chain slashed
    // total — the chain says how much was slashed, not why.
    const slashes = await listSlashRecords(wallet);
    return NextResponse.json({ ok: true, reputation, slashes });
  } catch (err: unknown) {
    return safeErrorResponse(err, "reputation_fetch_error", { wallet });
  }
}
