/**
 * attestation/schema.ts — the EAS completion-attestation schema (ADR-0008 D4, CC-036).
 *
 * ## Why this file has no network calls
 *
 * Everything here is derivable offline and deterministic: the schema string, its UID, and
 * the ABI encoding of one attestation's data. That is deliberate — the schema UID is
 * **permanent**, and pinning it as a computed constant means the on-chain registration can
 * be checked against an expected value rather than trusted
 * (`scripts/audit/verify-eas-schema.mjs`).
 *
 * The three facts that are *not* here, because they are external and must not be guessed:
 * the EAS address, the SchemaRegistry address, and the off-chain EIP-712 envelope for the
 * EAS version in use. A wrong EAS address produces attestations to nowhere that look
 * perfectly correct locally — the same class of defect as a wrong USDC address.
 */

import { encodeAbiParameters, encodePacked, keccak256, type Address, type Hex } from "viem";

/**
 * The schema, exactly as it is registered. **Changing any character forks the reputation
 * history**, because the UID below is derived from these bytes — read ADR-0008 D4 before
 * touching it.
 *
 * **Do not reformat it.** No space after a comma, no line wrapping, no `+` concatenation.
 * The string is the identity, not a description of it, so a cosmetic edit is a schema fork.
 * `github-code-quality` has already flagged the comma spacing once, reading it as prose.
 *
 * The worker is the EAS `recipient`, not a field here. That is where EAS puts the subject,
 * and carrying it twice invites the two disagreeing.
 *
 * Nothing task-content-bearing appears, so an attestation survives the `ADR-0002` D4
 * retention deletion without contradicting it: the hashes stay meaningful as commitments
 * once the content behind them is gone.
 */
export const COMPLETION_SCHEMA =
  "bytes32 taskId,address escrow,uint256 chainId,address agent,uint256 amountUsdc,uint8 route,uint64 completedAt,bytes32 specHash,bytes32 evidenceHash,bytes32 verdictHash,bytes32 checkerHash";

/**
 * Non-revocable, per ADR-0008's open item: a completion either happened or it did not, and
 * a revocable reputation record would hand the platform a lever over a worker's history
 * that `ADR-0001` D9 does not otherwise grant it.
 *
 * Load-bearing on the UID — flipping this changes the schema identity.
 */
export const COMPLETION_REVOCABLE = false;

/**
 * No resolver contract. Also load-bearing on the UID, and the reason the same UID appears
 * on Base and Base Sepolia: a resolver would be a per-network address and the two would
 * diverge.
 */
export const COMPLETION_RESOLVER: Address = "0x0000000000000000000000000000000000000000";

/**
 * `CarbonEscrow.CompletionRoute`, mirrored. Appended-to only — the enum is read from
 * events and from this attestation, so renumbering would silently change the meaning of
 * every attestation already issued.
 *
 * ADR-0008 D5: this is deliberately unflattering in places. `ReviewElapsed` means nobody
 * checked, which is weaker evidence than `PassingVerdict`, and a score that cannot tell
 * them apart rewards silence.
 */
export const CompletionRoute = {
  AgentConfirmed: 0,
  ReviewElapsed: 1,
  PassingVerdict: 2,
  ArbitrationTimeout: 3,
} as const;

export type CompletionRouteValue =
  (typeof CompletionRoute)[keyof typeof CompletionRoute];

/** The field types, in schema order. Derived from COMPLETION_SCHEMA so they cannot drift. */
export const COMPLETION_FIELDS = COMPLETION_SCHEMA.split(",").map((pair) => {
  const [type, name] = pair.split(" ");
  return { type, name };
});

/**
 * The EAS schema UID: `keccak256(abi.encodePacked(schema, resolver, revocable))`.
 *
 * Computed rather than transcribed, so it cannot be recorded wrongly — this repo has had a
 * hard-coded address wrong in both directions before (`CC-059`).
 */
export function completionSchemaUid(): Hex {
  return keccak256(
    encodePacked(
      ["string", "address", "bool"],
      [COMPLETION_SCHEMA, COMPLETION_RESOLVER, COMPLETION_REVOCABLE],
    ),
  );
}

/** One completed task, as the attestation describes it. */
export interface CompletionAttestationData {
  /** keccak256 of payment_request_id — the same taskId the escrow uses. */
  taskId: Hex;
  /** The escrow this task lived in. Half of the portability fix (ADR-0008 D4). */
  escrow: Address;
  /** The chain that escrow is on. The other half. */
  chainId: bigint;
  agent: Address;
  /** USDC in 6-decimal units, as the contract stores it. */
  amountUsdc: bigint;
  route: CompletionRouteValue;
  completedAt: bigint;
  specHash: Hex;
  evidenceHash: Hex;
  /** Zero when no verdict was ever presented. */
  verdictHash: Hex;
  /** Zero when no verdict was ever presented. ADR-0001 D5 re-runnability. */
  checkerHash: Hex;
}

/**
 * ABI-encode one attestation's `data` field.
 *
 * Positional against `COMPLETION_SCHEMA`, and the field list is derived from that string
 * rather than restated — a hand-maintained second copy is how `verify-unclaimed.mjs` ended
 * up decoding `amount` out of `specHash` (see `escrow-abi-drift.test.ts`).
 */
export function encodeCompletionData(data: CompletionAttestationData): Hex {
  return encodeAbiParameters(
    COMPLETION_FIELDS.map(({ name, type }) => ({ name, type })),
    [
      data.taskId,
      data.escrow,
      data.chainId,
      data.agent,
      data.amountUsdc,
      data.route,
      data.completedAt,
      data.specHash,
      data.evidenceHash,
      data.verdictHash,
      data.checkerHash,
    ] as never,
  );
}
