/**
 * attestation/envelope.ts — the EIP-712 envelope for a delegated EAS attestation,
 * resolved from the chain rather than assumed (ADR-0008 A1.2, A1.3).
 *
 * ## The problem this solves
 *
 * `attestByDelegation` verifies an EIP-712 signature. To produce one you need the domain
 * and the exact `Attest` struct — and **both differ between Base Sepolia and Base mainnet**,
 * because they run EAS 1.2.0 and 1.0.1 respectively. Measured 2026-08-31:
 *
 *   base-sepolia  1.2.0  Attest(… bytes data,uint256 value,uint256 nonce,uint64 deadline)
 *   base-mainnet  1.0.1  Attest(… bytes data,uint256 nonce)
 *
 * Mainnet's struct has **no `value` and no `deadline`**. So this is not a hash difference to
 * paper over, it is a different message. A build that hard-codes either one signs correctly
 * on one network and produces signatures the other rejects, and the failure would land on
 * the first mainnet attestation looking like a signing bug.
 *
 * ## How the values below were established
 *
 * Not from documentation, and not from memory. `keccak256(typeString)` **must** equal the
 * `getAttestTypeHash()` the contract reports, so a type string that matches is proven rather
 * than believed. Same for the domain: the separator is recomputed from candidate
 * `name`/`version` pairs until one reproduces the `getDomainSeparator()` the chain returns.
 * `envelope.test.ts` re-runs both derivations, so the table cannot rot silently.
 *
 * ## The safety property
 *
 * **An unrecognised typehash refuses to sign.** If EAS is upgraded to a version whose struct
 * is not in this table — and it is a proxy, so the chain operator can do that — the correct
 * behaviour is to stop, not to sign against the closest guess. A signature against the wrong
 * struct is not rejected loudly at signing time; it is rejected by the contract, later,
 * looking like something else.
 */

import { keccak256, toHex, type Address, type Hex, type TypedDataDomain } from "viem";

/** One EAS version's `Attest` struct, keyed by the typehash that proves it. */
export interface AttestEnvelope {
  /** The exact EIP-712 type string. `keccak256` of this equals the key. */
  typeString: string;
  /** Human note on which deployments were observed using it. Not load-bearing. */
  seenOn: string;
}

/**
 * Verified `Attest` type strings, keyed by `getAttestTypeHash()`.
 *
 * **Every key here is confirmed by hash equality against a live deployment.** Do not add an
 * entry without doing the same — `envelope.test.ts` recomputes each hash from its string, so
 * a wrong pair fails, but only a real deployment can tell you the hash is one EAS uses.
 */
export const VERIFIED_ATTEST_ENVELOPES: Record<Hex, AttestEnvelope> = {
  "0xf83bb2b0ede93a840239f7e701a54d9bc35f03701f51ae153d601c6947ff3d3f": {
    typeString:
      "Attest(bytes32 schema,address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value,uint256 nonce,uint64 deadline)",
    seenOn: "EAS 1.2.0 — base-sepolia",
  },
  "0xdbfdf8dc2b135c26253e00d5b6cbe6f20457e003fd526d97cea183883570de61": {
    typeString:
      "Attest(bytes32 schema,address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 nonce)",
    seenOn: "EAS 1.0.1 — base-mainnet",
  },
};

/**
 * The EIP712Proxy's envelopes. Recorded so the *rejection* in ADR-0008 A1.4 is checkable, and
 * so that a typehash read from the proxy by mistake is recognised and named rather than
 * falling into the "unknown, refuse" path with no explanation.
 *
 * Note the proxy struct carries `address attester` explicitly — which is the mechanical
 * reason A1.4 rejects it: on-chain the proxy *is* the attester, so the real signer has to be
 * passed as data and recovered from the proxy's own records.
 */
export const REJECTED_PROXY_ENVELOPES: Record<Hex, AttestEnvelope> = {
  "0xea02ffba7dcb45f6fc649714d23f315eef12e3b27f9a7735d8d8bf41eb2b1af1": {
    typeString:
      "Attest(address attester,bytes32 schema,address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value,uint64 deadline)",
    seenOn: "EIP712Proxy 1.3.0 — base-sepolia",
  },
  "0x9d3e80e7032dc16815a5f67aa94e851240ae3b24eed13a7431bdac738f814567": {
    typeString:
      "Attest(bytes32 schema,address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value,uint64 deadline)",
    seenOn: "EIP712Proxy 1.2.0 — base-mainnet",
  },
};

