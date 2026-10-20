/**
 * offchain.test.ts — the off-chain attestation envelope and UID (ADR-0008 A2.7, CC-036).
 *
 * The UID vectors below were **hand-derived without viem**: the packed bytes were built field by
 * field from the SDK's `getOffchainUID` (Version 2) and hashed with a standalone pure-Python
 * Keccak-256, itself checked against keccak256("") and keccak256("abc"). The EAS SDK is
 * deliberately not a dependency (no new package without PO approval), so these literals are the
 * stand-in for an SDK-produced vector: two independent implementations agreeing, pinned here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashDomain, keccak256, type Address, type Hex } from "viem";
import {
  OFFCHAIN_ATTEST_TYPEHASH,
  OFFCHAIN_DOMAIN_NAME,
  offchainDomain,
  offchainUid,
  type OffchainAttestationMessage,
} from "../offchain";
import { completionSchemaUid } from "../schema";

const constants = JSON.parse(readFileSync(join(process.cwd(), "chain-constants.json"), "utf8"));
const recorded = constants.protocol.attestations;

const SCHEMA = "0x990663e1a6e37950b4d1b3eb6d2685dc36115d6d1fbc789902268ef1d594380e" as Hex;

const V1: OffchainAttestationMessage = {
  schema: SCHEMA,
  recipient: "0x1234567890abcdef1234567890abcdef12345678",
  time: BigInt(1760832000),
  expirationTime: BigInt(0),
  revocable: false,
  refUID: `0x${"00".repeat(32)}`,
  data: "0xdeadbeef",
  salt: `0x${"11".repeat(32)}`,
};

const V2: OffchainAttestationMessage = {
  schema: SCHEMA,
  recipient: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  time: BigInt(1760832123),
  expirationTime: BigInt(1792368123),
  revocable: true,
  refUID: `0x${"22".repeat(32)}`,
  data: "0x",
  salt: `0x${"ff".repeat(32)}`,
};

describe("off-chain attestation envelope", () => {
  it("matches the typehash recorded in chain-constants.json", () => {
    expect(OFFCHAIN_ATTEST_TYPEHASH).toBe(recorded.offchainEnvelope.typeHash);
  });

  it("produces the recorded domain separator on both networks", () => {
    const chainIds: Record<string, number> = { "base-sepolia": 84532, "base-mainnet": 8453 };
    for (const network of Object.keys(chainIds)) {
      const domain = offchainDomain(
        recorded.easAddress[network] as Address,
        chainIds[network],
        recorded.easVersion[network],
      );
      expect(domain.name).toBe(OFFCHAIN_DOMAIN_NAME);
      expect(
        hashDomain({
          domain: { ...domain, chainId: BigInt(chainIds[network]) } as {
            name: string;
            version: string;
            chainId: bigint;
            verifyingContract: Address;
          },
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
          } as const,
        }),
        network,
      ).toBe(recorded.offchainEnvelope.domainSeparator[network]);
    }
  });

  it("is the completion schema the UID vectors use", () => {
    expect(completionSchemaUid()).toBe(SCHEMA);
  });
});

describe("offchainUid (SDK getOffchainUID, Version 2)", () => {
  it("reproduces hand-derived vector 1 (non-revocable, no expiry, empty refUID)", () => {
    expect(offchainUid(V1)).toBe(
      "0xb4cc5d2e47706338a28e0bf5ecda79281287d73fbf40fb332a4c9bc18b1302ee",
    );
  });

  it("reproduces hand-derived vector 2 (revocable, expiry, refUID, empty data)", () => {
    expect(offchainUid(V2)).toBe(
      "0x3845fcbc52753991cdcba8014825d7d5e97b847462b036407a2dd5f527cd78e6",
    );
  });

  it("hashes the schema as text — the raw-bytes32 reading gives a different UID", () => {
    // The naive packing a verifier writes by hand: schema as 32 bytes, not 66 characters.
    const naive = keccak256(
      `0x0002${SCHEMA.slice(2)}${V1.recipient.slice(2)}${"00".repeat(20)}` +
        `${"0000000068f42a00"}${"00".repeat(8)}00${"00".repeat(32)}deadbeef${"11".repeat(32)}00000000` as Hex,
    );
    expect(naive).toBe("0x016a23422adde1c5fd231dcc1043276f6814361ae9d68ba949b7889c69524217");
    expect(offchainUid(V1)).not.toBe(naive);
  });

  it("changes when only the salt changes, so identical completions do not collide", () => {
    expect(offchainUid({ ...V1, salt: `0x${"12".repeat(32)}` })).not.toBe(offchainUid(V1));
  });

  it("refuses a non-lowercase schema rather than hashing a UID no verifier reproduces", () => {
    // Hand-derived: uppercase hex hashes to 0xba04acd0…c604, not vector 1's UID.
    expect(() => offchainUid({ ...V1, schema: SCHEMA.toUpperCase().replace("0X", "0x") as Hex })).toThrow(
      /lowercase/,
    );
  });
});
