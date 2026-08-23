/**
 * server.ts
 * Per-session McpServer factory.
 * Registers all tools and resources for the Base-Human marketplace.
 * Output is intentionally terse and machine-optimized (no markdown, no prose).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  searchByCategory,
  getAllHumans,
  getHumanByWallet,
  getHumanById,
  getDistinctCategories,
} from "@/lib/db/whitepages";
import { initiateX402Payment, replayX402Payment } from "@/lib/payments/x402";
import {
  getTaskByPaymentId,
  updateTaskStatus,
  countCommittedTasks,
  findTaskByIdempotencyKey,
  WORKER_CONCURRENCY_CAP,
} from "@/lib/db/tasks";
import { getFullReputation } from "@/lib/reputation";
import {
  registerNotificationChannel,
  getChannelsForContractor,
} from "@/lib/db/notifications";
import { notifyContractor } from "@/lib/notifications/dispatch";
import { toolError } from "@/lib/mcp/errors";
import {
  getOnChainTask,
  getEscrowConfig,
  toTaskId,
  getTaskResolvedOutcome,
} from "@/lib/contracts/escrow";
import { resolveDisputeOnChain } from "@/lib/contracts/signer";
import {
  computeAndSignVerdict,
  VerdictInputError,
} from "@/lib/contracts/verdict-service";
import { serializeVerdict } from "@/lib/contracts/verdict-json";
import { getReputationStakeConfig } from "@/lib/contracts/reputation";
import { taskCreationRateLimiter } from "@/lib/ratelimit";
import { parseAndHashSpec, SpecValidationError } from "@/lib/spec/hash";
import { MAX_SPEC_BYTES } from "@/lib/spec/schema";
import { isIntakePaused } from "@/lib/config";
import { isWalletSanctioned } from "@/lib/sanctions";
import { evaluateAwolAtBooking, type AwolBookingDecision } from "@/lib/awol";
import { log } from "@/lib/logging";

/** Context provided when a caller authenticates their session. */
export interface McpSessionContext {
  /** The authenticated caller's wallet address, or null if unauthenticated. */
  callerWallet: string | null;
}

/**
 * Creates a fresh McpServer instance per session.
 * Each transport needs its own server — the SDK does not support
 * connecting a single McpServer to multiple transports simultaneously.
 *
 * @param context Optional session context with caller identity.
 *   `request_human_work` requires `callerWallet` and attributes the task to it.
 *   `confirm_task_completion` and `resolve_dispute` require `callerWallet` to
 *   match the task's `from_agent_wallet`. `dispute_task` and `get_signed_verdict`
 *   accept either party (ADR-0001 D2).
 */
