/**
 * hash.ts — the specHash preimage (CC-084, ADR-0001 D4).
 *
 * ## Why the agent sends a string and we hash it verbatim
 *
 * `specHash` has to be computed identically by three parties: the platform (stores
 * it), the hiring agent (passes it to `createTask`), and the worker (verifies it,
 * then echoes it as `specVersionAck` at `submitWork`, which reverts `SpecAckMismatch`
 * on any difference). Three implementations that must agree byte-for-byte forever is
 * where a design like this goes wrong.
 *
 * So there is no canonicalisation step. **The preimage is the bytes the agent sent.**
 * Zod validates the shape; the stored and hashed value is the original string,
 * untouched. Two semantically identical specs with different key order hash
 * differently — which is fine, they are different tasks — and in exchange nobody ever
 * has to reproduce our serialiser.
 *
 * The rejected alternative was accepting an object and canonicalising server-side
 * (RFC 8785 / JCS). Float serialisation — `lat`, `lon`, `threshold` — is the classic
 * divergence source, and a worker verifying the hash would have to reimplement our
 * canonicaliser exactly. That bug class only ever surfaces as a task nobody can claim.
 *
 * `keccak256(toHex(…))` matches the existing idiom — see `toTaskId` in
 * `src/lib/contracts/escrow.ts`.
 */

import { keccak256, toHex } from "viem";
import {
  schemaForVersion,
  hasNoCriteria,
  MAX_SPEC_BYTES,
  SUPPORTED_SPEC_VERSIONS,
  type AcceptanceSpec,
} from "./schema";

export class SpecValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecValidationError";
  }
}

export interface ParsedSpec {
  /** The verbatim string the agent sent. This, and only this, is the hash preimage. */
  preimage: string;
  /** `keccak256(toHex(preimage))` — what goes on chain as `specHash`. */
  hash: `0x${string}`;
  version: number;
  /** Validated, for display to the worker and for the checker (CC-083). */
  spec: AcceptanceSpec;
  /** Spec is well-formed but commits to nothing checkable — see `hasNoCriteria`. */
  hasNoCriteria: boolean;
}

/** Hash an already-validated preimage. Exported so tests can pin known vectors. */
export function hashSpecPreimage(preimage: string): `0x${string}` {
  return keccak256(toHex(preimage));
}

/**
 * Parse, validate and hash an acceptance spec.
 *
 * @param raw The exact JSON string supplied by the hiring agent.
 * @throws {SpecValidationError} on anything malformed — never returns a partial result.
 */
export function parseAndHashSpec(raw: string): ParsedSpec {
  if (raw.length > MAX_SPEC_BYTES) {
    throw new SpecValidationError(
      `acceptance_spec exceeds ${MAX_SPEC_BYTES} characters`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SpecValidationError("acceptance_spec is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SpecValidationError("acceptance_spec must be a JSON object");
  }

  const version = (parsed as Record<string, unknown>).schema_version;
  if (typeof version !== "number") {
    throw new SpecValidationError(
      "acceptance_spec must carry a numeric schema_version",
    );
  }

  // Dispatch before validating, so an unknown version reports itself as such rather
  // than as a pile of field errors from whichever schema happened to be tried.
  const schema = schemaForVersion(version);
  if (!schema) {
    throw new SpecValidationError(
      `unsupported schema_version ${version} (supported: ${SUPPORTED_SPEC_VERSIONS.join(", ")})`,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new SpecValidationError(`acceptance_spec is invalid — ${detail}`);
  }

  return {
    preimage: raw,
    hash: hashSpecPreimage(raw),
    version,
    spec: result.data,
    hasNoCriteria: hasNoCriteria(result.data),
  };
}
