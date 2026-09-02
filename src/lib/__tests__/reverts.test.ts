import { describe, expect, it } from "vitest";
import { explainContractError, isWalletRejection } from "@/lib/contracts/reverts";

/**
 * NOR-329 — the translator is duck-typed on viem's error shapes, so these
 * tests use plain objects that mirror what viem actually produces: a BaseError
 * chain with `.cause` links, `.name` per class, `.details` carrying the
 * decoded revert (e.g. "InvalidState(2, 3)"), and code 4001 for wallet cancels.
 */

const FALLBACK = "submitWork was not sent — cancelled or rejected in your wallet.";

function revertError(details: string) {
  return {
    name: "ContractFunctionRevertedError",
    details,
    shortMessage: `The contract function reverted. Error message: ${details}`,
    cause: { name: "CallExecutionError", message: "call revert data" },
  };
}

describe("isWalletRejection (NOR-329)", () => {
  it("detects code 4001 and viem's user-rejection class, nested or not", () => {
    expect(isWalletRejection({ code: 4001 })).toBe(true);
    expect(isWalletRejection({ name: "UserRejectedRequestError" })).toBe(true);
    expect(
      isWalletRejection({ cause: { cause: { code: 4001 } } }),
    ).toBe(true);
  });

  it("detects phrased rejections and nothing else", () => {
    expect(isWalletRejection({ message: "User rejected the request." })).toBe(true);
    expect(isWalletRejection({ message: "execution reverted" })).toBe(false);
    expect(isWalletRejection(null)).toBe(false);
  });
});

describe("explainContractError (NOR-329)", () => {
  it("translates a known custom error from the decoded details", () => {
    const text = explainContractError(
      revertError("InvalidState(2, 3)"),
      FALLBACK,
    );
    expect(text).toContain("different state");
    expect(text).not.toBe(FALLBACK);
  });

  it("translates each of the review-window and verdict family distinctly", () => {
    expect(explainContractError(revertError("ReviewWindowOpen()"), FALLBACK)).toContain(
      "review window is still open",
    );
    expect(
      explainContractError(revertError("VerdictCommitmentMismatch()"), FALLBACK),
    ).toContain("committed at submission");
    expect(
      explainContractError(revertError("InsufficientStake()"), FALLBACK),
    ).toContain("enough staked");
  });

  it("prefers the wallet-cancel sentence even when a revert name is also present", () => {
    const err = {
      code: 4001,
      name: "ContractFunctionRevertedError",
      details: "InvalidState()",
    };
    expect(explainContractError(err, FALLBACK)).toContain("Cancelled in your wallet");
  });

  it("returns the caller's fallback for unknown reverts, RPC faults, and junk", () => {
    expect(explainContractError(revertError("SomethingElse(1)"), FALLBACK)).toBe(FALLBACK);
    expect(explainContractError(new Error("fetch failed"), FALLBACK)).toBe(FALLBACK);
    expect(explainContractError(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it("does not mistake its own vocabulary inside unrelated text", () => {
    // The class name ContractFunctionRevertedError contains no error name, but
    // a message merely mentioning a window must not match ReviewWindowOpen.
    expect(explainContractError(revertError("the window is closed"), FALLBACK)).toBe(FALLBACK);
  });
});
