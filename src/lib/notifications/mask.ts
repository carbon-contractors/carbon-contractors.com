/**
 * mask.ts (CC-095)
 * Masking for channel addresses in log output.
 *
 * `maskMeta` in logging.ts masks wallet addresses, not emails (CC-009) — and this
 * path handles emails by definition. A channel address is either a worker's email,
 * a Telegram chat id, or a URL with an embedded credential (webhook secret path,
 * Discord token). None of those may reach a log line, so every address is reduced
 * to a deterministic sha256 handle instead of trying to mask "just the right part".
 * The handle is stable per address, so log lines can still be correlated.
 */

import { createHash } from "node:crypto";
import { maskWallet } from "@/lib/logging";

/**
 * A non-reversible handle for log output: first 12 hex chars of sha256.
 * Wallet-shaped values keep the familiar 0x1234...cdef form.
 */
export function maskChannelAddress(address: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return maskWallet(address);
  }
  const digest = createHash("sha256").update(address).digest("hex");
  return `#${digest.slice(0, 12)}`;
}
