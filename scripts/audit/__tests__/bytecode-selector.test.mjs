import { describe, it, expect } from "vitest";
import { selectorInBytecode } from "../bytecode-selector.mjs";

// Byte runs copied from CarbonEscrow's compiled deployedBytecode on 2026-10-12 (solc 0.8.24,
// viaIR, runs 1000): the three encodings the deployment checks have to recognise.
const SHIFTED_ERROR = "630b9b77d960e11b82"; // PUSH4 0x0b9b77d9, PUSH1 0xe1, SHL — PlatformCannotBeParty
const DISPATCHER = "63647dc70b146111"; // PUSH4 completeTaskByOwner, EQ, PUSH2 …
const PUSH32_ERROR = `7f48f0fae6${"00".repeat(28)}`; // DeadlineTooFar(), left-aligned

describe("selectorInBytecode (NOR-537)", () => {
  it("finds an error selector the optimiser pushed shifted, which includes() misses", () => {
    const code = `0x6080${SHIFTED_ERROR}fd`;

    // The naive check this replaces would report a correct deployment as lacking F1.
    expect(code.includes("1736efb2")).toBe(false);
    expect(selectorInBytecode(code, "PlatformCannotBeParty(address)")).toBe(true);
  });

  it("finds a dispatcher selector pushed verbatim", () => {
    expect(selectorInBytecode(`0x6080${DISPATCHER}`, "completeTaskByOwner(bytes32)")).toBe(true);
  });

  it("finds an error selector pushed left-aligned as PUSH32", () => {
    expect(selectorInBytecode(`0x6080${PUSH32_ERROR}`, "DeadlineTooFar()")).toBe(true);
  });

  it("reports an absent selector as absent", () => {
    const code = `0x6080${SHIFTED_ERROR}${DISPATCHER}${PUSH32_ERROR}`;

    expect(selectorInBytecode(code, "releaseAfterArbitration(bytes32)")).toBe(false);
  });

  it("does not accept the shifted constant without the SHL that rebuilds the selector", () => {
    expect(selectorInBytecode("0x6080630b9b77d900", "PlatformCannotBeParty(address)")).toBe(false);
  });
});
