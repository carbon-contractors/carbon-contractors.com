/**
 * logging.ts
 * Wazuh-compatible structured JSON logger.
 * All output is single-line JSON to stdout for log aggregation.
 */

type LogLevel = "info" | "warn" | "error";

/**
 * Mask a wallet address for log output.
 * "0x1234567890abcdef..." → "0x1234...cdef"
 */
export function maskWallet(address: string): string {
  if (address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Recursively mask any string value that looks like a wallet address
 * (0x followed by 40 hex chars) in a metadata object.
 */
function maskMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
      masked[key] = maskWallet(value);
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      masked[key] = maskMeta(value as Record<string, unknown>);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

export function log(
  level: LogLevel,
  event: string,
  meta?: Record<string, unknown>,
): void {
  const sanitized = meta ? maskMeta(meta) : undefined;
  console.log(JSON.stringify({ level, event, ts: Date.now(), ...sanitized }));
}
