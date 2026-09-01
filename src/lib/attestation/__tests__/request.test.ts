/**
 * request.test.ts — the delegated-attestation message, per EAS version.
 *
 * The thing under test is that the message adapts to the struct the *chain* reports, because
 * Base Sepolia and Base mainnet do not agree on it (9 fields vs 7, ADR-0008 A1.2). A message
 * built for the wrong one is signed happily here and rejected inside the contract later.
 */
import { describe, it, expect } from "vitest";
import { resolveEnvelope } from "../envelope";
import {
  ATTESTATION_REQUEST_VALIDITY_SECONDS,
  AttestationRequestError,
  buildDelegatedAttestation,
  orderedForEnvelope,
} from "../request";
import { CompletionRoute, completionSchemaUid, type CompletionAttestationData } from "../schema";

const EAS = "0x4200000000000000000000000000000000000021" as const;
const WORKER = "0x2222222222222222222222222222222222222222" as const;
const ZERO32 = `0x${"00".repeat(32)}` as const;
const NOW = 1_790_000_000;

const SEPOLIA = {
  easAddress: EAS,
  chainId: 84532,
  contractVersion: "1.2.0",
  attestTypeHash: "0xf83bb2b0ede93a840239f7e701a54d9bc35f03701f51ae153d601c6947ff3d3f",
} as const;

const MAINNET = {
  easAddress: EAS,
  chainId: 8453,
  contractVersion: "1.0.1",
  attestTypeHash: "0xdbfdf8dc2b135c26253e00d5b6cbe6f20457e003fd526d97cea183883570de61",
} as const;

const COMPLETION: CompletionAttestationData = {
  taskId: `0x${"11".repeat(32)}`,
  escrow: "0xe80d03688E8fa6270668AD73191d353e522CB1b1",
  chainId: BigInt(84532),
  agent: "0x3333333333333333333333333333333333333333",
  amountUsdc: BigInt(25_000_000),
  route: CompletionRoute.PassingVerdict,
  completedAt: BigInt(NOW),
  specHash: `0x${"aa".repeat(32)}`,
  evidenceHash: `0x${"bb".repeat(32)}`,
  verdictHash: `0x${"cc".repeat(32)}`,
  checkerHash: `0x${"dd".repeat(32)}`,
};

const build = (network: typeof SEPOLIA | typeof MAINNET, nonce = BigInt(7)) =>
  buildDelegatedAttestation({
    envelope: resolveEnvelope(network),
    worker: WORKER,
    completion: COMPLETION,
    nonce,
    nowSeconds: NOW,
  });

describe("delegated attestation message", () => {
  it("carries value and deadline on EAS 1.2.0", () => {
    const m = build(SEPOLIA);
    expect(m.value).toBe(BigInt(0));
    expect(m.deadline).toBe(BigInt(NOW + ATTESTATION_REQUEST_VALIDITY_SECONDS));
  });

  it("omits them entirely on EAS 1.0.1", () => {
    // Not zero — ABSENT. The 1.0.1 struct has no such fields, so supplying them would change
    // the hash and produce a signature mainnet rejects.
    const m = build(MAINNET);
    expect(m.value).toBeUndefined();
    expect(m.deadline).toBeUndefined();
    expect("value" in m).toBe(false);
    expect("deadline" in m).toBe(false);
  });

  it("targets our registered schema and puts the worker in recipient", () => {
    // ADR-0008 D4: the worker is the EAS subject, which is why the schema data has no
    // worker field. If both carried it they could disagree.
    const m = build(SEPOLIA);
    expect(m.schema).toBe(completionSchemaUid());
    expect(m.recipient).toBe(WORKER);
  });

  it("never expires and is never revocable", () => {
    // expirationTime 0 is "no expiry": an attestation that lapses is a reputation that
    // evaporates. revocable must not exceed the schema's flag, which is false — EAS rejects
    // otherwise, and that rejection would land on the worker at submit time.
    for (const net of [SEPOLIA, MAINNET]) {
      const m = build(net);
      expect(m.expirationTime).toBe(BigInt(0));
      expect(m.revocable).toBe(false);
      expect(m.refUID).toBe(ZERO32);
    }
  });

  it("uses the nonce it was given rather than inventing one", () => {
    // On EAS 1.0.x the nonce is the ONLY replay protection — there is no deadline. It has to
    // come from getNonce(attester), so a stale or invented one reverts at submit time.
    expect(build(SEPOLIA, BigInt(41)).nonce).toBe(BigInt(41));
    expect(build(MAINNET, BigInt(0)).nonce).toBe(BigInt(0));
  });

  it("orders the payload to match each struct exactly", () => {
    const sepoliaEnv = resolveEnvelope(SEPOLIA);
    const mainnetEnv = resolveEnvelope(MAINNET);

    const sOrdered = orderedForEnvelope(sepoliaEnv, build(SEPOLIA));
    const mOrdered = orderedForEnvelope(mainnetEnv, build(MAINNET));

    expect(Object.keys(sOrdered)).toEqual([
      "schema", "recipient", "expirationTime", "revocable", "refUID", "data", "value", "nonce", "deadline",
    ]);
    expect(Object.keys(mOrdered)).toEqual([
      "schema", "recipient", "expirationTime", "revocable", "refUID", "data", "nonce",
    ]);
  });

  it("refuses to invent a field the struct wants and the message lacks", () => {
    // The failure this converts from silent to loud: a future EAS struct with a field we do
    // not build. Filling it with a default would be signed and then rejected on chain.
    const envelope = resolveEnvelope(SEPOLIA);
    const missing = { ...build(SEPOLIA) };
    delete (missing as Record<string, unknown>).deadline;

    expect(() => orderedForEnvelope(envelope, missing)).toThrow(AttestationRequestError);
    expect(() => orderedForEnvelope(envelope, missing)).toThrow(/deadline/);
    expect(() => orderedForEnvelope(envelope, missing)).toThrow(/do not fill it with a/);
  });

  it("encodes the same completion identically on both networks", () => {
    // The `data` blob is schema-defined, so it does NOT vary with the EAS version — only the
    // envelope around it does. Asserted so a future edit cannot make the payload
    // network-dependent without someone noticing.
    expect(build(SEPOLIA).data).toBe(build(MAINNET).data);
  });
});
