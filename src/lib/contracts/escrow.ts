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

/**
 * The latest block's timestamp, in Unix seconds.
 *
 * CC-092: `/api/fund-task` uses this to record `tasks.funded_at` at the moment it
 * confirms `Funded` on-chain — the checker's `captured_after:
 * "task_funding_block_timestamp"` criterion needs a funding time, and the `Task`
 * struct has no field for it. The alternative, scanning for the `TaskCreated` event,
 * is exactly the `eth_getLogs` cost `CC-070` exists to bound; reading it here costs
 * one more read at a call the route already makes, instead of a historical scan.
 * Approximate by design: confirmation happens moments after funding, and this is an
 * anti-fraud threshold, not a fund-safety one.
 */
export async function getCurrentBlockTimestamp(): Promise<number> {
  const block = await getPublicClient().getBlock();
  return Number(block.timestamp);
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

/**
 * `CarbonEscrow.ARBITRATION_WINDOW` — 7 days (ADR-0006 A1.3).
 *
 * A contract **constant**, which is what makes mirroring it here safe rather than a
 * guess: there is no setter, so it cannot drift within a deployment. It can still drift
 * *across* deployments, and `arbitrationClock` on the read below is what tells you the
 * deployed contract has the clock at all.
 */
export const ARBITRATION_WINDOW_SECONDS = 7 * 24 * 60 * 60;

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
  /** Unix seconds of `disputeTask`, or 0 if the task was never disputed. */
  disputedAt: bigint;
  /**
   * When the worker may call `releaseAfterArbitration`. Meaningless while `disputedAt`
   * is 0 — it lands in 1970, i.e. always in the past. Gate on `state` first.
   */
  arbitrationDeadline: bigint;
  /**
   * Whether the **deployed** contract has the ADR-0006 D3 arbitration clock at all.
   *
   * False against any escrow deployed before 2026-08-28, where a disputed task has no
   * clock and only the owner can end it. The dashboard must not offer a timeout claim
   * in that case: the function does not exist and the call would revert, which to a
   * worker reads as being refused their money.
   */
  arbitrationClock: boolean;
  /** CC-036 slot — EAS attestation UID. Zero until EAS lands. */
  attestationUid: `0x${string}`;
}

// ── Reading an escrow older than this ABI ───────────────────────────────────

/**
 * `getTask` as it returns from every escrow deployed **before** the ADR-0006 D3
 * arbitration clock — twelve fields, no `disputedAt`.
 *
 * **A historical record. Never edit it.** It exists because the app's ABI and the
 * deployed bytecode are separate pieces of config, so "new code against an old address"
 * is a normal intermediate state at every redeploy, not an error. Without this the
 * mismatch surfaced as a decode throw, `/api/tasks` swallowed it into `on_chain: null`,
 * and the dashboard silently dropped every worker action — a blank panel where the
 * claim button used to be, with nothing anywhere saying why.
 *
 * Positional, like all tuple ABIs: the field order is the storage-packing order in
 * `CarbonEscrow.sol`, not the readable one.
 */
const LEGACY_GET_TASK_ABI = [
  {
    type: "function",
    name: "getTask",
    stateMutability: "view",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "agent", type: "address" },
          { name: "deadline", type: "uint64" },
          { name: "reviewWindow", type: "uint32" },
          { name: "worker", type: "address" },
          { name: "submittedAt", type: "uint64" },
          { name: "state", type: "uint8" },
          { name: "verdictPassed", type: "bool" },
          { name: "amount", type: "uint256" },
          { name: "specHash", type: "bytes32" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "verdictHash", type: "bytes32" },
          { name: "attestationUid", type: "bytes32" },
        ],
      },
    ],
  },
] as const;

/**
 * viem's decode errors for "the returndata is narrower than the ABI says".
 *
 * Deliberately narrow. Retrying on *any* read failure would mask a wrong address, a
 * reverting call or an RPC fault as "old deployment" and then quietly report the legacy
 * shape for something that is not an escrow at all. Measured against a stubbed transport
 * returning twelve words: `ContractFunctionExecutionError -> PositionOutOfBoundsError`.
 */
const WIDTH_MISMATCH_ERRORS = new Set([
  "PositionOutOfBoundsError",
  "AbiDecodingDataSizeTooSmallError",
  "SliceOffsetOutOfBoundsError",
]);

function isAbiWidthMismatch(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; cursor && depth < 8; depth++) {
    const name = (cursor as { name?: string }).name;
    if (name && WIDTH_MISMATCH_ERRORS.has(name)) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/** The decoded struct, plus whether it came from a contract that has the clock. */
interface RawTaskRead {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
  arbitrationClock: boolean;
}

/**
 * Read one task, tolerating an escrow deployed before the arbitration clock.
 *
 * The happy path costs nothing extra — current ABI, one batched `readContract`. The
 * fallback only fires on a decode-width mismatch, and concurrent callers still batch,
 * so a worker with twenty tasks against a legacy deployment costs two multicalls rather
 * than twenty-one.
 */
async function readTaskStruct(taskId: `0x${string}`, escrow: Address): Promise<RawTaskRead> {
  const pub = getPublicClient();
  try {
    return {
      result: await pub.readContract({
        address: escrow,
        abi: CARBON_ESCROW_ABI,
        functionName: "getTask",
        args: [taskId],
      }),
      arbitrationClock: true,
    };
  } catch (err) {
    if (!isAbiWidthMismatch(err)) throw err;
    // Loud, because the two readings are very different: either a redeploy is mid-flight
    // and this is expected for a few minutes, or NEXT_PUBLIC_ESCROW_CONTRACT is pointing
    // at a contract nobody meant it to point at.
    log("warn", "escrow_abi_predates_deployment", {
      escrow,
      detail: "getTask returned the pre-ADR-0006 tuple; reading without disputedAt",
    });
    return {
      result: await pub.readContract({
        address: escrow,
        abi: LEGACY_GET_TASK_ABI,
        functionName: "getTask",
        args: [taskId],
      }),
      arbitrationClock: false,
    };
  }
}

/** Shared shaping, so the two getTask call sites cannot drift. */
function toOnChainTask(read: RawTaskRead): OnChainTask {
  const { result, arbitrationClock } = read;
  const stateRaw = Number(result.state);
  const submittedAt = BigInt(result.submittedAt);
  const reviewWindow = Number(result.reviewWindow);
  const disputedAt = BigInt(result.disputedAt ?? 0);

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
    disputedAt,
    arbitrationDeadline: disputedAt + BigInt(ARBITRATION_WINDOW_SECONDS),
    arbitrationClock,
    attestationUid: result.attestationUid as `0x${string}`,
  };
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
  return toOnChainTask(await readTaskStruct(taskId, getEscrowAddress()));
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
  const workerLower = wallet.toLowerCase();

  // One multicall3 round trip — the client is configured with batch.multicall. Routed
  // through readTaskStruct so an escrow older than this ABI degrades the way it does on
  // the dashboard instead of throwing, which here would zero a worker's whole reputation
  // and read to them as having never worked.
  const states = (
    await Promise.all(paymentRequestIds.map((id) => readTaskStruct(toTaskId(id), escrow)))
  ).map((read) => read.result);

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
