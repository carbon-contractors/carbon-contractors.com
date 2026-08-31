/**
 * schema.test.ts — the permanent parts of ADR-0008's attestation schema.
 *
 * The schema UID is derived from the schema string, the resolver and the revocable flag, and
 * **it is permanent once registered.** Changing any of the three forks the reputation
 * history: attestations under the old UID and the new one are different claims about
 * different things, and nothing reconciles them.
 *
 * So these tests are not really testing the encoder. They are a tripwire on three values
 * that must not move by accident, and a proof that the encoding matches the schema the UID
 * was computed from.
 */
import { describe, it, expect } from "vitest";
import { decodeAbiParameters, encodePacked, keccak256 } from "viem";
import {
  COMPLETION_SCHEMA,
  COMPLETION_FIELDS,
  COMPLETION_RESOLVER,
  COMPLETION_REVOCABLE,
  CompletionRoute,
  completionSchemaUid,
  encodeCompletionData,
  type CompletionAttestationData,
} from "../schema";

const SAMPLE: CompletionAttestationData = {
  taskId: `0x${"11".repeat(32)}`,
  escrow: "0xe80d03688E8fa6270668AD73191d353e522CB1b1",
  chainId: BigInt(84532),
  agent: "0x2222222222222222222222222222222222222222",
  amountUsdc: BigInt(25_000_000),
  route: CompletionRoute.PassingVerdict,
  completedAt: BigInt(1_790_000_000),
  specHash: `0x${"aa".repeat(32)}`,
  evidenceHash: `0x${"bb".repeat(32)}`,
  verdictHash: `0x${"cc".repeat(32)}`,
  checkerHash: `0x${"dd".repeat(32)}`,
};

