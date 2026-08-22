/**
 * http.ts (CC-095)
 * Single-attempt JSON POST with a hard timeout, returning a sanitised result.
 *
 * The result never carries an upstream error message or URL. A thrown fetch error
 * embeds its destination ("Failed to fetch https://…"), and a channel address is
 * either a worker's email or a URL with a credential in it (CC-009, CC-095). So an
 * outcome is classified here — ok / transient / permanent, plus a bare status code —
 * and only the classification travels onwards. Nothing downstream ever needs the
 * message; something needs to *retry* it or *report* it.
 */

export interface HttpResult {
  ok: boolean;
  /** HTTP status code, when the server answered at all. */
  status?: number;
  /** Sanitised failure code. */
  error?: string;
  /** Whether a retry is worthwhile: 5xx, 429, timeout, or a network fault. */
  transient: boolean;
}

export function classifyStatus(status: number): HttpResult {
  const ok = status >= 200 && status < 300;
  const transient = status === 429 || status >= 500;
  return ok
    ? { ok, status, transient }
    : { ok, status, transient, error: `http_${status}` };
}

/**
 * POST `body` as JSON to `url`, giving up after `timeoutMs`.
 * Network faults and timeouts are classified transient — both clear on retry, and
 * a 4xx answer from a worker's own endpoint is permanent.
 */
export async function postJson(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      signal: controller.signal,
    });
    return classifyStatus(res.status);
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      transient: true,
      error: aborted ? "timeout" : "network_error",
    };
  } finally {
    clearTimeout(timer);
  }
}
