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
