/**
 * escrow.ts
 * Server-side read-only client for the CarbonEscrow contract.
 * Uses viem's publicClient to query on-chain task state.
 *
 * Write operations (createTask, completeTask, etc.) happen client-side
 * via the worker's connected wallet or server-side via the platform signer
 * (see signer.ts).
 */

import { createPublicClient, http, keccak256, toHex, parseAbiItem, type Address } from "viem";
import { baseSepolia, base } from "viem/chains";
import { CARBON_ESCROW_ABI } from "./escrow-abi";
import { getConfig } from "@/lib/config";
import { log } from "@/lib/logging";

// ── Lazy-initialized client ─────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _publicClient: any = null;

function getPublicClient() {
  if (_publicClient) return _publicClient;
  const config = getConfig();
  const chain = config.NEXT_PUBLIC_BASE_NETWORK === "mainnet" ? base : baseSepolia;
  const rpcUrl = config.NEXT_PUBLIC_BASE_NETWORK === "mainnet"
    ? (config.BASE_MAINNET_RPC_URL ?? chain.rpcUrls.default.http[0])
    : (config.BASE_SEPOLIA_RPC_URL ?? chain.rpcUrls.default.http[0]);
  _publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
    // CC-070: collapses concurrent readContract calls into a single multicall3
    // request. getOnChainReputationSummary reads getTask() once per task, so a
    // worker with 20 tasks costs one HTTP round trip rather than 20.
    batch: { multicall: true },
  });
  return _publicClient;
}

/** Test seam — drops the memoised client so config changes take effect. */
export function __resetEscrowClientForTests() {
  _publicClient = null;
}

// ── Block-range bounds (CC-070) ─────────────────────────────────────────────

/**
 * Lower bound for every event query: the block the escrow was deployed at.
 *
 * Without this, queries start at genesis. Base Sepolia was ~45.4M blocks deep on
 * 2026-08-11 against a deploy block of 39,032,720 — so genesis costs ~22,700
 * chunked requests per query versus ~635 from the deploy block. Neither is fast,
 * which is why the request-time reputation path no longer uses events at all; but
 * the bound still matters for the recovery path that does.
 */
function getDefaultFromBlock(): bigint {
  const configured = getConfig().ESCROW_DEPLOY_BLOCK;
  if (configured === undefined) {
    log("warn", "escrow_deploy_block_unset", {
      hint: "Set ESCROW_DEPLOY_BLOCK — see scripts/audit/find-deploy-block.mjs. Falling back to genesis.",
    });
    return BigInt(0);
  }
  return BigInt(configured);
}

