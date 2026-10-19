/**
 * webhook-target.ts (CC-108)
 * Where a worker-registered webhook may point, and the one transport allowed to
 * reach it.
 *
 * A webhook address is chosen by the worker and fetched by the platform, so it is a
 * server-side request to an arbitrary destination. Three rules hold it:
 *
 * 1. **Public unicast only, by resolved address.** A hostname check alone is not
 *    enough — `hooks.example.com` can resolve to 10.0.0.5 — so the check runs on
 *    every address the name resolves to, and fails if any one is private.
 * 2. **Checked at connect time, not before it.** `postJsonToWebhook` hands Node a
 *    `lookup` that validates the addresses it is about to connect to. Validating
 *    in a separate lookup and then calling `fetch` would let a short-TTL record
 *    answer public to the check and private to the connection (DNS rebinding).
 * 3. **No redirects, port 443 only.** A public URL that 302s to an internal one
 *    would bypass both checks; `https.request` never follows redirects, so a 3xx
 *    is just a failed delivery. 443 is where every hosted webhook receiver lives,
 *    and a non-standard port is the usual shape of a probe for an internal service.
 *
 * Registration (`/api/channels`, MCP `register_notification_channel`) runs
 * `resolveWebhookTarget` for a clear rejection message; delivery runs the
 * connect-time guard regardless, because rows written before CC-108 still exist.
 */

import { BlockList, isIP } from "node:net";
import dns from "node:dns";
import https from "node:https";
import { classifyStatus, type HttpResult } from "./http";

const BLOCKED = new BlockList();
// IPv4: this-network, RFC1918, CGNAT, loopback, link-local (cloud metadata),
// IETF protocol assignments, TEST-NETs, benchmarking, multicast, reserved, broadcast.
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
// IPv6: unspecified, loopback, discard, documentation, unique-local, link-local, multicast.
// IPv4-mapped and NAT64 addresses are unwrapped below and judged as IPv4.
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

/** The IPv4 address embedded in an IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::) address. */
function embeddedIpv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  for (const prefix of ["::ffff:", "64:ff9b::"]) {
    if (!lower.startsWith(prefix)) continue;
    const rest = lower.slice(prefix.length);
    if (isIP(rest) === 4) return rest;
    // Hex form, e.g. ::ffff:7f00:1
    const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (m) {
      const hi = parseInt(m[1], 16);
      const lo = parseInt(m[2], 16);
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
  }
  return null;
}

/** Whether `ip` is anything other than public unicast. Unparseable counts as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return BLOCKED.check(ip, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(ip);
    if (v4) return BLOCKED.check(v4, "ipv4");
    return BLOCKED.check(ip, "ipv6");
  }
  return true;
}

export type WebhookTargetRejection =
  | "not_https"
  | "port_not_allowed"
  | "internal_hostname"
  | "private_address"
  | "unresolvable";

export type WebhookTargetCheck = { ok: true } | { ok: false; reason: WebhookTargetRejection };

/** Names that never resolve to a public receiver, whatever DNS says. */
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/** The URL-only half: scheme, port, and literal hosts. No DNS. */
export function checkWebhookUrl(raw: string): WebhookTargetCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not_https" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.port !== "" && url.port !== "443") return { ok: false, reason: "port_not_allowed" };

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: "internal_hostname" };
  }
  if (isIP(host) !== 0 && isBlockedAddress(host)) {
    return { ok: false, reason: "private_address" };
  }
  return { ok: true };
}

type LookupAll = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultLookupAll: LookupAll = (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * The full registration-time check: the URL rules, then every address the host
 * resolves to. A host that does not resolve is rejected — a webhook nobody can
 * reach is a registration mistake worth reporting now, not at the first hire.
 */
export async function resolveWebhookTarget(
  raw: string,
  lookupAll: LookupAll = defaultLookupAll,
): Promise<WebhookTargetCheck> {
  const urlCheck = checkWebhookUrl(raw);
  if (!urlCheck.ok) return urlCheck;

  const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return { ok: true };

  let addresses: { address: string }[];
  try {
    addresses = await lookupAll(host);
  } catch {
    return { ok: false, reason: "unresolvable" };
  }
  if (addresses.length === 0) return { ok: false, reason: "unresolvable" };
  if (addresses.some((a) => isBlockedAddress(a.address))) {
    return { ok: false, reason: "private_address" };
  }
  return { ok: true };
}

/** User-facing copy for a rejection, shared by both registration surfaces. */
export const WEBHOOK_REJECTION_MESSAGES: Record<WebhookTargetRejection, string> = {
  not_https: "Webhook must be an https:// URL.",
  port_not_allowed: "Webhook must use the standard HTTPS port (443).",
  internal_hostname: "Webhook must point at a public host, not a local or internal name.",
  private_address:
    "Webhook host resolves to a private, loopback or reserved address. Use a publicly reachable endpoint.",
  unresolvable: "Webhook host could not be resolved. Check the URL and try again.",
};

/** Error code the guarded lookup raises, so the transport can tell a refusal from a network fault. */
export const BLOCKED_TARGET_CODE = "ECC108BLOCKED";

type NodeLookup = typeof dns.lookup;

/**
 * A `lookup` for `https.request` that refuses to hand back any blocked address.
 * Node calls it with `all: true` when autoSelectFamily is on and without it
 * otherwise; both shapes are honoured, and both resolve every address so that
 * one private record among public ones is still caught.
 */
export function createGuardedLookup(base: NodeLookup = dns.lookup): NodeLookup {
  const guarded = (
    hostname: string,
    options: dns.LookupOptions | number | ((...args: unknown[]) => void),
    callback?: (...args: unknown[]) => void,
  ) => {
    const cb = (typeof options === "function" ? options : callback)!;
    const opts: dns.LookupOptions =
      typeof options === "object" && options !== null
        ? options
        : typeof options === "number"
          ? { family: options }
          : {};
    base(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return cb(err);
      const list = addresses as dns.LookupAddress[];
      if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
        const blocked = Object.assign(new Error("webhook target resolves to a blocked address"), {
          code: BLOCKED_TARGET_CODE,
        });
        return cb(blocked);
      }
      if (opts.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
  return guarded as unknown as NodeLookup;
}

/**
 * POST `body` to a worker-registered webhook. The same sanitised `HttpResult` as
 * `postJson`, with one extra permanent outcome: `blocked_target`, for a URL that
 * fails the rules above at send time. Never follows a redirect.
 */
export function postJsonToWebhook(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<HttpResult> {
  if (!checkWebhookUrl(url).ok) {
    return Promise.resolve({ ok: false, transient: false, error: "blocked_target" });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HttpResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const req = https.request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body).toString(),
        ...headers,
      },
      lookup: createGuardedLookup(),
    });
    // A hard cap on the whole exchange, like postJson's abort — the socket
    // `timeout` option only measures idleness.
    const timer = setTimeout(() => {
      finish({ ok: false, transient: true, error: "timeout" });
      req.destroy();
    }, timeoutMs);
    req.on("response", (res) => {
      res.resume(); // drain; only the status matters
      finish(classifyStatus(res.statusCode ?? 0));
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      finish(
        err.code === BLOCKED_TARGET_CODE
          ? { ok: false, transient: false, error: "blocked_target" }
          : { ok: false, transient: true, error: "network_error" },
      );
    });
    req.end(body);
  });
}
