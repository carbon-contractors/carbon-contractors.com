import { describe, it, expect } from "vitest";
import {
  serializeVerdict,
  parseVerdictPayload,
  verdictTupleForContract,
} from "@/lib/contracts/verdict-json";
import type { Verdict } from "@/lib/contracts/verdict";

const h = (byte: string) => ("0x" + byte.repeat(32)) as `0x${string}`;

const VERDICT: Verdict = {
  taskId: h("11"),
  specHash: h("aa"),
  evidenceHash: h("bb"),
  checkerHash: h("33"),
  passed: false,
  breakdownHash: h("44"),
  expiry: BigInt(1_700_003_600),
  nonce: BigInt(42),
};

describe("verdict-json (CC-092)", () => {
  it("round-trips a verdict through its wire shape", () => {
    const wire = serializeVerdict(VERDICT);
    expect(wire.expiry).toBe("1700003600"); // bigint as string, JSON-safe
    expect(wire.nonce).toBe("42");
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);

    const back = parseVerdictPayload(JSON.parse(JSON.stringify(wire)));
    expect(back).toEqual(VERDICT);
  });

  it("produces a tuple the escrow ABI can encode", () => {
    const tuple = verdictTupleForContract(VERDICT);
    expect(tuple.passed).toBe(false);
    expect(tuple.expiry).toBe(BigInt(1_700_003_600));
    expect(tuple.nonce).toBe(BigInt(42));
    expect(Object.keys(tuple)).toEqual([
      "taskId",
      "specHash",
      "evidenceHash",
      "checkerHash",
      "passed",
      "breakdownHash",
      "expiry",
      "nonce",
    ]);
  });

  it("rejects a payload that is not a verdict", () => {
    expect(() => parseVerdictPayload(null)).toThrow();
    expect(() => parseVerdictPayload("passed")).toThrow();
    expect(() => parseVerdictPayload({ ...serializeVerdict(VERDICT), passed: "yes" })).toThrow(
      /passed is not a boolean/,
    );
    // numbers are not accepted for expiry/nonce — only decimal strings
    expect(() =>
      parseVerdictPayload({ ...serializeVerdict(VERDICT), expiry: 42 }),
    ).toThrow(/expiry/);
  });

  it("rejects hash fields that are not bytes32", () => {
    expect(() =>
      parseVerdictPayload({ ...serializeVerdict(VERDICT), specHash: "0x1234" }),
    ).toThrow(/specHash/);
    expect(() =>
      parseVerdictPayload({ ...serializeVerdict(VERDICT), taskId: "not-hex" }),
    ).toThrow(/taskId/);
  });
});
