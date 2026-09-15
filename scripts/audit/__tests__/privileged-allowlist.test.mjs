import { describe, it, expect } from "vitest";
import { DEFAULT_ALLOWLIST, matchEvent, isAuthorised } from "../privileged-allowlist.mjs";

// The matcher's correctness is load-bearing in both directions: a false NEGATIVE
// pages the owner for a benign authorised event (alert fatigue, the ADR-0003
// failure mode); a false POSITIVE green-lights an actual ownership takeover — the
// exact compromise this monitor exists to catch. The first inline draft shipped a
// false negative on every OwnershipTransferred ever emitted, because the allowlist
// used `from`/`to` while the decoded event carries `previousOwner`/`newOwner`, and
// live-running the monitor was the only thing that surfaced it. These tests exist
// so that class of bug cannot ship again.

const OWN_1 = DEFAULT_ALLOWLIST[0]; // constructor transfer
const OWN_2 = DEFAULT_ALLOWLIST[2]; // HSM handover
const VSU_1 = DEFAULT_ALLOWLIST[1]; // signer acceptance

describe("matchEvent — exact matching", () => {
  it("matches an allowlisted OwnershipTransferred with decoded field names", () => {
    const event = {
      kind: "OwnershipTransferred",
      tx: OWN_1.tx,
      block: 46227900,
      args: {
        previousOwner: "0x0000000000000000000000000000000000000000",
        newOwner: "0x7863a5c4396e7aaac2e99cb649a7aa4f6a36b91b", // lowercase, as viem checksums may vary
      },
    };
    expect(matchEvent(event, OWN_1)).toBe(true);
  });

  it("matches an allowlisted VerdictSignerUpdated including the boolean arg", () => {
    const event = {
      kind: "VerdictSignerUpdated",
      tx: VSU_1.tx,
      block: 46227900,
      args: { signer: "0xa8931097540e69B474013D294d0bA6A2cC853e4b", accepted: true },
    };
    expect(matchEvent(event, VSU_1)).toBe(true);
  });

  it("rejects a different tx hash at the same block — event identity is tx, not block", () => {
    const event = {
      kind: "OwnershipTransferred",
      tx: "0x" + "ab".repeat(32),
      block: 46227900,
      args: {
        previousOwner: "0x0000000000000000000000000000000000000000",
        newOwner: "0x7863A5c4396E7aaac2e99Cb649a7Aa4F6A36B91b",
      },
    };
    expect(matchEvent(event, OWN_1)).toBe(false);
  });

  it("rejects the same tx with a different newOwner — a compromised replay is not the same event", () => {
    const event = {
      kind: "OwnershipTransferred",
      tx: OWN_1.tx,
      block: 46227900,
      args: {
        previousOwner: "0x0000000000000000000000000000000000000000",
        newOwner: "0xdead000000000000000000000000000000000dead",
      },
    };
    expect(matchEvent(event, OWN_1)).toBe(false);
  });

  it("rejects an entry missing a decoded field — the from/to bug shape", () => {
    // An allowlist entry written with synonym keys matches nothing, silently. The
    // matcher must treat a missing expected field as a non-match, not undefined==undefined.
    const entryWithWrongKeys = {
      kind: "OwnershipTransferred",
      tx: OWN_1.tx,
      block: 46227900,
      from: "0x0000000000000000000000000000000000000000",
      to: "0x7863A5c4396E7aaac2e99Cb649a7Aa4F6A36B91b",
    };
    const event = {
      kind: "OwnershipTransferred",
      tx: OWN_1.tx,
      block: 46227900,
      args: {
        previousOwner: "0x0000000000000000000000000000000000000000",
        newOwner: "0x7863A5c4396E7aaac2e99Cb649a7Aa4F6A36B91b",
      },
    };
    expect(matchEvent(event, entryWithWrongKeys)).toBe(false);
  });

  it("rejects signer deactivation on the production signer", () => {
    const event = {
      kind: "VerdictSignerUpdated",
      tx: "0x" + "cd".repeat(32),
      block: 46800000,
      args: { signer: "0xa8931097540e69B474013D294d0bA6A2cC853e4b", accepted: false },
    };
    expect(isAuthorised(event)).toBe(false);
  });

  it("matches the full real history — all three production events are authorised", () => {
    const history = [
      {
        kind: "OwnershipTransferred",
        tx: OWN_1.tx,
        block: 46227900,
        args: {
          previousOwner: "0x0000000000000000000000000000000000000000",
          newOwner: "0x7863A5c4396E7aaac2e99Cb649a7Aa4F6A36B91b",
        },
      },
      {
        kind: "VerdictSignerUpdated",
        tx: VSU_1.tx,
        block: 46227900,
        args: { signer: "0xa8931097540e69B474013D294d0bA6A2cC853e4b", accepted: true },
      },
      {
        kind: "OwnershipTransferred",
        tx: OWN_2.tx,
        block: 46228351,
        args: {
          previousOwner: "0x7863A5c4396E7aaac2e99Cb649a7Aa4F6A36B91b",
          newOwner: "0xa8931097540e69B474013D294d0bA6A2cC853e4b",
        },
      },
    ];
    expect(history.every((e) => isAuthorised(e))).toBe(true);
  });

  it("handles bigint args from viem decoding", () => {
    const event = {
      kind: "VerdictNonceRevoked",
      tx: "0x" + "ef".repeat(32),
      block: 46800000,
      args: { signer: "0xa8931097540e69B474013D294d0bA6A2cC853e4b", nonce: 3n },
    };
    const entry = {
      kind: "VerdictNonceRevoked",
      tx: "0x" + "ef".repeat(32),
      block: 46800000,
      signer: "0xa8931097540e69B474013D294d0bA6A2cC853e4b",
      nonce: 3,
    };
    expect(matchEvent(event, entry)).toBe(true);
    expect(
      matchEvent(event, { ...entry, nonce: 4 }),
    ).toBe(false);
  });
});
