/**
 * attestation/offchain.ts — the off-chain EAS attestation the worker holds at completion
 * (ADR-0008 D1, A2.3, A2.7).
 *
 * ## Where this format comes from
 *
 * Not the contract. EAS on chain only knows `timestamp(uid)` and `revokeOffchain(uid)`; the
 * off-chain format is defined by the EAS SDK, and anyone verifying our attestation will use
 * the SDK. So this module reproduces the SDK's **offchain Version 2** exactly, transcribed from
 * `@ethereum-attestation-service/eas-sdk` 2.10.0 `dist/lib.esm/offchain/offchain.js` (read
 * 2026-10-19, deliberately not installed). The envelope values are cross-checked against
 * `chain-constants.json` in `offchain.test.ts`, whose derivation method is itself proven
 * against the chain in `chain-constants.test.ts`.
 *
 * ## Two traps, both of which fail as "bad signature" somewhere else
 *
 * - **Domain name.** `"EAS Attestation"` here, `"EAS"` for the delegated envelope
 *   (`envelope.ts`). Same address, same version, different string.
 * - **The UID's schema argument is text.** The SDK hashes `hexlify(toUtf8Bytes(schema))`: the
 *   66-character hex *string* of the schema UID, as UTF-8 — not its 32 bytes. A UID computed
 *   from the raw bytes32 differs, and an SDK verifier rejects the attestation on UID mismatch
 *   before it ever checks the signature.
 * - **…and the text is case-sensitive.** `0x99…` and `0X99…`/mixed case hash to different UIDs.
 *   `offchainUid` refuses anything but lowercase rather than normalising, so the `schema` in
 *   the signed message and the one hashed into the UID cannot drift apart.
 *
 * No network access and no signing here: the caller supplies the EAS address, chain id and
 * the contract's `version()`, exactly as for `envelope.ts`.
 */

import { encodePacked, keccak256, toHex, type Address, type Hex, type TypedDataDomain } from "viem";

/** The SDK's offchain format version. Version 2 adds `salt`; the SDK signs with it by default. */
export const OFFCHAIN_ATTESTATION_VERSION = 2;

/** The EIP-712 domain name for off-chain attestations. Not "EAS" — that is the delegated one. */
export const OFFCHAIN_DOMAIN_NAME = "EAS Attestation";

export const OFFCHAIN_ATTEST_TYPE_STRING =
  "Attest(uint16 version,bytes32 schema,address recipient,uint64 time,uint64 expirationTime," +
  "bool revocable,bytes32 refUID,bytes data,bytes32 salt)";

export const OFFCHAIN_ATTEST_TYPES = {
  Attest: [
    { name: "version", type: "uint16" },
    { name: "schema", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "time", type: "uint64" },
    { name: "expirationTime", type: "uint64" },
    { name: "revocable", type: "bool" },
    { name: "refUID", type: "bytes32" },
    { name: "data", type: "bytes" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

/** `keccak256(OFFCHAIN_ATTEST_TYPE_STRING)`. Pinned in `chain-constants.json`. */
export const OFFCHAIN_ATTEST_TYPEHASH = keccak256(toHex(OFFCHAIN_ATTEST_TYPE_STRING));

/** The off-chain domain. `contractVersion` is the EAS contract's own `version()`. */
export function offchainDomain(
  easAddress: Address,
  chainId: number,
  contractVersion: string,
): TypedDataDomain {
  return {
    name: OFFCHAIN_DOMAIN_NAME,
    version: contractVersion,
    chainId,
    verifyingContract: easAddress,
  };
}

const LOWERCASE_BYTES32 = /^0x[0-9a-f]{64}$/;

/** The fields of one off-chain attestation, in the SDK's Version 2 shape. */
export interface OffchainAttestationMessage {
  schema: Hex;
  recipient: Address;
  time: bigint;
  expirationTime: bigint;
  revocable: boolean;
  refUID: Hex;
  data: Hex;
  /** 32 random bytes. Without it two identical completions share a UID, and the second
   *  worker's `timestamp(uid)` reverts `AlreadyTimestamped` (ADR-0008 A2.7). */
  salt: Hex;
}

/**
 * The UID an EAS SDK verifier will compute for this attestation — `Offchain.getOffchainUID`
 * for Version 2. The attester slot is the zero address and the trailing `uint32` is zero in
 * the SDK, so they are here too.
 */
export function offchainUid(m: OffchainAttestationMessage): Hex {
  if (!LOWERCASE_BYTES32.test(m.schema)) {
    throw new Error(
      "offchainUid: schema must be a lowercase 0x-prefixed bytes32 — the SDK hashes it as text, " +
        "so any other spelling produces a UID no verifier will reproduce",
    );
  }
  return keccak256(
    encodePacked(
      [
        "uint16",
        "bytes",
        "address",
        "address",
        "uint64",
        "uint64",
        "bool",
        "bytes32",
        "bytes",
        "bytes32",
        "uint32",
      ],
      [
        OFFCHAIN_ATTESTATION_VERSION,
        toHex(m.schema), // the hex STRING as UTF-8 bytes — see the module comment
        m.recipient,
        "0x0000000000000000000000000000000000000000",
        m.time,
        m.expirationTime,
        m.revocable,
        m.refUID,
        m.data,
        m.salt,
        0,
      ],
    ),
  );
}