/**
 * The EIP-712 domain, confirmed by reproducing `getDomainSeparator()`.
 *
 * `name` is the literal string "EAS" — not "EAS Attestation", which is the plausible guess
 * and is wrong. `version` is whatever the contract's own `version()` returns, which is why it
 * is a parameter here rather than a constant.
 */
export function easDomain(
  easAddress: Address,
  chainId: number,
  contractVersion: string,
): TypedDataDomain {
  return {
    name: "EAS",
    version: contractVersion,
    chainId,
    verifyingContract: easAddress,
  };
}

/** Parse a type string into the field list viem's `signTypedData` wants. */
export function parseTypeString(typeString: string): { name: string; type: string }[] {
  const inner = typeString.slice(typeString.indexOf("(") + 1, typeString.lastIndexOf(")"));
  return inner.split(",").map((pair) => {
    const [type, name] = pair.split(" ");
    return { name, type };
  });
}

export class UnknownAttestEnvelopeError extends Error {
  constructor(
    readonly typeHash: Hex,
    readonly detail: string,
  ) {
    super(
      `Unrecognised EAS Attest typehash ${typeHash}. ${detail} Refusing to sign: a signature ` +
        `against a guessed struct is not rejected at signing time, it is rejected by the ` +
        `contract later and looks like a different bug. Derive the type string by matching ` +
        `keccak256(candidate) against this hash, verify it, and add it to ` +
        `VERIFIED_ATTEST_ENVELOPES in src/lib/attestation/envelope.ts.`,
    );
    this.name = "UnknownAttestEnvelopeError";
  }
}

/**
 * Resolve the envelope for a typehash read off the chain.
 *
 * @throws {UnknownAttestEnvelopeError} on any typehash not proven against a deployment —
 *   including the EIP712Proxy's, which is recognised and rejected by name (ADR-0008 A1.4).
 */
export function envelopeForTypeHash(typeHash: Hex): AttestEnvelope {
  const key = typeHash.toLowerCase() as Hex;

  const known = VERIFIED_ATTEST_ENVELOPES[key];
  if (known) return known;

  const proxy = REJECTED_PROXY_ENVELOPES[key];
  if (proxy) {
    throw new UnknownAttestEnvelopeError(
      typeHash,
      `That is the ${proxy.seenOn} typehash, not EAS's. ADR-0008 A1.4 rejects the proxy: it ` +
        `becomes the on-chain attester, so the attestation would not name our verdict signer. ` +
        `Read getAttestTypeHash() from the EAS address, not the proxy.`,
    );
  }

  throw new UnknownAttestEnvelopeError(
    typeHash,
    "No verified type string is on record for it — EAS may have been upgraded (it is behind " +
      "a proxy, so the chain operator can do that without notice).",
  );
}

/** Everything needed to sign, assembled from values read off the chain. */
export interface ResolvedEnvelope {
  domain: TypedDataDomain;
  types: { Attest: { name: string; type: string }[] };
  primaryType: "Attest";
  /** Which EAS version's struct this is, for logging and for the caller's own assertions. */
  seenOn: string;
  /** True when the struct carries `value`/`deadline` — i.e. EAS 1.1+ rather than 1.0.x. */
  hasValueAndDeadline: boolean;
}

/**
 * Assemble the signing envelope from the three values the chain reports.
 *
 * Callers read `version()`, `getAttestTypeHash()` and the chain id themselves — this module
 * stays free of network access so it can be unit-tested without a transport, and so the
 * caller decides how the reads are cached.
 */
export function resolveEnvelope(args: {
  easAddress: Address;
  chainId: number;
  contractVersion: string;
  attestTypeHash: Hex;
}): ResolvedEnvelope {
  const { typeString, seenOn } = envelopeForTypeHash(args.attestTypeHash);
  const fields = parseTypeString(typeString);
  return {
    domain: easDomain(args.easAddress, args.chainId, args.contractVersion),
    types: { Attest: fields },
    primaryType: "Attest",
    seenOn,
    hasValueAndDeadline: fields.some((f) => f.name === "deadline"),
  };
}

/** The typehash a type string implies. Exposed so callers can re-prove the table. */
export function typeHashOf(typeString: string): Hex {
  return keccak256(toHex(typeString));
}
