/**
 * reverts.ts — translate contract-write failures into worker-facing sentences
 * (NOR-329, CC-101).
 *
 * The distinction that matters is the one the walkthrough named: "you rejected
 * the signature" is not "the contract rejected the call and here's why". A
 * wallet cancel is normal and blame-free; a revert means the chain said no for
 * a stated reason, and that reason is legible.
 *
 * Duck-typed on viem's error shapes rather than importing its classes — the
 * walk only needs `.cause`, `.code`, `.name`, `.details` and `.message`, which
 * keeps this testable with plain objects. And it stays honest about the thing
 * CLAUDE.md warns of: the deployed contract can be older than this ABI, so
 * anything undecodable returns the caller's fallback copy unchanged rather
 * than inventing a reason.
 *
 * Every mapping below is checked against the guards in CarbonEscrow.sol /
 * ReputationStake.sol (error names and their revert sites), not invented —
 * a translation that says the wrong thing is worse than the generic one.
 */

/** Names of the custom errors both contracts can emit, mapped to plain terms. */
const KNOWN_REVERTS: Record<string, string> = {
  // ── CarbonEscrow ──────────────────────────────────────────────────────────
  TaskAlreadyExists:
    "A task with this id already exists on-chain — ids can only be used once.",
  InvalidWorker:
    "The worker address on this task isn't valid, so the chain refused it.",
  ZeroAmount: "The amount must be greater than zero.",
  DeadlinePassed:
    "The task's deadline has passed, so this can no longer be done.",
  InvalidReviewWindow:
    "The review window is outside the allowed range (12 hours to 14 days).",
  InvalidState:
    "The task is in a different state than this action needs — refresh the dashboard and check its on-chain status.",
  NotParty: "Only this task's worker or hiring agent can do that.",
  NotWorker: "That action belongs to this task's worker, and your wallet isn't it.",
  NotAgent:
    "That action belongs to this task's hiring agent, and your wallet isn't it.",
  NotExpired: "The task hasn't expired yet, so there is nothing to reclaim.",
  ZeroEvidenceHash:
    "The evidence hash was empty — this shouldn't be reachable from the dashboard.",
  SpecAckMismatch:
    "The acceptance-spec acknowledgement doesn't match this task's committed spec — refresh the dashboard and try again.",
  ReviewWindowOpen:
    "The review window is still open — the plain claim becomes available when it closes.",
  ReviewWindowClosed:
    "The review window has closed, so a dispute can no longer be raised on this task.",
  ArbitrationWindowOpen:
    "The arbitration window is still running — the default-to-worker claim opens when it ends.",
  ArbitrationWindowClosed: "The arbitration window has already ended.",
  NotDisputed: "The task is not under dispute, so there is no arbitration claim to make.",
  VerdictTaskMismatch: "This verdict belongs to a different task.",
  VerdictCommitmentMismatch:
    "The evidence doesn't match what was committed at submission — claiming needs the exact submitted bundle.",
  VerdictExpiredError:
    "The verdict has expired — request a fresh one from the platform and try again.",
  VerdictNonceAlreadyUsed:
    "This verdict has already been used — request a fresh one from the platform.",
  VerdictSignerNotAccepted:
    "The verdict wasn't signed by an accepted signer — request a fresh verdict.",
  VerdictResultMismatch:
    "The verdict's outcome doesn't suit this action — claiming needs a passing verdict, disputing needs a failing one.",
  ZeroSigner: "The verdict signer was empty — this shouldn't be reachable from the dashboard.",

  // ── ReputationStake ───────────────────────────────────────────────────────
  BelowMinimumStake: "That would leave you below the platform's minimum stake.",
  CooldownNotElapsed:
    "Stake changes have a cooldown — try again once it has elapsed.",
  InsufficientStake: "You don't have enough staked for that.",
  InvalidUnstakeAmount: "That unstake amount doesn't match an existing stake.",
};

/**
 * Match on `Name(` — viem's decoded details always render the error name
 * immediately before its argument paren, and no name is a paren-suffixed
 * substring of another. Deliberately no regex escapes here: a word-boundary
 * written as a template-literal escape is a backspace character, not an
 * assertion, and that bug is invisible in the source.
 */
const NAME_MATCHERS = Object.keys(KNOWN_REVERTS)
  .sort((a, b) => b.length - a.length)
  .map((name) => ({ name, needle: `${name}(` }));

/** viem marks wallet cancels with code 4001 or UserRejectedRequestError. */
export function isWalletRejection(err: unknown): boolean {
  let node = err as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
    cause?: unknown;
  } | null;
  let depth = 0;
  while (node && typeof node === "object" && depth++ < 10) {
    if (node.code === 4001 || node.name === "UserRejectedRequestError") {
      return true;
    }
    if (typeof node.message === "string") {
      const m = node.message.toLowerCase();
      if (m.includes("user rejected") || m.includes("user denied")) return true;
    }
    node = node.cause as typeof node;
  }
  return false;
}

/** Walk the cause chain looking for a custom-error name we can translate. */
function findRevertName(err: unknown): string | null {
  let node = err as {
    name?: unknown;
    details?: unknown;
    shortMessage?: unknown;
    message?: unknown;
    cause?: unknown;
  } | null;
  let depth = 0;
  while (node && typeof node === "object" && depth++ < 10) {
    const strings = [node.name, node.details, node.shortMessage, node.message];
    for (const value of strings) {
      if (typeof value !== "string") continue;
      for (const { name, needle } of NAME_MATCHERS) {
        if (value.includes(needle)) return name;
      }
    }
    node = node.cause as typeof node;
  }
  return null;
}

/**
 * The worker-facing sentence for a failed contract write: the wallet-cancel
 * case, a translation when the chain stated a known reason, or the caller's
 * fallback copy for anything undecodable (RPC faults, unknown contracts).
 */
export function explainContractError(err: unknown, fallback: string): string {
  if (isWalletRejection(err)) {
    return "Cancelled in your wallet — nothing was sent.";
  }
  const reason = findRevertName(err);
  if (reason) {
    return KNOWN_REVERTS[reason];
  }
  return fallback;
}