export function createMcpServer(context?: McpSessionContext): McpServer {
  const server = new McpServer({
    name: "base-human-mcp",
    version: "1.0.0",
  });

  // ─── Tool: search_whitepages ──────────────────────────────────────────────
  server.tool(
    "search_whitepages",
    "Query the Base-Human whitepages for verified wallet addresses by service category. Returns JSON array of matching humans sorted by reputation desc.",
    {
      category: z
        .string()
        .min(1)
        .describe(
          "Category slug to search for, e.g. 'delivery-errands', 'cleaning', 'pet-services'"
        ),
    },
    async ({ category }) => {
      const results = await searchByCategory(category);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                category,
                count: 0,
                results: [],
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              category,
              count: results.length,
              results: results.map((h) => ({
                wallet: h.wallet,
                categories: h.categories,
                rate_usdc: h.rate_usdc,
                availability: h.availability,
                reputation_score: h.reputation_score,
              })),
            }),
          },
        ],
      };
    }
  );

  // ─── Tool: request_human_work ─────────────────────────────────────────────
  // CC-081 Defect 4: this tool used to accept `from_agent_wallet` as an argument and
  // never touched `context.callerWallet`, so task provenance was unauthenticated —
  // and every downstream authorisation check (confirm_task_completion, dispute_task,
  // resolve_dispute) compares the caller against exactly that field. It is now bound
  // to the authenticated caller and cannot be asserted.
  server.tool(
    "request_human_work",
    "Initiate a task to hire a verified human on Base L2. Requires an authenticated session — the hiring agent is taken from your verified wallet, not from an argument. Returns every parameter needed to fund the escrow yourself: call USDC.approve then escrow.createTask(task_id_bytes32, worker, amount_wei, deadline_unix, review_window_seconds, spec_hash) from your own wallet, then POST { payment_request_id } to fund_url to confirm — that endpoint reads the chain and only activates the task once it is Funded. It is not a payment endpoint and never charges. NOTICE — you are the controller of the evidence: do not request personal information in the description or acceptance spec beyond what the task requires. The task content and the evidence the worker produces may contain personal information (including about third parties — addresses, faces, number plates); you commission the work, you receive the evidence, and you are the data controller for it. The platform stores hashes only and holds none of the bytes.",
    {
      to_human_wallet: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .describe(
          "Human's Base wallet address from search_whitepages. Must belong to a registered worker."
        ),
      task_description: z
        .string()
        .min(10)
        .max(1000)
        .describe("Plain-text description of the task the human must complete"),
      amount_usdc: z
        .number()
        .positive()
        .describe("USDC amount to lock in escrow (whole units, e.g. 150)"),
      deadline_hours: z
        .number()
        .int()
        .min(1)
        .max(720)
        .describe("Deadline in hours from now (1–720)"),
      review_window_hours: z
        .number()
        .int()
        .min(12)
        .max(336)
        .describe(
          "Review window in hours (12–336): how long you have to review after the worker submits before funds release to them automatically. Bounded by the contract."
        ),
      offer_expiry_minutes: z
        .number()
        .int()
        .min(15)
        .max(10080)
        .optional()
        .describe(
          "How long the worker has to answer this offer, in minutes (15–10080, default 1440 = 24h). Only applies when the worker has not enabled auto-booking — otherwise the offer auto-accepts. An unanswered offer lapses at expiry and you are free to re-target."
        ),
      acceptance_spec: z
        .string()
        .max(MAX_SPEC_BYTES)
        .describe(
          'Machine-checkable acceptance criteria, as a JSON STRING (not an object) — e.g. \'{"schema_version":1,"criteria":{"min_artefacts":8}}\'. Sent as a string because the exact bytes you send are the hash preimage: the returned spec_hash is keccak256 of them, and re-serialising would change it. Pass it verbatim as specHash to createTask. Required — without a spec there is nothing to check, so a task can only resolve in the worker\'s favour, and that must be a commitment you made, not an omission.'
        ),
      idempotency_key: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe(
          "Optional caller-chosen dedup key. If a task already exists with this key for YOUR wallet, its details are returned unchanged instead of creating a second task — send the same key when retrying after a timeout or network failure, never a fresh one. Scoped to your wallet; keys bind for at least 24h. Chain parameters (chain id, escrow and USDC addresses, RPC URL) are never arguments to any tool — they are server-config constants."
        ),
    },
    async ({
      to_human_wallet,
      task_description,
      amount_usdc,
      deadline_hours,
      review_window_hours,
      offer_expiry_minutes,
      acceptance_spec,
      idempotency_key,
    }) => {
      const deadline_unix =
        Math.floor(Date.now() / 1000) + deadline_hours * 3600;
      const review_window_seconds = review_window_hours * 3600;
      const offer_expiry_seconds = (offer_expiry_minutes ?? 1440) * 60;

      try {
        // Emergency Intake Kill Switch (ADR-0003 D4 / CC-086):
        // Pause intake only, never claims or settlements. If active, reject new tasks cleanly.
        const pauseStatus = isIntakePaused();
        if (pauseStatus.paused) {
          log("warn", "request_human_work_intake_paused", {
            caller: context?.callerWallet ?? "unauthenticated",
            notice: pauseStatus.notice,
          });
          return toolError(
            `Task creation is temporarily paused: ${pauseStatus.notice}`,
            "INTAKE_PAUSED",
            { extra: { intake_paused: true, claims_active: true, retry_after_s: 300 } },
          );
        }

        // Authorization: the *** agent must be an authenticated wallet, and the
        // task is attributed to it. Same shape as the three mutating tools below.
        if (!context?.callerWallet) {
          return toolError(
            "Authentication required. POST { walletAddress } to /api/basedhuman.mcp/challenge, sign the returned message with your wallet, and re-initialize the session with the x-caller-wallet, x-caller-signature and x-caller-nonce headers.",
            "UNAUTHENTICATED",
          );
        }
        const from_agent_wallet = context.callerWallet;

        // Sanctions screening, caller side (CC-099): before the idempotency replay and
        // the rate limiter, so a listed agent gets nothing back — not even details of
        // a task it created before listing — and does not burn rate-limit tokens.
        // Address-based only (ADR-0002 D1); retryable is false because no retry of
        // this request can change the answer.
        const callerScreen = await isWalletSanctioned(from_agent_wallet);
        if (callerScreen.sanctioned) {
          log("warn", "request_human_work_sanctioned_wallet_rejected", {
            caller: from_agent_wallet,
            role: "agent",
            list: callerScreen.list,
          });
          return toolError(
            "Caller wallet address is restricted under sanctions compliance.",
            "SANCTIONED_WALLET",
          );
        }

        // CC-046 idempotency: a retry after a network failure must return the
        // original task, not a second row the agent might also fund. Checked
        // before the rate limiter — a replay is not a new task creation and must
        // not burn a token. Caller-scoped: the lookup includes the authenticated
        // wallet, so one agent's key never shadows another's. A concurrent
        // double-send that slips past this lookup fails the insert on
        // migration 020's unique index (23505) and replays from the catch below.
        if (idempotency_key !== undefined) {
          const existing = await findTaskByIdempotencyKey(
            from_agent_wallet,
            idempotency_key,
          );
          if (existing) {
            log("info", "request_human_work_idempotent_replay", {
              caller: from_agent_wallet,
              payment_request_id: existing.payment_request_id,
            });
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    idempotent_replay: true,
                    ...replayX402Payment(existing),
                  }),
                },
              ],
            };
          }
        }

        // Bound how fast one authenticated agent can create tasks. The
        // authentication above is the real control; see CC-020 on this limiter
        // being per-instance in-memory without Upstash.
        const { success, retryAfterS } = await taskCreationRateLimiter.limit(
          from_agent_wallet.toLowerCase()
        );
        if (!success) {
          log("warn", "request_human_work_rate_limited", {
            caller: from_agent_wallet,
          });
          return toolError(
            "Task creation rate limit exceeded for this wallet.",
            "RATE_LIMITED",
            { extra: { retry_after_s: retryAfterS } },
          );
        }

        // `to_human_wallet` was previously format-checked only, despite the
        // parameter description claiming it comes from search_whitepages. Once the
        // agent passes `worker` to createTask this value becomes the on-chain payout
        // destination, so an unregistered address must not reach a task row.
        // getHumanByWallet lowercases its argument; wallets are stored lowercase and
        // CHECK-constrained that way by migration 014.
        const worker = await getHumanByWallet(to_human_wallet);
        if (!worker) {
          log("warn", "request_human_work_unregistered_worker", {
            caller: from_agent_wallet,
          });
          return toolError(
            "to_human_wallet does not belong to a registered worker. Use search_whitepages to find one.",
            "UNREGISTERED_WORKER",
          );
        }

        // Sanctions screening, worker side (CC-099): the worker's payout destination
        // must not be a listed address, so a flagged wallet cannot be *paid*, let
        // alone enter the marketplace. Registration screens first (a listed wallet
        // should never be in the whitepages at all); this catches a wallet listed
        // after it registered.
        const workerScreen = await isWalletSanctioned(worker.wallet);
        if (workerScreen.sanctioned) {
          log("warn", "request_human_work_sanctioned_wallet_rejected", {
            caller: from_agent_wallet,
            role: "worker",
            list: workerScreen.list,
          });
          return toolError(
            "The target worker's wallet address is restricted under sanctions compliance.",
            "SANCTIONED_WALLET",
          );
        }

        // CC-094 / ADR-0005 D3: accepts_auto_booking is a gate, not metadata.
        // A worker with the flag true on any channel has pre-authorised being
        // booked against their own stated categories and rate — the offer
        // auto-accepts. Otherwise it waits for them and lapses at expiry (D4).
        const channels = await getChannelsForContractor(worker.id);
        const autoAccept = channels.some((c) => c.accepts_auto_booking);

        // D5: the concurrency cap applies at auto-accept time too. A worker at
        // the cap of accepted+active tasks cannot take another; booking them
        // anyway would only manufacture an ADR-0001 D1 expiry.
        if (autoAccept) {
          const committed = await countCommittedTasks(worker.wallet);
          if (committed >= WORKER_CONCURRENCY_CAP) {
            log("warn", "request_human_work_worker_at_cap", {
              caller: from_agent_wallet,
              worker: worker.wallet,
              committed,
            });
            return toolError(
              `This worker is at their concurrency cap (${WORKER_CONCURRENCY_CAP} accepted+active tasks) and cannot be auto-booked. Use search_whitepages to find another worker.`,
              "WORKER_AT_CAPACITY",
            );
          }
        }

        // Validate and hash before any row is written, so a malformed spec fails
        // the whole call rather than creating a task the agent cannot commit.
        // CC-081 Defect 1: required. The hash is the specHash argument to
        // createTask — a task funded without one commits to nothing checkable and
        // can only resolve in the worker's favour, so that must never happen by
        // omission. The schema makes it required for real callers; the guard below
        // covers direct handler invocation (tests, internal use) that bypasses it.
        if (acceptance_spec === undefined) {
          return toolError(
            "acceptance_spec is required. Without it there is nothing to check, so the task could only resolve in the worker's favour — see ADR-0001 D6.",
            "ACCEPTANCE_SPEC_REQUIRED",
          );
        }
        let spec;
        try {
          spec = parseAndHashSpec(acceptance_spec);
        } catch (err) {
          const message =
            err instanceof SpecValidationError ? err.message : String(err);
          return toolError(message, "INVALID_SPEC");
        }

        // CC-075 / ADR-0005 D6 + ADR-0001 D1: inline AWOL check at auto-booking
        // time, before the offer would auto-accept. When the worker has crossed
        // either threshold (3 consecutive lapsed offers, or 3 consecutive expired
        // tasks with no submission) this disables their auto-booking, notifies
        // them out-of-band, and leaves this offer as manual acceptance. Checked
        // inline rather than on a cron — a scheduled job maintaining a flag that
        // is only read here is pure overhead.
        let awol: AwolBookingDecision = {
          evaluated: false,
          triggered: false,
          signal: null,
          consecutiveLapsedOffers: 0,
          consecutiveExpiredTasks: 0,
        };
        try {
          awol = await evaluateAwolAtBooking({
            id: worker.id,
            wallet: worker.wallet,
          });
        } catch (err) {
          // Fail safe: with the AWOL state unreadable the worker is treated as
          // manual acceptance rather than auto-booked. The hire proceeds.
          log("warn", "worker_awol_check_failed", {
            caller: from_agent_wallet,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        const response = await initiateX402Payment({
          from_agent_wallet,
          to_human_wallet: worker.wallet,
          task_description,
          amount_usdc,
          deadline_unix,
          review_window_seconds,
          spec,
          auto_accept: autoAccept,
          offer_expiry_seconds,
          ...(idempotency_key !== undefined ? { idempotency_key } : {}),
        });

        // ADR-0005 D7: the worker must be told about the offer. notifyContractor
        // is the CC-095 seam — structured logging until real delivery ships — and
        // never throws, so a notification fault cannot fail the hire.
        await notifyContractor(worker.id, {
          type: "offer_received",
          payment_request_id: response.payment_request_id,
          amount_usdc,
          offer_expiry_unix: response.offer_expiry_unix,
        });
        if (autoAccept) {
          await notifyContractor(worker.id, {
            type: "task_funded",
            payment_request_id: response.payment_request_id,
            amount_usdc,
          });
        }

        // When AWOL triggered, the offer requires the worker's manual
        // acceptance — the task row is created `pending` either way, with the
        // standard offer expiry.
        const awolNotice = awol.triggered
          ? {
              worker_auto_booking_disabled: true,
              awol_signal: awol.signal,
              acceptance: "manual",
              notice:
                "The worker's auto-booking was switched off for repeated missed offers or expiries (CC-075). This task remains pending and requires their manual acceptance.",
            }
          : {};

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, ...response, ...awolNotice }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // Migration 020's unique index lost the concurrent-retry race: another
        // request with the same (agent, key) inserted first. Fetch theirs and
        // replay it — the agent must not see an error it would instinctively
        // retry with a fresh key.
        if (idempotency_key !== undefined && message.includes("(23505)")) {
          const winner = context?.callerWallet
            ? await findTaskByIdempotencyKey(context.callerWallet, idempotency_key)
            : null;
          if (winner) {
            log("info", "request_human_work_idempotent_race_replay", {
              caller: context?.callerWallet,
              payment_request_id: winner.payment_request_id,
            });
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    idempotent_replay: true,
                    replayed_after_conflict: true,
                    ...replayX402Payment(winner),
                  }),
                },
              ],
            };
          }
        }
        log("error", "request_human_work_failed", {
          caller: context?.callerWallet ?? "unauthenticated",
          error: message,
        });
        return toolError(message, "INTERNAL", { reason: "unexpected_fault" });
      }
    }
  );

  // ─── Tool: get_task_status ────────────────────────────────────────────────
  server.tool(
    "get_task_status",
    "Check the status of a task by payment_request_id. Returns both database state and on-chain escrow state (if contract is deployed).",
    {
      payment_request_id: z
        .string()
        .min(1)
        .describe("The payment_request_id returned by request_human_work"),
    },
    async ({ payment_request_id }) => {
      try {
        const dbTask = await getTaskByPaymentId(payment_request_id);
        if (!dbTask) {
          return toolError("Task not found", "TASK_NOT_FOUND");
        }

        // Try to read on-chain state (may fail if contract not deployed)
        let onChain = null;
        const escrowConfig = getEscrowConfig();
        if (escrowConfig.address) {
          try {
            const onChainTask = await getOnChainTask(payment_request_id);
            // CC-092: full v2 projection, same shape as /api/tasks.
            onChain = {
              state: onChainTask.state,
              amount_wei: onChainTask.amount.toString(),
              deadline: Number(onChainTask.deadline),
              reviewWindow: onChainTask.reviewWindow,
              submittedAt: Number(onChainTask.submittedAt),
              reviewDeadline: Number(onChainTask.reviewDeadline),
              specHash: onChainTask.specHash,
              evidenceHash: onChainTask.evidenceHash,
              verdictHash: onChainTask.verdictHash,
              verdictPassed: onChainTask.verdictPassed,
              worker: onChainTask.worker,
              agent: onChainTask.agent,
            };
          } catch {
            onChain = { error: "Could not read on-chain state" };
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                database: {
                  payment_request_id: dbTask.payment_request_id,
                  status: dbTask.status,
                  amount_usdc: dbTask.amount_usdc,
                  from_agent: dbTask.from_agent_wallet,
                  to_worker: dbTask.to_human_wallet,
                  // Only include task_description for the owning agent
                  ...(context?.callerWallet &&
                    dbTask.from_agent_wallet.toLowerCase() === context.callerWallet.toLowerCase()
                    ? { task_description: dbTask.task_description }
                    : {}),
                  deadline_unix: dbTask.deadline_unix,
                  offer_expiry_unix: dbTask.offer_expiry_unix,
                  created_at: dbTask.created_at,
                },
                on_chain: onChain,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(message, "INTERNAL");
      }
    }
  );

  // ─── Tool: confirm_task_completion ────────────────────────────────────────
  // CC-080: this tool previously called escrow.completeTask as the platform signer,
  // which reverts unconditionally — completeTask is agent-only and the platform is
  // structurally the wrong sender. It now records the agent's confirmation and hands
  // settlement back. Under ADR-0001 the platform transacts nowhere in settlement:
  // the agent's completeTask is the *early* path; the worker's pull-payment claim
  // after the review window is the default. The DB stays untouched here — it flips
  // to 'completed' when the TaskCompleted event is observed, never on this call.
  server.tool(
    "confirm_task_completion",
    "Record the originating agent's confirmation that a task's work is complete, and return the taskId and escrow address needed to settle. This tool does NOT release funds: settlement is the agent's own on-chain action (completeTask early, or the worker claims via releaseAfterReview after the review window).",
    {
      payment_request_id: z
        .string()
        .min(1)
        .describe("The payment_request_id of the task to confirm complete"),
    },
    async ({ payment_request_id }) => {
      try {
        // Authorization: only the originating agent may confirm completion
        if (!context?.callerWallet) {
          return toolError(
            "Authentication required. Provide a verified wallet to confirm task completion.",
            "UNAUTHENTICATED",
          );
        }

        const task = await getTaskByPaymentId(payment_request_id);
        if (!task) {
          return toolError("Task not found", "TASK_NOT_FOUND");
        }

        if (task.from_agent_wallet.toLowerCase() !== context.callerWallet.toLowerCase()) {
          log("warn", "confirm_completion_unauthorized", {
            payment_request_id,
            caller: context.callerWallet,
            task_agent: task.from_agent_wallet,
          });
          return toolError(
            "Not authorized. Only the originating agent may confirm task completion.",
            "FORBIDDEN",
          );
        }

        if (task.status !== "active" && task.status !== "pending") {
          if (task.status !== "completed") {
            return toolError(
              `Task is ${task.status}, cannot confirm completion`,
              "INVALID_TASK_STATE",
            );
          }
          // Already completed — the settlement this tool points at has happened.
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  payment_request_id,
                  status: "completed",
                  note: "Task was already completed.",
                }),
              },
            ],
          };
        }

        const taskId = toTaskId(payment_request_id);
        const escrowConfig = getEscrowConfig();

        // Best-effort read of on-chain state so the response can tell the agent
        // where settlement actually stands. Read-only — never a gate for a write,
        // since this tool no longer writes to the chain at all.
        let onChainState: string | null = null;
        if (escrowConfig.address) {
          try {
            const onChainTask = await getOnChainTask(payment_request_id);
            onChainState = onChainTask.state;
          } catch {
            // Contract may not be deployed or reachable — omit, don't fail
          }
        }

        log("info", "task_completion_confirmed_by_agent", {
          payment_request_id,
          amount_usdc: task.amount_usdc,
          onChainState,
        });

        const settled =
          onChainState === "Completed" || onChainState === "Resolved"
            ? "Settlement has already occurred on-chain."
            : onChainState === "Delivered"
              ? "Work is delivered and the review window is running. Pay early by calling completeTask, or let the worker claim via releaseAfterReview after the review deadline."
              : "Settlement is the agent's action. Call escrow.completeTask(taskId) from the originating agent wallet to pay early; otherwise the worker claims via releaseAfterReview once the review window passes.";

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                payment_request_id,
                task_id_bytes32: taskId,
                status: task.status,
                on_chain_state: onChainState,
                escrow_contract: escrowConfig.address,
                settlement: {
                  performed_by: "agent",
                  early_path: "escrow.completeTask(taskId) from the agent's own wallet",
                  default_path: "worker calls releaseAfterReview after the review window",
                  note: settled,
                },
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(message, "INTERNAL");
      }
    }
  );

  // ─── Tool: register_notification_channel ──────────────────────────────────
  server.tool(
    "register_notification_channel",
    "Register or update a notification channel for a contractor. When accepts_auto_booking is true, orchestrator agents can hire this worker directly without human approval.",
    {
      contractor_id: z
        .string()
        .uuid()
        .describe("UUID of the contractor (from humans table)"),
      type: z
        .enum(["email", "webhook", "telegram", "discord"])
        .describe("Notification channel type"),
      address: z
        .string()
        .min(1)
        .describe(
          "Channel address: email address, webhook URL, Telegram chat ID, or Discord user ID"
        ),
      accepts_auto_booking: z
        .boolean()
        .describe(
          "If true, orchestrator agents can hire this worker without human approval"
        ),
    },
    async ({ contractor_id, type, address, accepts_auto_booking }) => {
      try {
        const channel = await registerNotificationChannel({
          contractor_id,
          type,
          address,
          accepts_auto_booking,
        });

        log("info", "notification_channel_registered", {
          contractor_id,
          type,
          accepts_auto_booking,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                channel: {
                  id: channel.id,
                  type: channel.type,
                  accepts_auto_booking: channel.accepts_auto_booking,
                },
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(message, "INTERNAL");
      }
    }
  );

  // ─── Tool: get_contractor ────────────────────────────────────────────────
  server.tool(
    "get_contractor",
    "Look up a single contractor's full profile by wallet address or UUID. Returns categories, rate, availability, reputation score, and notification channels.",
    {
      wallet: z
        .string()
        .optional()
        .describe("Contractor's 0x wallet address"),
      id: z
        .string()
        .uuid()
        .optional()
        .describe("Contractor's UUID from the humans table"),
    },
    async ({ wallet, id }) => {
      try {
        if (!wallet && !id) {
          return toolError("Provide either wallet or id", "INVALID_ARGUMENT");
        }

        const human = wallet
          ? await getHumanByWallet(wallet)
          : await getHumanById(id!);

        if (!human) {
          return toolError("Contractor not found", "CONTRACTOR_NOT_FOUND");
        }

        const channels = await getChannelsForContractor(human.id);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                contractor: {
                  id: human.id,
                  wallet: human.wallet,
                  categories: human.categories,
                  rate_usdc: human.rate_usdc,
                  availability: human.availability,
                  reputation_score: human.reputation_score,
                  accepts_auto_booking: channels.some(
                    (c) => c.accepts_auto_booking
                  ),
                },
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(message, "INTERNAL");
      }
    }
  );

  // ─── Tool: list_categories ──────────────────────────────────────────────
  server.tool(
    "list_categories",
    "Returns the canonical service category taxonomy — all unique categories registered by contractors on the platform. Use this to discover valid category slugs before calling search_whitepages.",
    {},
    async () => {
      try {
        const categories = await getDistinctCategories();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                count: categories.length,
                categories,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(message, "INTERNAL");
      }
    }
  );

  // ─── Tool: get_reputation ──────────────────────────────────────────────
  server.tool(
    "get_reputation",
    "Get a contractor's computed reputation score (0-100), task history, USDC stake amount, and score breakdown (completion/volume/recency/stake components).",
    {
      wallet: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .describe("Contractor's Base wallet address"),
    },
    async ({ wallet }) => {
      try {
        const reputation = await getFullReputation(wallet);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                reputation,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(message, "INTERNAL");
      }
    }
  );

  // ─── Tool: dispute_task ──────────────────────────────────────────────────
  // CC-092 / ADR-0001 D2, rewritten for CarbonEscrow v2. Two corrections from
  // the pre-v2 tool: either party may dispute (matching the contract's on-chain
  // NotParty grant — the app-layer half of CC-081 Defect 2), and a dispute
  // requires a signed failing verdict, because v2 has no bare-assertion
  // dispute. Supply the task's evidence bundle and this tool obtains the
  // verdict from the verdict service and returns it for the caller to present
  // on-chain from their own wallet — the platform transacts nowhere.
  server.tool(
    "dispute_task",
    "Dispute a delivered task. Either party (hiring agent or assigned worker) may call this. v2 requires a signed FAILING verdict — there is no bare-assertion dispute — so pass the task's evidence bundle as evidence_bundle (a JSON string, the exact bytes the worker committed at submitWork) and this tool computes and returns the signed verdict tuple plus signature for you to submit on-chain: escrow.disputeTask(taskId, verdict, signature) from your own wallet, before the review window closes. If the verdict passes, the dispute is refused. If the task is already Disputed on-chain, the database is updated to match without needing a bundle.",
    {
      payment_request_id: z
        .string()
        .min(1)
        .describe("The payment_request_id of the task to dispute"),
      evidence_bundle: z
        .string()
        .min(1)
        .optional()
        .describe(
          "The task's evidence bundle as a JSON STRING (not an object) — the exact bytes whose keccak256 the worker committed as evidenceHash at submitWork. Required to open a new dispute; omit only to record a dispute that already happened on-chain."
        ),
      reason: z
        .string()
        .min(10)
        .max(500)
        .optional()
        .describe(
          "Optional human-readable context for the dispute. Metadata only — the signed verdict is what binds, not this."
        ),
    },
    async ({ payment_request_id, evidence_bundle, reason }) => {
      try {
        // Authorization: either party may dispute (ADR-0001 D2)
        if (!context?.callerWallet) {
          return toolError(
            "Authentication required. Provide a verified wallet to dispute tasks.",
            "UNAUTHENTICATED",
          );
        }

        const task = await getTaskByPaymentId(payment_request_id);
        if (!task) {
          return toolError("Task not found", "TASK_NOT_FOUND");
        }

        const caller = context.callerWallet.toLowerCase();
        const callerIsWorker = task.to_human_wallet.toLowerCase() === caller;
        const callerIsAgent = task.from_agent_wallet.toLowerCase() === caller;
        if (!callerIsWorker && !callerIsAgent) {
          log("warn", "dispute_task_unauthorized", {
            payment_request_id,
            caller: context.callerWallet,
            worker: task.to_human_wallet,
            agent: task.from_agent_wallet,
          });
          return toolError(
            "Not authorized. Only a party to this task (worker or hiring agent) may dispute it.",
            "FORBIDDEN",
          );
        }

        if (task.status !== "active" && task.status !== "pending" && task.status !== "disputed") {
          return toolError(
            `Task is ${task.status}, cannot dispute`,
            "INVALID_TASK_STATE",
          );
        }

        const taskIdBytes32 = toTaskId(payment_request_id);
        const escrowConfig = getEscrowConfig();

        // With a bundle: obtain the signed failing verdict the contract requires.
        if (evidence_bundle !== undefined) {
          let computed;
          try {
            computed = await computeAndSignVerdict(task, evidence_bundle);
          } catch (err) {
            const message =
              err instanceof VerdictInputError
                ? err.message
                : err instanceof Error
                  ? `Verdict computation failed: ${err.message}`
                  : String(err);
            return toolError(message, err instanceof VerdictInputError ? "VERDICT_INPUT_INVALID" : "VERDICT_COMPUTATION_FAILED");
          }

          if (computed.verdict.passed) {
            return toolError(
              "Cannot dispute: verdict passed. The evidence satisfies the committed acceptance spec.",
              "VERDICT_PASSED",
              { extra: { verdict: serializeVerdict(computed.verdict), checks: computed.checks } },
            );
          }

          if (task.status !== "disputed") {
            await updateTaskStatus(payment_request_id, "disputed");
          }

          log("info", "task_disputed", {
            payment_request_id,
            reason: reason ?? null,
            amount_usdc: task.amount_usdc,
            caller_role: callerIsWorker ? "worker" : "agent",
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  payment_request_id,
                  status: "disputed",
                  task_id_bytes32: taskIdBytes32,
                  escrow_contract: escrowConfig.address,
                  verdict: serializeVerdict(computed.verdict),
                  signature: computed.signature,
                  checks: computed.checks,
                  on_chain_submitted: false,
                  note: "Database updated. Present the verdict on-chain from your own wallet — escrow.disputeTask(taskId, verdict, signature) — before the review window closes.",
                }),
              },
            ],
          };
        }

        // Without a bundle: the only disputable state is one that already
        // happened on-chain.
        let onChainState: string | null = null;
        if (escrowConfig.address) {
          try {
            onChainState = (await getOnChainTask(payment_request_id)).state;
          } catch {
            onChainState = null;
          }
        }

        if (
          onChainState === "Disputed" ||
          onChainState === "Arbitrating" ||
          onChainState === "Resolved"
        ) {
          if (task.status !== "disputed") {
            await updateTaskStatus(payment_request_id, "disputed");
          }
          log("info", "task_dispute_recorded_from_chain", {
            payment_request_id,
            onChainState,
            caller: context.callerWallet,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  payment_request_id,
                  status: "disputed",
                  task_id_bytes32: taskIdBytes32,
                  escrow_contract: escrowConfig.address,
                  on_chain_state: onChainState,
                  on_chain_submitted: true,
                  note: "The dispute is already on-chain; the database now reflects it.",
                }),
              },
            ],
          };
        }

        return toolError(
          "A dispute requires a signed failing verdict — pass the task's evidence bundle as evidence_bundle (a JSON string) so one can be computed. On-chain state is " +
            (onChainState ?? "unreadable") +
            ", so there is no existing dispute to record.",
          "DISPUTE_REQUIRES_VERDICT",
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(message, "INTERNAL");
      }
    }
  );

  // ─── Tool: get_signed_verdict ─────────────────────────────────────────────
  // CC-092: the MCP half of the verdict service. /api/verdict serves the
  // human on the dashboard; this serves the agent over MCP. Same
  // computeAndSignVerdict, same either-party authentication — a worker
  // presents a passing verdict to claimWithVerdict, either party a failing
  // one to disputeTask. Stateless by design: the bundle is an argument and is
  // never stored (this issue's design note 1).
  server.tool(
    "get_signed_verdict",
    "Compute and sign a verdict for a delivered task, against the evidence bundle the worker committed at submitWork. Either party (hiring agent or assigned worker) may call. Pass the bundle as a JSON STRING — the exact bytes whose keccak256 is the task's on-chain evidenceHash; anything else is refused. Returns the signed EIP-712 verdict tuple, the signature, and the per-check breakdown. A worker presents a PASSING verdict on-chain via escrow.claimWithVerdict(taskId, verdict, signature) to claim early; either party presents a FAILING one via escrow.disputeTask(taskId, verdict, signature). The platform signs what the deterministic checker found and never transacts.",
    {
      payment_request_id: z
        .string()
        .min(1)
        .describe("The payment_request_id of the delivered task"),
      evidence_bundle: z
        .string()
        .min(1)
        .describe(
          "The task's evidence bundle as a JSON STRING (not an object) — the exact bytes the worker committed at submitWork. The exact bytes you send are the hash preimage; re-serialising changes the hash."
        ),
    },
    async ({ payment_request_id, evidence_bundle }) => {
      try {
        if (!context?.callerWallet) {
          return toolError(
            "Authentication required. POST { walletAddress } to /api/basedhuman.mcp/challenge, sign the returned message with your wallet, and re-initialize the session with the x-caller-wallet, x-caller-signature and x-caller-nonce headers.",
            "UNAUTHENTICATED",
          );
        }

        const task = await getTaskByPaymentId(payment_request_id);
        if (!task) {
          return toolError("Task not found", "TASK_NOT_FOUND");
        }

        // Same posture as disputeTask/claimWithVerdict on-chain: NotParty.
        const caller = context.callerWallet.toLowerCase();
        const isParty =
          task.to_human_wallet.toLowerCase() === caller ||
          task.from_agent_wallet.toLowerCase() === caller;
        if (!isParty) {
          log("warn", "get_signed_verdict_unauthorized", {
            payment_request_id,
            caller: context.callerWallet,
          });
          return toolError(
            "Not authorized. Only a party to this task (worker or hiring agent) may request its verdict.",
            "FORBIDDEN",
          );
        }

        let computed;
        try {
          computed = await computeAndSignVerdict(task, evidence_bundle);
        } catch (err) {
          const message =
            err instanceof VerdictInputError
              ? err.message
              : err instanceof Error
                ? `Verdict computation failed: ${err.message}`
                : String(err);
          return toolError(message, err instanceof VerdictInputError ? "VERDICT_INPUT_INVALID" : "VERDICT_COMPUTATION_FAILED");
        }

        log("info", "verdict_computed", {
          payment_request_id,
          caller: context.callerWallet,
          passed: computed.verdict.passed,
          surface: "mcp",
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                payment_request_id,
                verdict: serializeVerdict(computed.verdict),
                signature: computed.signature,
                checks: computed.checks,
                next_step: computed.verdict.passed
                  ? "Worker: claim early with escrow.claimWithVerdict(taskId, verdict, signature) from the worker's own wallet."
                  : "Either party: dispute with escrow.disputeTask(taskId, verdict, signature) from your own wallet, before the review window closes.",
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(message, "INTERNAL");
      }
    }
  );

  // ─── Tool: resolve_dispute ──────────────────────────────────────────────
  server.tool(
    "resolve_dispute",
    "Resolve a disputed task: releases escrowed USDC on-chain (to the worker or back to the agent) via the platform signer, then sets status to 'completed' or 'expired'.",
    {
      payment_request_id: z
        .string()
        .min(1)
        .describe("The payment_request_id of the disputed task"),
      release_to_worker: z
        .boolean()
        .describe("True to release funds to worker, false to refund agent"),
      resolution_note: z
        .string()
        .min(5)
        .max(500)
        .describe("Brief explanation of the resolution"),
    },
    async ({ payment_request_id, release_to_worker, resolution_note }) => {
      try {
        // Authorization: only the originating agent may resolve a dispute
        if (!context?.callerWallet) {
          return toolError(
            "Authentication required. Provide a verified wallet to resolve disputes.",
            "UNAUTHENTICATED",
          );
        }

        const task = await getTaskByPaymentId(payment_request_id);
        if (!task) {
          return toolError("Task not found", "TASK_NOT_FOUND");
        }

        if (task.from_agent_wallet.toLowerCase() !== context.callerWallet.toLowerCase()) {
          log("warn", "resolve_dispute_unauthorized", {
            payment_request_id,
            caller: context.callerWallet,
            task_agent: task.from_agent_wallet,
          });
          return toolError(
            "Not authorized. Only the originating agent may resolve this dispute.",
            "FORBIDDEN",
          );
        }

        if (task.status !== "disputed") {
          return toolError(
            `Task is ${task.status}, can only resolve disputed tasks`,
            "INVALID_TASK_STATE",
          );
        }

        const taskIdBytes32 = toTaskId(payment_request_id);
        const escrowConfig = getEscrowConfig();
        let actualReleaseToWorker = release_to_worker;
        let txHash: string | null = null;

        // Check on-chain state first — handles partial-failure recovery where a previous
        // call resolved on-chain but the DB update afterward failed. Recover the TRUE
        // outcome from the TaskResolved event rather than trusting a possibly-mismatched
        // retry argument.
        let alreadyResolvedOnChain = false;
        if (escrowConfig.address) {
          try {
            const onChainTask = await getOnChainTask(payment_request_id);
            if (onChainTask.state === "Resolved") {
              alreadyResolvedOnChain = true;
              const outcome = await getTaskResolvedOutcome(payment_request_id);
              if (outcome) actualReleaseToWorker = outcome.releasedToWorker;
              log("info", "signer_resolve_dispute_already_done", {
                payment_request_id,
                onChainState: onChainTask.state,
                actualReleaseToWorker,
              });
            } else if (onChainTask.state !== "Disputed") {
              // DB says disputed but chain disagrees and it isn't already Resolved either —
              // don't guess, surface it.
              return toolError(
                `DB/chain state mismatch: DB says disputed, on-chain state is ${onChainTask.state}`,
                "CHAIN_STATE_MISMATCH",
                { reason: "db_chain_divergence" },
              );
            }
          } catch {
            // Contract may not be deployed yet — proceed with the on-chain call attempt below.
          }
        }

        if (!alreadyResolvedOnChain) {
          try {
            txHash = await resolveDisputeOnChain(taskIdBytes32, release_to_worker);
          } catch (chainErr: unknown) {
            const chainMsg = chainErr instanceof Error ? chainErr.message : String(chainErr);
            log("error", "signer_resolve_dispute_failed", {
              payment_request_id,
              error: chainMsg,
            });
            return toolError(
              `On-chain resolveDispute failed: ${chainMsg}`,
              "CHAIN_WRITE_FAILED",
              { reason: "resolve_dispute_tx_failed" },
            );
          }
        }

        const newStatus = actualReleaseToWorker ? "completed" : "expired";
        await updateTaskStatus(payment_request_id, newStatus);

        log("info", "dispute_resolved", {
          payment_request_id,
          release_to_worker: actualReleaseToWorker,
          resolution_note,
          amount_usdc: task.amount_usdc,
          txHash,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                payment_request_id,
                status: newStatus,
                release_to_worker: actualReleaseToWorker,
                task_id_bytes32: taskIdBytes32,
                escrow_contract: escrowConfig.address,
                tx_hash: txHash,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(message, "INTERNAL");
      }
    }
  );

  // ─── Resource: human_whitepages ───────────────────────────────────────────
  server.resource(
    "human_whitepages",
    "base-human://whitepages/all",
    {
      description:
        "Full directory of all verified humans on Base. Structured JSON-RPC compatible.",
      mimeType: "application/json",
    },
    async () => {
      const all = await getAllHumans();
      return {
        contents: [
          {
            uri: "base-human://whitepages/all",
            mimeType: "application/json",
            text: JSON.stringify({
              protocol: "base-human-mcp/1.0",
              total: all.length,
              humans: all.map((h) => ({
                wallet: h.wallet,
                categories: h.categories,
                rate_usdc: h.rate_usdc,
                availability: h.availability,
                reputation_score: h.reputation_score,
              })),
            }),
          },
        ],
      };
    }
  );

  // ─── Resource: escrow_config ──────────────────────────────────────────────
  server.resource(
    "escrow_config",
    "base-human://escrow/config",
    {
      description:
        "Escrow contract address and chain configuration for on-chain interactions.",
      mimeType: "application/json",
    },
    async () => {
      const config = getEscrowConfig();
      return {
        contents: [
          {
            uri: "base-human://escrow/config",
            mimeType: "application/json",
            text: JSON.stringify({
              protocol: "base-human-mcp/1.0",
              escrow: config,
            }),
          },
        ],
      };
    }
  );

  // ─── Resource: reputation_stake_config ────────────────────────────────────
  server.resource(
    "reputation_stake_config",
    "base-human://reputation/config",
    {
      description:
        "Reputation staking contract address, minimum stake, and cooldown period.",
      mimeType: "application/json",
    },
    async () => {
      const config = getReputationStakeConfig();
      return {
        contents: [
          {
            uri: "base-human://reputation/config",
            mimeType: "application/json",
            text: JSON.stringify({
              protocol: "base-human-mcp/1.0",
              reputation_stake: config,
            }),
          },
        ],
      };
    }
  );

  return server;
}
