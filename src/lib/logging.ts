/**
 * logging.ts
 * Wazuh-compatible structured JSON logger.
 * All output is single-line JSON to stdout for log aggregation.
 *
 * Sanitization & Privacy (CC-009 / ADR-0002 D9):
 * - Wallet addresses are masked (0x1234...cdef)
 * - Email addresses are masked (a***n@domain.com)
 * - Raw task payload fields (task_description, acceptance_spec, evidence_bundle, etc.)
 *   are automatically redacted so they never leak into log streams.
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
 * Mask an email address for log output.
 * "alice@example.com" → "a***e@example.com"
 * "me@domain.com" → "m***e@domain.com"
 * "a@b.com" → "a***@b.com"
 */
export function maskEmail(email: string): string {
  const atIndex = email.lastIndexOf("@");
  if (atIndex <= 0) return email;

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);

  if (local.length === 1) {
    return `${local}***@${domain}`;
  }
  if (local.length === 2) {
    return `${local[0]}***${local[1]}@${domain}`;
  }
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WALLET_REGEX = /^0x[0-9a-fA-F]{40}$/;

const REDACTED_PAYLOAD_KEYS = new Set([
  "task_description",
  "acceptance_spec",
  "evidence_bundle",
  "spec_json",
  "spec",
  "evidence",
]);

/**
 * Recursively sanitize and mask metadata objects:
 * - Wallet addresses masked
 * - Email addresses masked
 * - Task payload content redacted
 */
export function maskMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    const lowerKey = key.toLowerCase();

    if (REDACTED_PAYLOAD_KEYS.has(lowerKey)) {
      masked[key] = "[REDACTED_PAYLOAD]";
      continue;
    }

    if (typeof value === "string") {
      if (WALLET_REGEX.test(value)) {
        masked[key] = maskWallet(value);
      } else if (EMAIL_REGEX.test(value)) {
        masked[key] = maskEmail(value);
      } else {
        masked[key] = value;
      }
    } else if (Array.isArray(value)) {
      masked[key] = value.map((item) => {
        if (typeof item === "string") {
          if (WALLET_REGEX.test(item)) return maskWallet(item);
          if (EMAIL_REGEX.test(item)) return maskEmail(item);
          return item;
        }
        if (item !== null && typeof item === "object") {
          return maskMeta(item as Record<string, unknown>);
        }
        return item;
      });
    } else if (value !== null && typeof value === "object") {
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