interface ChunkedLogsOptions {
  address: Address;
  // viem's parseAbiItem return type is structurally awkward to name here, and the
  // client is already `any` for the same reason.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args?: any;
  fromBlock?: bigint;
  toBlock?: bigint;
  /** Walk newest-to-oldest. Pair with stopWhen to exit before scanning history. */
  newestFirst?: boolean;
  /** Called after each chunk; return true to stop early. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stopWhen?: (accumulated: any[]) => boolean;
}

/**
 * eth_getLogs, split into windows the RPC provider will actually accept.
 *
 * Providers cap the span of a single eth_getLogs call. The public Base Sepolia
 * endpoint rejects anything over 10,000 blocks with "eth_getLogs is limited to a
 * 10,000 range"; CC-070 was filed when that limit read 2,000, so the cap comes from
 * RPC_MAX_BLOCK_RANGE rather than a constant.
 *
 * Results are returned in ascending block order regardless of scan direction.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getLogsChunked(opts: ChunkedLogsOptions): Promise<any[]> {
  const pub = getPublicClient();
  const span = BigInt(getConfig().RPC_MAX_BLOCK_RANGE);

  const from = opts.fromBlock ?? getDefaultFromBlock();
  const to = opts.toBlock ?? (await pub.getBlockNumber());
  if (to < from) return [];

  // Half-open windows of at most `span` blocks, inclusive of both ends.
  const windows: Array<[bigint, bigint]> = [];
  for (let start = from; start <= to; start += span) {
    const end = start + span - BigInt(1);
    windows.push([start, end > to ? to : end]);
  }
  if (opts.newestFirst) windows.reverse();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const collected: any[] = [];
  for (const [fromBlock, toBlock] of windows) {
    const logs = await pub.getLogs({
      address: opts.address,
      event: opts.event,
      ...(opts.args ? { args: opts.args } : {}),
      fromBlock,
      toBlock,
    });
    collected.push(...logs);
    if (opts.stopWhen?.(collected)) break;
  }

  collected.sort((a, b) => {
    const ab = BigInt(a.blockNumber ?? 0);
    const bb = BigInt(b.blockNumber ?? 0);
    if (ab !== bb) return ab < bb ? -1 : 1;
    return Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0);
  });
  return collected;
}

function getEscrowAddr(): Address | undefined {
  return getConfig().NEXT_PUBLIC_ESCROW_CONTRACT as Address | undefined;
}

// ── Task state enum (mirrors Solidity) ──────────────────────────────────────

/**
 * Mirrors `CarbonEscrow.TaskState`.
 *
 * **The numbers changed in v2 (CC-082) and are not backwards compatible.** `Completed`
 * was 2 and is now 3; every value above `Funded` shifted. Nothing reads a persisted copy
 * of the old numbering — the DB stores its own status strings, not these — but any
 * hard-coded integer found against the old deployment is wrong now.
 */
export const TaskStateEnum = {
  0: "None",
  1: "Funded",
  2: "Delivered",
  3: "Completed",
  4: "Disputed",
  5: "Arbitrating",
  6: "Resolved",
  7: "Expired",
} as const;

export type OnChainTaskState =
  (typeof TaskStateEnum)[keyof typeof TaskStateEnum];

export interface OnChainTask {
  agent: Address;
  worker: Address;
  amount: bigint;
  deadline: bigint;
  state: OnChainTaskState;
  stateRaw: number;
  /** Seconds the agent has to act after submission, chosen by the agent at funding. */
  reviewWindow: number;
  /** Unix seconds of `submitWork`, or 0 if nothing has been delivered yet. */
  submittedAt: bigint;
  /** When the worker may call `releaseAfterReview`. Meaningless while `submittedAt` is 0. */
  reviewDeadline: bigint;
  /** Commitment to the acceptance criteria, written by the agent at funding. */
  specHash: `0x${string}`;
  /** Commitment to the submission, written by the worker at delivery. */
  evidenceHash: `0x${string}`;
  /** EIP-712 digest of the verdict presented, or the zero hash if none was. */
  verdictHash: `0x${string}`;
  /** Only meaningful when `verdictHash` is non-zero. */
  verdictPassed: boolean;
  /** CC-036 slot — EAS attestation UID. Zero until EAS lands. */
  attestationUid: `0x${string}`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a payment_request_id string to the bytes32 taskId used on-chain.
 */
export function toTaskId(paymentRequestId: string): `0x${string}` {
  return keccak256(toHex(paymentRequestId));
}

function getEscrowAddress(): Address {
  const addr = getEscrowAddr();
  if (!addr) {
    throw new Error(
      "NEXT_PUBLIC_ESCROW_CONTRACT not set. Deploy the contract first."
    );
  }
  return addr;
}

// ── Read functions ──────────────────────────────────────────────────────────

/**
 * Read a task's on-chain state from the escrow contract.
 */
export async function getOnChainTask(
  paymentRequestId: string
): Promise<OnChainTask> {
  const taskId = toTaskId(paymentRequestId);
  const result = await getPublicClient().readContract({
    address: getEscrowAddress(),
    abi: CARBON_ESCROW_ABI,
    functionName: "getTask",
    args: [taskId],
  });

  const stateRaw = Number(result.state);
  const submittedAt = BigInt(result.submittedAt);
  const reviewWindow = Number(result.reviewWindow);

  return {
    agent: result.agent as Address,
    worker: result.worker as Address,
    amount: result.amount as bigint,
    deadline: BigInt(result.deadline),
    state: TaskStateEnum[stateRaw as keyof typeof TaskStateEnum] ?? "None",
    stateRaw,
    reviewWindow,
    submittedAt,
    reviewDeadline: submittedAt + BigInt(reviewWindow),
    specHash: result.specHash as `0x${string}`,
    evidenceHash: result.evidenceHash as `0x${string}`,
    verdictHash: result.verdictHash as `0x${string}`,
    verdictPassed: Boolean(result.verdictPassed),
    attestationUid: result.attestationUid as `0x${string}`,
  };
}

/**
 * Get total USDC currently locked in the escrow contract.
 */
export async function getTotalLocked(): Promise<bigint> {
  return getPublicClient().readContract({
    address: getEscrowAddress(),
    abi: CARBON_ESCROW_ABI,
    functionName: "totalLocked",
  });
}

/**
 * Look up how a task was actually resolved on-chain, from the TaskResolved event.
 * Used for partial-failure recovery: if a prior resolveDispute call succeeded on-chain
 * but the DB update afterward failed, this recovers the true outcome instead of trusting
 * a possibly-stale or mismatched retry argument.
 */
export async function getTaskResolvedOutcome(
  paymentRequestId: string,
): Promise<{ releasedToWorker: boolean; amount: bigint } | null> {
  const taskId = toTaskId(paymentRequestId);

  // Scanned newest-first with an early exit. This is a recovery path for a
  // resolution that just failed to persist, so the event is almost always in the
  // most recent window — which turns the common case into one request instead of
  // the ~635 a full ascending scan of the deployed range would cost. A task that
  // was never resolved still costs the full scan, correctly returning null.
  const logs = await getLogsChunked({
    address: getEscrowAddress(),
    event: parseAbiItem(
      "event TaskResolved(bytes32 indexed taskId, bool releasedToWorker, uint256 amount)"
    ),
    args: { taskId },
    newestFirst: true,
    stopWhen: (found) => found.length > 0,
  });

  // taskId is indexed and a task can only be resolved once, so at most one log
  // matches — but take the last in block order rather than assuming that.
  const last = logs.at(-1);
  if (!last) return null;
  return {
    releasedToWorker: last.args.releasedToWorker as boolean,
    amount: last.args.amount as bigint,
  };
}

// ── Event queries (on-chain reputation) ─────────────────────────────────────

const USDC_DECIMALS = 6;

/**
 * Every taskId ever assigned to a worker, discovered from TaskCreated events.
 *
 * **Do not call this on a request path.** It scans the full deployed block range in
 * RPC_MAX_BLOCK_RANGE windows — about 635 requests against Base Sepolia as of
 * 2026-08-11, and it grows with chain length forever. It exists as an offline
 * completeness check: it is the only way to find a task that exists on-chain but is
 * absent from the `tasks` table, which is the one blind spot of the DB-discovery
 * approach getOnChainReputationSummary now uses.
 *
 * Use it from a script or an audit, and compare its output against the DB.
 */
export async function getTaskIdsForWorkerFromEvents(
  worker: Address,
  fromBlock?: bigint,
): Promise<`0x${string}`[]> {
  const logs = await getLogsChunked({
    address: getEscrowAddress(),
    event: parseAbiItem(
      "event TaskCreated(bytes32 indexed taskId, address indexed agent, address indexed worker, uint256 amount, uint64 deadline, uint32 reviewWindow, bytes32 specHash)"
    ),
    args: { worker },
    fromBlock,
  });
  return logs.map((l: { args: { taskId: `0x${string}` } }) => l.args.taskId);
}

/**
 * Every taskId a worker has actually delivered against, from WorkSubmitted events.
 *
 * Same cost warning as `getTaskIdsForWorkerFromEvents` — full-range scan, offline use
 * only. It exists because CC-075's AWOL trigger is the *difference* between the two sets:
 * N consecutive expiries with zero submissions means the worker stopped showing up, which
 * in v1 was indistinguishable from an agent that would not accept.
 */
export async function getSubmittedTaskIdsForWorkerFromEvents(
  worker: Address,
  fromBlock?: bigint,
): Promise<`0x${string}`[]> {
  const logs = await getLogsChunked({
    address: getEscrowAddress(),
    event: parseAbiItem(
      "event WorkSubmitted(bytes32 indexed taskId, address indexed worker, bytes32 evidenceHash, uint64 submittedAt, bytes32 attestationUid)"
    ),
    args: { worker },
    fromBlock,
  });
  return logs.map((l: { args: { taskId: `0x${string}` } }) => l.args.taskId);
}

export interface OnChainReputationSummary {
  total_tasks: number;
  completed: number;
  /** Disputes raised but not yet arbitrated (on-chain state `Disputed`). */
  disputed: number;
  /** Disputes the owner has accepted for adjudication (on-chain state `Arbitrating`). */
  arbitrating: number;
  /** Disputes arbitrated by the owner (on-chain state `Resolved`). */
  resolved: number;
  expired: number;
  funded: number;
  /**
   * Work submitted, review window still running (on-chain state `Delivered`).
   *
   * Counted separately from `funded` on purpose: the difference between the two is the
   * signal CC-075 needs, and it is the whole reason v2 exists. A task sitting in `Funded`
   * past its deadline is a worker who did not show up; one sitting in `Delivered` is an
   * agent who has not looked yet. v1 could not tell those apart.
   */
  delivered: number;
  total_earned_usdc: number;
  /**
   * payment_request_ids the chain confirms as `Completed`. The caller pairs these
   * with its own timestamps for recency scoring — see the note below on why the
   * timestamps do not come from here.
   */
  completedPaymentRequestIds: string[];
  /**
   * ids that were offered for verification but which the chain does not corroborate:
   * no task at that id, or a task whose `worker` is someone else. These are excluded
   * from every count above. A non-empty list means the DB and the chain disagree.
   */
  unverified: string[];
}

/**
 * Build a reputation summary for a worker from authoritative on-chain state.
 *
 * **Why this takes ids instead of discovering them (CC-070).** It used to scan
 * TaskCreated events to find a worker's tasks, with `fromBlock` defaulting to
 * genesis. Every such query failed against the block-range cap, so `/api/reputation`
 * silently fell back to the DB for the entire life of the project. Chunking alone
 * does not rescue it: Base Sepolia is ~6.35M blocks past the escrow's deploy block,
 * which is ~635 requests per query and four queries per summary.
 *
 * So discovery and authority are now separated. The caller supplies candidate
 * `payment_request_id`s — cheaply, from the `tasks` table — and this function reads
 * the real state of each one from the contract with `getTask()`, batched into a single
 * multicall. **Every fact that matters for money still comes from the chain:** state,
 * amount, and the worker address, which is re-checked against `wallet` so a DB row
 * cannot attribute someone else's task. The DB only proposes which ids to look at.
 * That keeps the "DB is not the authority on money" rule in CLAUDE.md intact.
 *
 * The blind spot, stated plainly: a task that exists on-chain but not in the `tasks`
 * table is invisible here. `getTaskIdsForWorkerFromEvents` is the offline check for
 * that, and CC-081 Defect 3 is the drift it guards against.
 *
 * Two deliberate gaps:
 *  - **Recency has no on-chain timestamp.** `getTask()` returns no block or time, and
 *    fetching a block per completion would reintroduce per-task round trips. The
 *    caller scores recency from its own timestamps, over the set of completions the
 *    chain confirms. Soft ordering from the DB, hard facts from the chain.
 *  - **`Resolved` tasks are excluded from earnings.** The state alone does not say
 *    which way the owner arbitrated; only the `TaskResolved` event does, and that is
 *    a per-task event lookup. They are counted separately rather than guessed at.
 */
export async function getOnChainReputationSummary(
  wallet: string,
  paymentRequestIds: string[],
): Promise<OnChainReputationSummary> {
  const empty: OnChainReputationSummary = {
    total_tasks: 0,
    completed: 0,
    disputed: 0,
    arbitrating: 0,
    resolved: 0,
    expired: 0,
    funded: 0,
    delivered: 0,
    total_earned_usdc: 0,
    completedPaymentRequestIds: [],
    unverified: [],
  };
  if (paymentRequestIds.length === 0) return empty;

  const escrow = getEscrowAddress();
  const pub = getPublicClient();
  const workerLower = wallet.toLowerCase();

  // One multicall3 round trip — the client is configured with batch.multicall.
  const states = await Promise.all(
    paymentRequestIds.map((id) =>
      pub.readContract({
        address: escrow,
        abi: CARBON_ESCROW_ABI,
        functionName: "getTask",
        args: [toTaskId(id)],
      }),
    ),
  );

  const summary: OnChainReputationSummary = { ...empty };

  for (let i = 0; i < paymentRequestIds.length; i++) {
    const id = paymentRequestIds[i];
    const task = states[i];
    const stateRaw = Number(task.state);

    // state None means no such task on-chain; a worker mismatch means the DB row
    // claims a task that on-chain belongs to somebody else. Neither is countable.
    if (stateRaw === 0 || String(task.worker).toLowerCase() !== workerLower) {
      summary.unverified.push(id);
      continue;
    }

    summary.total_tasks++;

    switch (TaskStateEnum[stateRaw as keyof typeof TaskStateEnum]) {
      case "Completed":
        summary.completed++;
        summary.total_earned_usdc += Number(task.amount) / 10 ** USDC_DECIMALS;
        summary.completedPaymentRequestIds.push(id);
        break;
      case "Disputed":
        summary.disputed++;
        break;
      case "Arbitrating":
        summary.arbitrating++;
        break;
      case "Resolved":
        summary.resolved++;
        break;
      case "Expired":
        summary.expired++;
        break;
      case "Funded":
        summary.funded++;
        break;
      case "Delivered":
        summary.delivered++;
        break;
    }
  }

  if (summary.unverified.length > 0) {
    log("warn", "reputation_onchain_unverified_tasks", {
      count: summary.unverified.length,
      offered: paymentRequestIds.length,
    });
  }

  return summary;
}

/**
 * Get the escrow contract address and chain info for client-side use.
 */
export function getEscrowConfig() {
  const config = getConfig();
  const chain = config.NEXT_PUBLIC_BASE_NETWORK === "mainnet" ? base : baseSepolia;
  return {
    address: (config.NEXT_PUBLIC_ESCROW_CONTRACT as Address) ?? null,
    chainId: chain.id,
    chainName: chain.name,
    usdcDecimals: 6,
  };
}
