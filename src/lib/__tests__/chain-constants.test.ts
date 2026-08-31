/**
 * chain-constants.test.ts — `chain-constants.json` is a record; this makes it a *checked* one.
 *
 * ## Why this exists
 *
 * On 2026-08-31 a bad edit left the file with an unterminated JSON string. It **committed,
 * pushed, and passed CI** — lint, typecheck, 661 tests and the production build all green,
 * because nothing anywhere parses this file. The one artefact in the repo whose entire job
 * is to be believed over prose could be syntactically broken with no signal at all.
 *
 * So the first assertion below is just "it parses". The rest matter more: several values in
 * the file are documented as **derived** rather than transcribed, and a derived value that
 * nothing re-derives is a transcription with extra confidence. These cross-check the ones
 * that can be recomputed offline.
 *
 * What this deliberately does **not** do is check anything against a live chain. Addresses,
 * deploy blocks and registration state belong to the audit scripts the file itself names
 * (`verify-escrow-deployment.mjs`, `verify-eas-deployment.mjs`, …) — CC-060 keeps the test
 * suite hermetic, and a test that needs the network is a test that gets skipped.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPLETION_SCHEMA, completionSchemaUid } from "@/lib/attestation/schema";
import { getCheckerHash } from "@/lib/checker/hash";

const RAW = readFileSync(join(process.cwd(), "chain-constants.json"), "utf8");

describe("chain-constants.json", () => {
  it("parses as JSON", () => {
    // The gap that let a broken file through CI. Trivial, and it was missing.
    expect(() => JSON.parse(RAW)).not.toThrow();
  });

  const constants = JSON.parse(RAW);

  it("records the derived attestation schema UID, not a transcription of it", () => {
    // The file says this value is derived by completionSchemaUid(). If the two disagree,
    // one of them is wrong and both are published as authoritative — and the UID is the
    // schema's permanent identity (ADR-0008 D4).
    expect(constants.protocol.attestations.schemaUid).toBe(completionSchemaUid());
    expect(constants.protocol.attestations.schema).toBe(COMPLETION_SCHEMA);
  });

  it("records the derived checker hash", () => {
    // Same argument. ADR-0001 D5 pins checkerHash into every verdict so a six-month-old
    // verdict stays re-runnable; a stale value here misdirects anyone trying to do that.
    expect(constants.protocol.checker.checkerHash).toBe(getCheckerHash());
  });

  it("records the arbitration window the contract actually enforces", () => {
    // ARBITRATION_WINDOW is a Solidity constant (ADR-0006 A1.3), so it cannot drift within
    // a deployment — but it can drift from this file, which is what a reader would believe.
    // Recorded under `protocol` rather than per-network because it is bytecode, not config.
    expect(constants.protocol.arbitrationWindowSeconds).toBe(7 * 24 * 60 * 60);
  });

  it("keeps unknown values null rather than guessed", () => {
    // The convention the file states about itself. An absent or invented address reads as
    // "fine"; null reads as "not established yet", which is the truth and is actionable.
    const eas = constants.protocol.attestations;
    for (const key of ["easAddress", "schemaRegistryAddress"] as const) {
      for (const [network, value] of Object.entries(eas[key])) {
        // Either null, or a real-looking address — never a placeholder or empty string.
        if (value !== null) {
          expect(value, `${key}.${network}`).toMatch(/^0x[0-9a-fA-F]{40}$/);
        }
      }
    }
  });

  it("keeps the EAS EIP-712 envelope per-network, because it genuinely differs", () => {
    // Measured 2026-08-31: Base Sepolia runs EAS 1.2.0 and Base mainnet 1.0.1, at the SAME
    // predeploy address, with DIFFERENT getAttestTypeHash() values. A hard-coded envelope
    // therefore signs correctly on one network and is rejected by the other — and the
    // failure would surface at the mainnet migration, on the first attestation.
    //
    // Pinned so nobody collapses these into one value on the reasonable-looking grounds
    // that the addresses are identical. They are; the code behind them is not.
    const { attestTypeHash, domainSeparator, easVersion } = constants.protocol.attestations;
    expect(attestTypeHash["base-sepolia"]).not.toBe(attestTypeHash["base-mainnet"]);
    expect(domainSeparator["base-sepolia"]).not.toBe(domainSeparator["base-mainnet"]);
    expect(easVersion["base-sepolia"]).not.toBe(easVersion["base-mainnet"]);
    for (const map of [attestTypeHash, domainSeparator]) {
      for (const [network, value] of Object.entries(map)) {
        expect(value, network).toMatch(/^0x[0-9a-f]{64}$/);
      }
    }
  });

  it("does not claim a registration that has not happened", () => {
    // registered flips to true only once verify-eas-schema.mjs passes against that network.
    // Asserted so it cannot be set optimistically ahead of the transaction.
    const { registered, easAddress, schemaRegistryAddress } = constants.protocol.attestations;
    for (const network of Object.keys(registered)) {
      if (registered[network] === true) {
        expect(easAddress[network], `${network} registered but no EAS address`).not.toBeNull();
        expect(
          schemaRegistryAddress[network],
          `${network} registered but no registry address`,
        ).not.toBeNull();
      }
    }
  });
});
