/**
 * route.ts — /api/reputation
 *
 * GET /api/reputation?wallet=0x...
 * Returns computed reputation score, task history, stake data, and score breakdown.
 */

import { NextRequest } from "next/server";
import { getFullReputation } from "@/lib/reputation";
import { safeErrorResponse } from "@/lib/errors";

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
    return NextResponse.json({ ok: true, reputation });
  } catch (err: unknown) {
    return safeErrorResponse(err, "reputation_fetch_error", { wallet });
  }
}