describe("ADR-0008 completion schema", () => {
  it("pins the schema identity to a single unwrappable literal", () => {
    // THE tripwire. If this fails, the schema changed — which forks every attestation
    // already issued. Read ADR-0008 D4 before updating the expectation.
    //
    // Deliberately the UID and not a restatement of the schema string. An earlier version
    // asserted the string via a three-line `+` concatenation, and github-code-quality
    // flagged it as "missing space after 'amountUsdc,'" — reading the schema as prose.
    // It is not prose: the string IS the identity, `keccak256(encodePacked(schema,
    // resolver, revocable))`, so inserting that space would have forked the schema while
    // looking like a formatting tidy-up. A single hex literal cannot be line-wrapped, so
    // it cannot be "helpfully" reflowed by a formatter, a bot, or a person.
    expect(completionSchemaUid()).toBe(
      "0x990663e1a6e37950b4d1b3eb6d2685dc36115d6d1fbc789902268ef1d594380e",
    );
  });

  it("has no whitespace around its separators", () => {
    // The specific edit the concatenation invited, blocked directly. Any space after a
    // comma is a different schema and therefore a different UID.
    expect(COMPLETION_SCHEMA).not.toMatch(/,\s/);
    expect(COMPLETION_SCHEMA).not.toMatch(/\s,/);
    expect(COMPLETION_SCHEMA.trim()).toBe(COMPLETION_SCHEMA);
    // Exactly one space per field, between type and name.
    for (const field of COMPLETION_SCHEMA.split(",")) {
      expect(field.split(" ")).toHaveLength(2);
    }
  });

  it("pins the two other UID inputs", () => {
    // The resolver being the zero address is why the same UID appears on Base and Base
    // Sepolia. A real resolver would be a per-network address and the two would diverge.
    expect(COMPLETION_RESOLVER).toBe("0x0000000000000000000000000000000000000000");
    // Non-revocable: a revocable reputation record is a lever over a worker's history that
    // ADR-0001 D9 does not otherwise grant the platform.
    expect(COMPLETION_REVOCABLE).toBe(false);
  });

  it("derives the UID the way EAS does, and deterministically", () => {
    const uid = completionSchemaUid();
    expect(uid).toMatch(/^0x[0-9a-f]{64}$/);
    expect(completionSchemaUid()).toBe(uid);

    // Recomputed independently here rather than imported, so the test is a second opinion
    // on the formula and not a restatement of it.
    expect(uid).toBe(
      keccak256(
        encodePacked(
          ["string", "address", "bool"],
          [COMPLETION_SCHEMA, COMPLETION_RESOLVER, COMPLETION_REVOCABLE],
        ),
      ),
    );
  });

  it("changes the UID if any input changes", () => {
    // The property that makes the UID an identity rather than a label.
    const base = completionSchemaUid();
    const withRevocable = keccak256(
      encodePacked(["string", "address", "bool"], [COMPLETION_SCHEMA, COMPLETION_RESOLVER, true]),
    );
    const withField = keccak256(
      encodePacked(
        ["string", "address", "bool"],
        [`${COMPLETION_SCHEMA},bool extra`, COMPLETION_RESOLVER, COMPLETION_REVOCABLE],
      ),
    );
    expect(withRevocable).not.toBe(base);
    expect(withField).not.toBe(base);
  });

  it("derives its field list from the schema string, not a second copy", () => {
    // The defect this avoids is the one verify-unclaimed.mjs actually shipped: a
    // hand-maintained tuple that drifted from the struct and decoded amount out of specHash.
    expect(COMPLETION_FIELDS).toHaveLength(11);
    expect(COMPLETION_FIELDS.map((f) => f.name)).toEqual([
      "taskId",
      "escrow",
      "chainId",
      "agent",
      "amountUsdc",
      "route",
      "completedAt",
      "specHash",
      "evidenceHash",
      "verdictHash",
      "checkerHash",
    ]);
  });

  it("round-trips one attestation through the encoding", () => {
    const encoded = encodeCompletionData(SAMPLE);
    const decoded = decodeAbiParameters(
      COMPLETION_FIELDS.map(({ name, type }) => ({ name, type })),
      encoded,
    ) as unknown[];

    // Positional: field N out must be field N in. This is the assertion that catches an
    // argument order mistake in encodeCompletionData, which would otherwise produce
    // plausible-looking attestations with the wrong numbers in them.
    expect(decoded[0]).toBe(SAMPLE.taskId);
    expect(String(decoded[1]).toLowerCase()).toBe(SAMPLE.escrow.toLowerCase());
    expect(decoded[2]).toBe(SAMPLE.chainId);
    expect(String(decoded[3]).toLowerCase()).toBe(SAMPLE.agent.toLowerCase());
    expect(decoded[4]).toBe(SAMPLE.amountUsdc);
    expect(decoded[5]).toBe(SAMPLE.route);
    expect(decoded[6]).toBe(SAMPLE.completedAt);
    expect(decoded[7]).toBe(SAMPLE.specHash);
    expect(decoded[8]).toBe(SAMPLE.evidenceHash);
    expect(decoded[9]).toBe(SAMPLE.verdictHash);
    expect(decoded[10]).toBe(SAMPLE.checkerHash);
  });

  it("carries the escrow address and chain id, which is the whole point", () => {
    // ADR-0008 D4: without these the attestation is meaningless after a redeploy, and
    // surviving redeploys is the only argument that justified doing this at all. If a
    // future edit drops them, the feature loses its reason to exist.
    const names = COMPLETION_FIELDS.map((f) => f.name);
    expect(names).toContain("escrow");
    expect(names).toContain("chainId");
  });

  it("carries no task content", () => {
    // ADR-0002 D4 deletes task content on a schedule; an attestation is permanent. Any
    // content-bearing field here would outlive the deletion and make a published privacy
    // claim untrue. Only hashes, addresses and numbers are allowed.
    for (const { type, name } of COMPLETION_FIELDS) {
      expect(
        ["bytes32", "address", "uint256", "uint64", "uint8"],
        `field ${name} has type ${type}, which can carry content`,
      ).toContain(type);
    }
    expect(COMPLETION_SCHEMA).not.toMatch(/\bstring\b|\bbytes\b(?!32)/);
  });

  it("mirrors CarbonEscrow.CompletionRoute without renumbering it", () => {
    // The enum is read from events and from this attestation. Renumbering would silently
    // change the meaning of every attestation already issued — CC-082 renumbered TaskState
    // once and every hard-coded integer predating it became wrong.
    expect(CompletionRoute).toEqual({
      AgentConfirmed: 0,
      ReviewElapsed: 1,
      PassingVerdict: 2,
      ArbitrationTimeout: 3,
    });
  });
});
