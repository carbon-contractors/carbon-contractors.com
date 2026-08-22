/**
 * verdict-json.ts — the wire shape of a signed verdict (CC-092).
 *
 * Every surface that hands a verdict to a caller — /api/verdict, /api/dispute,
 * the get_signed_verdict MCP tool — serialises it the same way, and the worker
 * dashboard parses it back the same way before handing it to
 * claimWithVerdict/disputeTask. BigInts become strings (JSON has no bigint);
 * expiry and nonce come back as BigInt so the tuple encodes as uint256.
 *
 * Client-safe by construction: the only import from verdict.ts is a type,
 * which is erased at compile time, so this module carries none of the
 * server-side signer machinery with it into the browser bundle.
 */

import type { Verdict } from "./verdict";

export interface SerializedVerdict {
  taskId: string;
  specHash: string;
  evidenceHash: string;
  checkerHash: string;
  passed: boolean;
  breakdownHash: string;
  expiry: string;
  nonce: string;
}

export function serializeVerdict(verdict: Verdict): SerializedVerdict {
  return {
    taskId: verdict.taskId,
    specHash: verdict.specHash,
    evidenceHash: verdict.evidenceHash,
    checkerHash: verdict.checkerHash,
    passed: verdict.passed,
    breakdownHash: verdict.breakdownHash,
    expiry: verdict.expiry.toString(),
    nonce: verdict.nonce.toString(),
  };
}

const HASH_BYTES = /^0x[0-9a-fA-F]{64}$/;

/**
 * Parse a verdict from a JSON payload (/api/verdict, /api/dispute) back into
 * the `Verdict` a contract call needs.
 *
 * @throws {Error} if the payload is not a well-formed verdict. Callers should
 *   treat that as a protocol fault, not user input to fix.
 */
export function parseVerdictPayload(raw: unknown): Verdict {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("verdict payload is not an object");
  }
  const v = raw as Record<string, unknown>;

  for (const field of ["taskId", "specHash", "evidenceHash", "checkerHash", "breakdownHash"] as const) {
    if (typeof v[field] !== "string" || !HASH_BYTES.test(v[field] as string)) {
      throw new Error(`verdict field ${field} is not a bytes32 hash`);
    }
  }
  if (typeof v.passed !== "boolean") {
    throw new Error("verdict field passed is not a boolean");
  }
  if (typeof v.expiry !== "string" || !/^\d+$/.test(v.expiry)) {
    throw new Error("verdict field expiry is not a uint256 string");
  }
  if (typeof v.nonce !== "string" || !/^\d+$/.test(v.nonce)) {
    throw new Error("verdict field nonce is not a uint256 string");
  }

  return {
    taskId: v.taskId as `0x${string}`,
    specHash: v.specHash as `0x${string}`,
    evidenceHash: v.evidenceHash as `0x${string}`,
    checkerHash: v.checkerHash as `0x${string}`,
    passed: v.passed,
    breakdownHash: v.breakdownHash as `0x${string}`,
    expiry: BigInt(v.expiry),
    nonce: BigInt(v.nonce),
  };
}

/** The tuple shape the escrow ABI's claimWithVerdict/disputeTask expect. */
export function verdictTupleForContract(verdict: Verdict) {
  return {
    taskId: verdict.taskId,
    specHash: verdict.specHash,
    evidenceHash: verdict.evidenceHash,
    checkerHash: verdict.checkerHash,
    passed: verdict.passed,
    breakdownHash: verdict.breakdownHash,
    expiry: verdict.expiry,
    nonce: verdict.nonce,
  };
}
