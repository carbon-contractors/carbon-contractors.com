/**
 * bytecode-selector.mjs — is a 4-byte function or error selector embedded in deployed code?
 *
 * Extracted from verify-escrow-deployment.mjs so it can be tested. The obvious version,
 * `code.includes(selector)`, misses some selectors, and it misses them in the bad
 * direction: it reports a correct deployment as lacking the check.
 *
 * The compiler does not always push a selector as its own four bytes. Measured 2026-10-12
 * on CarbonEscrow (solc 0.8.24, viaIR, runs 1000): `PlatformCannotBeParty(address)` is
 * 0x1736efb2, which ends in a zero bit, and the optimiser builds `selector << 224` as
 *
 *     63 0b9b77d9   PUSH4 0x0b9b77d9   (the selector >> 1)
 *     60 e1         PUSH1 225
 *     1b            SHL
 *
 * so the string 1736efb2 appears nowhere in the code. `InvalidState(uint8,uint8)` is built
 * the same way. Dispatcher selectors and most error selectors do appear verbatim.
 *
 * Corroborating evidence only, as before: four bytes in ~10KB can collide.
 */

import { toFunctionSelector } from "viem";

/**
 * @param {string} code deployed bytecode, 0x-prefixed hex
 * @param {string} signature e.g. "releaseAfterArbitration(bytes32)" or "PlatformCannotBeParty(address)"
 * @returns {boolean}
 */
export function selectorInBytecode(code, signature) {
  const hex = code.toLowerCase();
  const selector = toFunctionSelector(signature).slice(2);
  if (hex.includes(selector)) return true;

  // PUSHn (selector >> k), PUSH1 (224 + k), SHL — for each k the selector's trailing zero
  // bits allow. PUSHn is 0x5f + n.
  const value = BigInt(`0x${selector}`);
  for (let k = 1; k < 32 && (value & ((1n << BigInt(k)) - 1n)) === 0n; k++) {
    const shifted = (value >> BigInt(k)).toString(16);
    const width = Math.ceil(shifted.length / 2);
    const push = (0x5f + width).toString(16);
    const pattern = `${push}${shifted.padStart(width * 2, "0")}60${(224 + k).toString(16)}1b`;
    if (hex.includes(pattern)) return true;
  }
  return false;
}
