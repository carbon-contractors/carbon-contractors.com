/**
 * display.ts — client-side parse of a task's acceptance_spec for the dashboard
 * (NOR-323, CC-101).
 *
 * Mirrors `parseAndHashSpec`'s validation order exactly, minus the hash. The
 * hash preimage is the agent's verbatim string (CC-084) and the worker's
 * browser never recomputes it. What this file guarantees is narrower and just
 * as load-bearing: the rows a worker reads before accepting are formatted from
 * a spec that validates against the same schema the checker will run at verdict
 * time. Display-side validation looser than the checker's would show a worker a
 * deal the checker can fail them on.
 */

import {
  MAX_SPEC_BYTES,
  SUPPORTED_SPEC_VERSIONS,
  schemaForVersion,
} from "./schema";
import { formatSpecForDisplay, type CriteriaRow } from "./format";

/** A spec either renders as rows, or says plainly why it could not. */
export type SpecDisplay =
  | { ok: true; rows: CriteriaRow[] }
  | { ok: false; reason: string };

/**
 * Parse a task's stored acceptance_spec for display.
 *
 * A null/absent spec is not an error: it renders exactly like a spec with no
 * criteria (`formatSpecForDisplay(null)`), because the consequence for the
 * worker is the same one — nothing a verdict can fail against, so payment
 * cannot be withheld for quality (ADR-0001). A spec that is present but does
 * not validate is a different thing entirely and must say so, not impersonate
 * "no criteria".
 */
export function parseSpecForDisplay(
  raw: string | null | undefined,
): SpecDisplay {
  if (raw == null || raw === "") {
    return { ok: true, rows: formatSpecForDisplay(null) };
  }
  if (raw.length > MAX_SPEC_BYTES) {
    return { ok: false, reason: `exceeds ${MAX_SPEC_BYTES} characters` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "not a JSON object" };
  }

  const version = (parsed as Record<string, unknown>).schema_version;
  if (typeof version !== "number") {
    return { ok: false, reason: "no numeric schema_version" };
  }
  const schema = schemaForVersion(version);
  if (!schema) {
    return {
      ok: false,
      reason: `unsupported schema_version ${version} (supported: ${SUPPORTED_SPEC_VERSIONS.join(", ")})`,
    };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: "does not match its declared schema" };
  }
  return { ok: true, rows: formatSpecForDisplay(result.data) };
}
