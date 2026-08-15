import { getSupabase } from "@/lib/db/client";
import { getTotalLocked, getEscrowConfig } from "@/lib/contracts/escrow";
import { getSessionCount } from "@/lib/mcp/session-count";

const startTime = Date.now();

interface HealthCheck {
  ok: boolean;
  latency_ms?: number;
  error?: string;
  count?: number;
  /** Which escrow this deployment is actually talking to. See the note at the call site. */
  address?: string;
  chain?: string;
  total_locked?: string;
}

export async function GET(): Promise<Response> {
  const checks: Record<string, HealthCheck> = {};

  // 1. Supabase connectivity
  const dbStart = Date.now();
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from("humans").select("id").limit(1);
    checks.database = { ok: !error, latency_ms: Date.now() - dbStart };
    if (error) checks.database.error = error.message;
  } catch (err) {
    checks.database = {
      ok: false,
      latency_ms: Date.now() - dbStart,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 2. Escrow contract read (if configured)
  //
  // Reports *which* escrow and how much it holds, not just that a call succeeded.
  //
  // This used to return a bare `ok: true`. That is not a health check — every version of
  // the contract has a `totalLocked()`, so the call succeeds against the right escrow and
  // the wrong one identically. After the CC-082 redeploy there was no way, from outside,
  // to tell whether production had picked up the new `NEXT_PUBLIC_ESCROW_CONTRACT` or was
  // still reading the old contract: the coming-soon gate keeps the inlined value out of
  // every served bundle, and health answered `ok: true` either way.
  //
  // "Pointed at the wrong escrow" is exactly the ADR-0003 failure class — nothing errors,
  // everything reports healthy, and every read is against the wrong contract. So the
  // identifying facts go in the response. Both are public on-chain data; neither is a
  // secret, and `NEXT_PUBLIC_ESCROW_CONTRACT` is a client-inlined value by definition.
  const escrowConfig = getEscrowConfig();
  if (escrowConfig.address) {
    const chainStart = Date.now();
    const identity = {
      address: escrowConfig.address,
      chain: `${escrowConfig.chainName} (${escrowConfig.chainId})`,
    };
    try {
      const totalLocked = await getTotalLocked();
      checks.escrow_contract = {
        ok: true,
        latency_ms: Date.now() - chainStart,
        ...identity,
        total_locked: totalLocked.toString(),
      };
    } catch (err) {
      checks.escrow_contract = {
        ok: false,
        latency_ms: Date.now() - chainStart,
        ...identity,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  } else {
    // Previously this branch was silently absent from the response, so a deployment with
    // no escrow configured was indistinguishable from a healthy one.
    checks.escrow_contract = {
      ok: false,
      error: "NEXT_PUBLIC_ESCROW_CONTRACT is not set",
    };
  }

  // 3. Session count
  checks.sessions = { ok: true, count: getSessionCount() };

  const allOk = Object.values(checks).every((c) => c.ok);

  return Response.json(
    {
      ok: allOk,
      version: "0.1.0",
      uptime_ms: Date.now() - startTime,
      checks,
    },
    { status: allOk ? 200 : 503 }
  );
}
