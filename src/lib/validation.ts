/**
 * validation.ts
 * Shared input validation utilities.
 */

const WALLET_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Returns true if the string is a valid 0x-prefixed 40-hex-char Ethereum address. */
export function isValidWalletAddress(addr: string): boolean {
  return typeof addr === "string" && WALLET_ADDRESS_RE.test(addr);
}
