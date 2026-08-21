/**
 * validation.ts
 * Shared input validation utilities.
 */

const WALLET_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Returns true if the string is a valid 0x-prefixed 40-hex-char Ethereum address. */
export function isValidWalletAddress(addr: string): boolean {
  return typeof addr === "string" && WALLET_ADDRESS_RE.test(addr);
}

// Linear-time email check: no nested quantifiers, max 254 chars (RFC 5321)
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
export const MAX_EMAIL_LEN = 254;

/** Returns true if the string is a plausible, boundedly-checked email address. */
export function isValidEmail(email: string): boolean {
  return (
    typeof email === "string" &&
    email.length > 0 &&
    email.length <= MAX_EMAIL_LEN &&
    EMAIL_RE.test(email)
  );
}

/**
 * CC-022: the `rate_usdc` column is NUMERIC(10,2), so anything above
 * 99,999,999.99 throws a 500 and more than two decimal places is silently
 * rounded. Rather than the column's ceiling, we bound rates to a sane
 * hourly maximum — no real hourly rate reaches five figures in USDC.
 */
export const MAX_RATE_USDC = 10_000;

/**
 * CC-022: validates a rate_usdc value (number, as it appears in the signed
 * registration payload). Returns a user-facing error message, or null if valid.
 * Shared by the server route and the /connect client so both reject identically.
 */
export function rateUsdcError(value: number): string | null {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "Hourly rate must be a number.";
  }
  if (!Number.isFinite(value)) {
    return "Hourly rate is too large.";
  }
  if (value <= 0) {
    return "Hourly rate must be greater than zero.";
  }
  if (value > MAX_RATE_USDC) {
    return `Hourly rate cannot exceed ${MAX_RATE_USDC.toLocaleString("en-AU")} USDC.`;
  }
  // At most 2 decimal places (NUMERIC(10,2)). The tolerance absorbs IEEE-754
  // noise (10.10 * 100 === 1010.0000000000001) while still rejecting a real
  // third decimal (10.123 * 100 is ~0.3 away from an integer).
  const scaled = value * 100;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    return "Hourly rate supports at most 2 decimal places.";
  }
  return null;
}
