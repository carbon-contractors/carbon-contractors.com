/**
 * instrumentation.ts — CC-040, ADR-0003 handover step 6: "error alerting wired up".
 *
 * Next's `onRequestError` fires whenever a render, route handler or server action
 * throws past its own try/catch — the uncaught tail of every request. Until this file
 * existed, those errors appeared in Vercel's log viewer and nowhere else: readable by
 * hand, alerting nobody, which is exactly the gap CC-040 was written to close ("a
 * Vercel log drain or Sentry, not just logs existing to be read manually").
 *
 * What this does with them: one structured `error_alert` line to stdout (picked up by
 * the same Vercel log aggregation the Wazuh-compatible logger feeds), plus a relay to
 * the ops webhook (MONITOR_WEBHOOK_URL) — the same channel the invariant monitors
 * alert on, per ADR-0003 D5: webhook first, no paid alerting vendor, no new SDK.
 *
 * Sentry was considered and deliberately not used: the dependency freeze (PO directive)
 * forbids adding the SDK, and every property this needs — sampling, dedup, routing to
 * a channel someone reads — is achievable with the webhook that already exists. The
 * relay IS the log drain; it runs where the logs are produced.
 *
 * ## Noise control, because alert fatigue is ADR-0003's own named failure mode
 *
 * CC-104 measured 32 red monitor runs, zero breaches — most were public-endpoint rate
 * limiting. An error channel that pages for every 404 would be muted before the first
 * real incident. So:
 *
 *   • 4xx never alert. A client error is not an operational signal; a scanner hitting
 *     a dead path is Tuesday. It is logged (structure above), not relayed.
 *   • Dedup window: identical (event, route, digest) tuples relay at most once per
 *     ALERT_DEDUP_MS (default 30 min). A tight retry loop must not page 400 times.
 *     The window is in-memory only — per lambda instance — so the bound is
 *     "per instance", not global. That is the honest limit of a stateless relay and
 *     it is stated here rather than hidden: worst case is one alert per warm
 *     instance per window, which is bounded and visible, not silent.
 *   • Never throws. An alerting path that can take down the request it observes is
 *     strictly worse than no alerting path.
 *
 * ## Privacy (CC-009 / ADR-0002 D9)
 *
 * The relay carries the error class, the route, and a short digest — never the error
 * message itself, which can embed user input, task content, or a Supabase error body.
 * The structured log line carries the message through the existing logger, whose
 * masking is the reviewed path for that (src/lib/logging.ts).
 */

import { createHash } from "node:crypto";
import { log } from "@/lib/logging";

export async function register(): Promise<void> {
  // Deliberately nothing. `register()` is required for the module to be loaded at all;
  // the error hook needs no setup and must not acquire resources (no client, no timer)
  // that would keep a serverless instance warm or leak across requests.
}

const ALERT_DEDUP_MS = Number(process.env.ALERT_DEDUP_MS ?? 30 * 60 * 1000);

/** Fires when any request fails past its own error handling. */
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
  context: { routerKind: string; routePath: string; routeType: string },
): Promise<void> {
  // Route handlers that already responded via safeErrorResponse still surface here when
  // something throws after the response — but the common "handled 4xx/500" paths in this
  // codebase catch internally and never reach onRequestError. What reaches here is the
  // uncaught tail, which is precisely what CC-040 wanted alerted.
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "UnknownError";
  const route = context.routePath || request.path || "unknown";

  // Everything goes to the structured log via the masking-aware logger (CC-009 /
  // ADR-0002 D9) — wallet-shaped values in route paths or error metadata are masked
  // before they reach stdout, which is the reviewed path for that.
  log("error", "request_error_uncaught", {
    error_name: name,
    route,
    route_type: context.routeType,
    method: request.method,
    // Hash, not message: the webhook is a chat channel, and a digest is enough to
    // correlate with the log line above without shipping message content out.
    digest: createHash("sha256").update(`${name}:${route}`).digest("hex").slice(0, 16),
    error: message,
  });

  if (!process.env.MONITOR_WEBHOOK_URL) return; // relay unconfigured — log-only mode
  await relayAlert(route, context.routeType, name);
}

const recentAlerts = new Map<string, number>();

async function relayAlert(route: string, routeType: string, errorName: string): Promise<void> {
  const webhookUrl = process.env.MONITOR_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    const key = `${errorName}:${route}`;
    const now = Date.now();
    const last = recentAlerts.get(key) ?? 0;
    if (now - last < ALERT_DEDUP_MS) return;
    recentAlerts.set(key, now);

    // Bound the map. A long-lived instance could otherwise accumulate one entry per
    // distinct error/route pair forever; 256 recent entries is far beyond any real
    // alerting surface and keeps the dedup memory O(bounded).
    if (recentAlerts.size > 256) {
      const oldest = [...recentAlerts.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k] of oldest.slice(0, oldest.length - 128)) recentAlerts.delete(k);
    }

    const body =
      `Carbon Contractors application error — ${errorName} on ${route} (${routeType})\n` +
      `See the Vercel log for the full structured line (event request_error_uncaught).`;

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: body.slice(0, 1900) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Never throw. A failed relay is logged, not raised — the same containment rule
      // as src/lib/notifications/delivery.ts: alerting is a side effect of the request,
      // never part of it.
      console.log(
        JSON.stringify({ level: "warn", event: "error_alert_relay_failed", ts: Date.now(), status: res.status }),
      );
    }
  } catch (err) {
    console.log(
      JSON.stringify({
        level: "warn",
        event: "error_alert_relay_failed",
        ts: Date.now(),
        error: err instanceof Error ? err.name : String(err),
      }),
    );
  }
}
