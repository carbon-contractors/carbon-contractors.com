import { describe, expect, it } from "vitest";
import {
  explainContractError,
  explainWriteError,
  isWalletRejection,
  isWrongChainError,
} from "@/lib/contracts/reverts";

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

describe("explainContractError sentence matchers (NOR-346)", () => {
  // The real walkthrough failure: a Base Account staking attempt whose
  // UserOperation simulation failed with the ERC-20 balance check inside
  // the bundler's English wrapper message.
  const bundlerError = {
    name: "ExecutionRevertedError",
    message:
      "Failed to estimate gas for user operation: insufficient balance to perform useroperation: ERC20: transfer amount exceeds balance",
    cause: {
      name: "UserOperationRejected",
      message: "the ERC-20 transfer would exceed the account's balance",
    },
  };

  it("translates the ERC-4337 bundler + ERC-20 underfunded failure", () => {
    const text = explainContractError(bundlerError, FALLBACK);
    expect(text).toContain("doesn't hold enough USDC");
    expect(text).not.toBe(FALLBACK);
  });

  it("blames the token transfer, not gas, when both needles appear", () => {
    // The ERC-20 cause must win over the generic user-operation wrapper —
    // matching the wrapper first would tell the worker "gas", when the
    // refusal was the transfer.
    expect(text_of_bundler_only()).toContain("USDC");
  });

  function text_of_bundler_only() {
    return explainContractError(bundlerError, FALLBACK);
  }

  it("translates the generic insufficient-useroperation-balance case", () => {
    const err = {
      message: "insufficient balance to perform useroperation",
    };
    const text = explainContractError(err, FALLBACK);
    expect(text).toContain("balance is too low");
    expect(text).not.toBe(FALLBACK);
  });

  it("translates insufficient gas", () => {
    const err = { message: "insufficient funds for gas \"price\"" };
    const text = explainContractError(err, FALLBACK);
    expect(text).toContain("enough to pay gas");
    expect(text).not.toBe(FALLBACK);
  });

  it("still returns the fallback for unknown sentence shapes", () => {
    expect(explainContractError({ message: "totally novel failure" }, FALLBACK)).toBe(
      FALLBACK,
    );
  });
});

describe("explainWriteError (2026-09-28 walkthrough, NOR-321)", () => {
  const NET = "Base Sepolia";
  const FB = "submitWork was not sent.";

  it("names a wrong-network wallet instead of blaming the worker", () => {
    const err = { name: "SwitchChainError", cause: { code: 4902, message: "Unrecognized chain ID" } };
    expect(isWrongChainError(err)).toBe(true);
    const text = explainWriteError(err, FB, NET);
    expect(text).toContain("different network");
    expect(text).toContain(NET);
    expect(text).not.toContain("Cancelled");
  });

  it("catches viem's chain assertion when the switch did not take", () => {
    expect(
      isWrongChainError({
        name: "ContractFunctionExecutionError",
        cause: { name: "ChainMismatchError", message: "The current chain of the wallet (id: 1) does not match the target chain" },
      }),
    ).toBe(true);
  });

  it("still reads a declined switch prompt as a cancel, not a network fault", () => {
    const err = { name: "SwitchChainError", cause: { code: 4001 } };
    expect(explainWriteError(err, FB, NET)).toContain("Cancelled in your wallet");
  });

  it("keeps contract translations ahead of the fallback", () => {
    expect(explainWriteError(revertError("InvalidState(2, 3)"), FB, NET)).toContain("different state");
  });

  it("appends what the wallet said when nothing translates", () => {
    const err = { shortMessage: "Internal JSON-RPC error.\nDetails: whatever", cause: {} };
    expect(explainWriteError(err, FB, NET)).toBe(
      `${FB} Your wallet reported: "Internal JSON-RPC error."`,
    );
    expect(explainWriteError(undefined, FB, NET)).toBe(FB);
  });

  it("does not flag an ordinary revert or RPC fault as wrong-network", () => {
    expect(isWrongChainError(revertError("NotWorker()"))).toBe(false);
    expect(isWrongChainError(new Error("fetch failed"))).toBe(false);
  });
});
