import { describe, it, expect } from "vitest";
import { attestationFilename, isAttestable, publishTransaction } from "../client";

const EAS = "0x4200000000000000000000000000000000000021";
const OK = { to: EAS, calldata: `0x12345678${"00".repeat(64)}`, chainId: 84532 };

describe("isAttestable (CC-036)", () => {
  it("is true for a Completed task", () => {
    expect(isAttestable({ status: "active", on_chain: { state: "Completed" } })).toBe(true);
  });
  it("is true for a Resolved task only when the ruling paid the worker", () => {
    expect(isAttestable({ status: "completed", on_chain: { state: "Resolved" } })).toBe(true);
    expect(isAttestable({ status: "expired", on_chain: { state: "Resolved" } })).toBe(false);
  });
  it("is false in flight, expired, or with no chain read", () => {
    for (const state of ["Funded", "Delivered", "Disputed", "Expired"]) {
      expect(isAttestable({ status: "active", on_chain: { state } })).toBe(false);
    }
    expect(isAttestable({ status: "completed", on_chain: null })).toBe(false);
  });
});

describe("attestationFilename", () => {
  it("uses the UID prefix, falling back to the task id", () => {
    expect(attestationFilename(`0xdeadbeef${"00".repeat(28)}`, "a".repeat(32))).toBe(
      "carbon-contractors-completion-deadbeef.json",
    );
    expect(attestationFilename("", "abcdef0123456789")).toBe(
      "carbon-contractors-completion-abcdef01.json",
    );
  });
});

describe("publishTransaction — the wallet only ever sends to EAS", () => {
  it("passes a well-formed response through, value forced to zero", () => {
    expect(publishTransaction(OK, 84532)).toEqual({
      to: EAS,
      data: OK.calldata,
      chainId: 84532,
      value: BigInt(0),
    });
  });
  it("accepts a checksummed EAS address", () => {
    expect(publishTransaction({ ...OK, to: EAS.toUpperCase().replace("0X", "0x") }, 84532).to).toBe(EAS);
  });
  it("refuses any other destination", () => {
    expect(() =>
      publishTransaction({ ...OK, to: "0x1111111111111111111111111111111111111111" }, 84532),
    ).toThrow(/does not target the EAS contract/);
  });
  it("refuses a different chain", () => {
    expect(() => publishTransaction({ ...OK, chainId: 8453 }, 84532)).toThrow(/different network/);
  });
  it("refuses malformed calldata", () => {
    for (const calldata of ["", "0x", "0x1234", "not-hex", `0x12345678zz`]) {
      expect(() => publishTransaction({ ...OK, calldata }, 84532)).toThrow(/malformed/);
    }
  });
});
