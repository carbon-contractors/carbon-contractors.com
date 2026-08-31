/**
 * envelope.test.ts — re-proves the EAS EIP-712 envelope table offline.
 *
 * Every entry in `VERIFIED_ATTEST_ENVELOPES` was established by hash equality against a live
 * deployment: `keccak256(typeString)` had to equal the `getAttestTypeHash()` the contract
 * reported. These tests recompute that, so a wrong or edited pair fails here rather than at
 * the first attestation.
 *
 * What they cannot check is that a hash is one EAS actually uses — only a deployment can say
 * that. So the keys are the measured facts and the strings are what this file proves consistent
 * with them. `scripts/audit/verify-eas-deployment.mjs` is the other half.
 */
import { describe, it, expect } from "vitest";
import { keccak256, encodeAbiParameters, stringToHex, toHex } from "viem";
import {
  VERIFIED_ATTEST_ENVELOPES,
  REJECTED_PROXY_ENVELOPES,
  UnknownAttestEnvelopeError,
  easDomain,
  envelopeForTypeHash,
  parseTypeString,
  resolveEnvelope,
  typeHashOf,
} from "../envelope";

const EAS = "0x4200000000000000000000000000000000000021" as const;

/** Measured 2026-08-31 with verify-eas-deployment.mjs. */
const MEASURED = {
  "base-sepolia": {
    chainId: 84532,
    version: "1.2.0",
    domainSeparator: "0x64d609c088b8729a2fe70a363f7f8fa40a76a40dea7f87597fc4505053a8ac68",
    attestTypeHash: "0xf83bb2b0ede93a840239f7e701a54d9bc35f03701f51ae153d601c6947ff3d3f",
  },
  "base-mainnet": {
    chainId: 8453,
    version: "1.0.1",
    domainSeparator: "0x441f04bd3fc4b9bbef0e92ccbdd47cebd80211d531918066401ffc7c91fd954b",
    attestTypeHash: "0xdbfdf8dc2b135c26253e00d5b6cbe6f20457e003fd526d97cea183883570de61",
  },
} as const;

const DOMAIN_TYPEHASH = keccak256(
  toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

/** Recompute a domain separator the way EIP-712 specifies. */
function separatorOf(name: string, version: string, chainId: number, verifying: string) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DOMAIN_TYPEHASH, keccak256(stringToHex(name)), keccak256(stringToHex(version)), BigInt(chainId), verifying],
    ) as `0x${string}`,
  );
}

describe("EAS envelope table", () => {
  it("every verified type string hashes to the typehash it is filed under", () => {
    // The property that makes the table proof rather than documentation.
    for (const [hash, { typeString, seenOn }] of Object.entries(VERIFIED_ATTEST_ENVELOPES)) {
      expect(typeHashOf(typeString), `${seenOn} (${hash})`).toBe(hash);
    }
    expect(Object.keys(VERIFIED_ATTEST_ENVELOPES).length).toBeGreaterThanOrEqual(2);
  });

  it("every rejected proxy type string does too", () => {
    // The proxy entries exist so a typehash read from the wrong contract is named rather than
    // producing an unexplained refusal. They have to be right for that to work.
    for (const [hash, { typeString, seenOn }] of Object.entries(REJECTED_PROXY_ENVELOPES)) {
      expect(typeHashOf(typeString), `${seenOn} (${hash})`).toBe(hash);
    }
  });

  it("reproduces the domain separator both networks actually report", () => {
    // This is what established name === "EAS". The plausible guess is "EAS Attestation", and
    // it is wrong — a domain that does not reproduce the separator yields a signature the
    // contract rejects, with nothing local objecting.
    for (const [network, m] of Object.entries(MEASURED)) {
      const d = easDomain(EAS, m.chainId, m.version);
      expect(d.name, network).toBe("EAS");
      expect(separatorOf(d.name!, d.version!, m.chainId, EAS), network).toBe(m.domainSeparator);
    }
  });

  it("does NOT reproduce it with the plausible-but-wrong name", () => {
    // Asserted so the previous test cannot pass for a trivial reason.
    const m = MEASURED["base-sepolia"];
    expect(separatorOf("EAS Attestation", m.version, m.chainId, EAS)).not.toBe(m.domainSeparator);
  });

  it("resolves each network to the struct that network actually uses", () => {
    const sepolia = resolveEnvelope({
      easAddress: EAS,
      chainId: MEASURED["base-sepolia"].chainId,
      contractVersion: MEASURED["base-sepolia"].version,
      attestTypeHash: MEASURED["base-sepolia"].attestTypeHash,
    });
    const mainnet = resolveEnvelope({
      easAddress: EAS,
      chainId: MEASURED["base-mainnet"].chainId,
      contractVersion: MEASURED["base-mainnet"].version,
      attestTypeHash: MEASURED["base-mainnet"].attestTypeHash,
    });

    // The structural difference, pinned. Mainnet's EAS 1.0.1 has no `value` and no `deadline`,
    // so this is a different message and not a different hash of the same one.
    expect(sepolia.hasValueAndDeadline).toBe(true);
    expect(mainnet.hasValueAndDeadline).toBe(false);
    expect(sepolia.types.Attest).toHaveLength(9);
    expect(mainnet.types.Attest).toHaveLength(7);
    expect(mainnet.types.Attest.map((f) => f.name)).not.toContain("value");
    expect(mainnet.types.Attest.map((f) => f.name)).not.toContain("deadline");
  });

  it("refuses an unknown typehash rather than signing against a guess", () => {
    // The safety property. EAS is behind a proxy, so the chain operator can upgrade it — and
    // the correct response to an unrecognised struct is to stop.
    const bogus = `0x${"ab".repeat(32)}` as const;
    expect(() => envelopeForTypeHash(bogus)).toThrow(UnknownAttestEnvelopeError);
    expect(() => envelopeForTypeHash(bogus)).toThrow(/Refusing to sign/);
  });

  it("names the EIP712Proxy when its typehash turns up by mistake", () => {
    // Reading getAttestTypeHash() off the proxy instead of EAS is an easy mistake — both
    // addresses sit in the same docs table. The refusal should say so.
    const proxyHash = Object.keys(REJECTED_PROXY_ENVELOPES)[0] as `0x${string}`;
    expect(() => envelopeForTypeHash(proxyHash)).toThrow(/EIP712Proxy/);
    expect(() => envelopeForTypeHash(proxyHash)).toThrow(/A1\.4/);
  });

  it("parses a type string into ordered viem fields", () => {
    const fields = parseTypeString("Attest(bytes32 schema,address recipient,uint64 expirationTime)");
    expect(fields).toEqual([
      { name: "schema", type: "bytes32" },
      { name: "recipient", type: "address" },
      { name: "expirationTime", type: "uint64" },
    ]);
  });
});
