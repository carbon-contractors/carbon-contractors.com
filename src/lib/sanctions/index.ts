/**
 * index.ts — wallet sanctions screening (CC-099).
 *
 * Address-based, not identity-based (ADR-0002 D1 compatible): this checks whether a
 * wallet address appears on a published sanctions list. It never asks who controls the
 * wallet, and nothing about it touches the pseudonymity model.
 *
 * Two layers, in this order:
 *
 *   1. The bundled dataset (data.ts) — always on, no network, no configuration. This
 *      is the control that actually ships; it is what makes the platform's sanctions
 *      posture independent of any vendor's availability.
 *   2. An optional provider API (Chainalysis) when CHAINALYSIS_API_KEY is set —
 *      fail-open with a loud log: if the provider is unreachable, slow, or returns a
 *      shape we do not recognise, the call proceeds and the dataset result stands.
 *      Fail-open is a deliberate choice for the enforcement paths (registration,
 *      task creation): a sanctions false-positive outage takes down the whole intake
 *      path, and the dataset plus the re-screening monitor are the controls that do
 *      not depend on the network. Re-screening (scripts/audit/verify-sanctions.ts)
 *      catches a provider outage as a degraded run rather than as silence.
 *
 * The Chainalysis REST contract is NOT confirmed — its API documentation sits behind
 * an access form, and the on-chain oracle does not support Base (checked 2026-08-18,
 * CC-099). That is why the response parse below is tolerant (any recognisable
 * affirmative field counts, anything else is treated as indeterminate) and why the
 * endpoint is a constant here rather than scattered: when the contract is confirmed,
 * this is the one place to correct.
 *
 * In-memory cache: sanctions lists move slowly and the same wallets recur
 * (registered workers on every hire), so a TTL cache trades list freshness for not
 * screening the same address twice per process. Freshness is the re-screening
 * monitor's job, not the request path's.
 */

import { SANCTIONED_ADDRESS_INDEX } from "@/lib/sanctions/data";
import { getSanctionsConfig, _resetConfig } from "@/lib/config";
import { log } from "@/lib/logging";

export interface SanctionScreen {
  /** True only on a positive match. Absence of a match is not proof of cleanliness. */
  sanctioned: boolean;
  /** Which list matched, e.g. "OFAC SDN" (dataset) or "chainalysis" (provider). */
  list?: string;
  /** Human-readable designation, safe to log — it names the list entry, not the caller. */
  reason?: string;
}

/** Cache lifetime. 6h: long enough to matter per-process, short enough that a
 * re-deployed list or provider answer propagates the same day. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Backstop against unbounded growth on a long-lived process seeing many addresses. */
const CACHE_MAX_ENTRIES = 10_000;

const API_BASE_URL = "https://api.chainalysis.com/api/sanctions/v1/screen/";
const API_TIMEOUT_MS = 5_000;

const cache = new Map<string, { screen: SanctionScreen; expiresAt: number }>();

/** Test-only: clears the screen cache *and* the cached config snapshot, so a
 * test's env changes (a stubbed API key) take effect on the next call. */
export function _resetSanctionsCacheForTests(): void {
  cache.clear();
  _resetConfig();
}

/**
 * Lowercases a wallet address and validates its shape. Returns null for anything that
 * is not `0x` + 40 hex — callers validate their inputs upstream, so a null here means
 * an internal caller changed shape, and screening treats it as unscreenable rather
 * than guessing (an invalid address cannot be on a list, but it also should never
 * have reached this module).
 */
export function normalizeWalletAddress(wallet: string): string | null {
  const normalized = wallet.toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

/**
 * A response is read as a positive match only when it says so affirmatively
 * (`sanctioned: true`, or a non-empty `identifications`/`comment` alongside it).
 * Absence, false, or an unrecognised shape is indeterminate — never a match, and
 * never an error that blocks the caller.
 */
function parseProviderResponse(body: unknown): SanctionScreen | null {
  if (body === null || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.sanctioned === true) {
    return {
      sanctioned: true,
      list: "chainalysis",
      ...(typeof b.comment === "string" ? { reason: b.comment } : {}),
    };
  }
  // Recognised shape, no match — cache the negative so repeat lookups skip the API.
  if (b.sanctioned === false) return { sanctioned: false };
  // Anything else: indeterminate. Not cached (retry next call), not fatal.
  return null;
}

async function screenViaProvider(normalized: string): Promise<SanctionScreen | null> {
  let key: string | undefined;
  try {
    key = getSanctionsConfig().CHAINALYSIS_API_KEY;
  } catch {
    // Config unreadable — same as unconfigured. The dataset layer still applies.
    return null;
  }
  if (!key) return null;

  try {
    const res = await fetch(`${API_BASE_URL}${normalized}`, {
      headers: { "X-API-KEY": key },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 401/403 would mean a bad key — visible here, not swallowed, because a
      // screening layer that silently stopped screening is the failure this
      // module's design is built around.
      log("warn", "sanctions_provider_api_error", {
        status: res.status,
        provider: "chainalysis",
      });
      return null;
    }
    const parsed = parseProviderResponse(await res.json());
    if (parsed === null) {
      // 200 OK with a shape we don't recognise. Logged rather than swallowed: this
      // is the provider's contract drifting from ours, and the screening layer
      // quietly degrading to dataset-only is precisely the failure to make visible.
      log("warn", "sanctions_provider_api_error", {
        provider: "chainalysis",
        error: "unrecognised response shape",
      });
    }
    return parsed;
  } catch (err: unknown) {
    log("warn", "sanctions_provider_api_error", {
      provider: "chainalysis",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Screen a wallet address against sanctions lists. Never throws: every failure mode
 * degrades to "no match found", with the reason in the log stream — an enforcement
 * path that 500s because a sanctions vendor timed out would trade a compliance
 * control for an availability defect, and the dataset layer still runs either way.
 */
export async function isWalletSanctioned(wallet: string): Promise<SanctionScreen> {
  const normalized = normalizeWalletAddress(wallet);
  if (!normalized) {
    // Not screened because it is not an address. Callers validate shape upstream
    // (Zod at the route/tool boundary), so reaching here with garbage is a bug
    // elsewhere — logged, not thrown, for the same never-blocks-INTAKE reason.
    log("warn", "sanctions_screen_invalid_address", { shape: typeof wallet });
    return { sanctioned: false };
  }

  const cached = cache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.screen;

  // Layer 1 — the bundled dataset. Always runs; the always-on control.
  const entry = SANCTIONED_ADDRESS_INDEX.get(normalized);
  if (entry) {
    const screen: SanctionScreen = {
      sanctioned: true,
      list: entry.list,
      reason: entry.reason,
    };
    cache.set(normalized, { screen, expiresAt: Date.now() + CACHE_TTL_MS });
    return screen;
  }

  // Layer 2 — optional provider. A provider match beats "not in dataset"; a provider
  // failure does not beat anything (fail-open, logged above).
  const provider = await screenViaProvider(normalized);
  const screen: SanctionScreen = provider ?? { sanctioned: false };
  if (provider) {
    if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
    cache.set(normalized, { screen, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return screen;
}
