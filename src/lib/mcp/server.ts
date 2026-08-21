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
import { initiateX402Payment } from "@/lib/payments/x402";
import {
  getTaskByPaymentId,
  updateTaskStatus,
} from "@/lib/db/tasks";
import { getFullReputation } from "@/lib/reputation";
import {
  registerNotificationChannel,
  getChannelsForContractor,
} from "@/lib/db/notifications";
import {
  getOnChainTask,
  getEscrowConfig,
  toTaskId,
  getTaskResolvedOutcome,
} from "@/lib/contracts/escrow";
import { completeTaskOnChain, resolveDisputeOnChain } from "@/lib/contracts/signer";
import { getReputationStakeConfig } from "@/lib/contracts/reputation";
import { taskCreationRateLimiter } from "@/lib/ratelimit";
import { parseAndHashSpec, SpecValidationError } from "@/lib/spec/hash";
import { MAX_SPEC_BYTES } from "@/lib/spec/schema";
import { isIntakePaused } from "@/lib/config";
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
 *   Tools that mutate task state (resolve_dispute, confirm_task_completion,
 *   dispute_task) require `callerWallet` to match the task's `from_agent_wallet`.
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
    "Initiate a task to hire a verified human on Base L2. Requires an authenticated session — the hiring agent is taken from your verified wallet, not from an argument. Returns a payment_request_id and a fund_url. POST { payment_request_id } to fund_url using an x402-compatible HTTP client (@x402/fetch) — the endpoint returns 402 Payment Required, your client auto-pays USDC, and the task activates. NOTICE — you are the controller of the evidence: do not request personal information in the description or acceptance spec beyond what the task requires. The task content and the evidence the worker produces may contain personal information (including about third parties — addresses, faces, number plates); you commission the work, you receive the evidence, and you are the data controller for it. The platform stores hashes only and holds none of the bytes.",
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
      acceptance_spec: z
        .string()
        .max(MAX_SPEC_BYTES)
        .optional()
        .describe(
          'Machine-checkable acceptance criteria, as a JSON STRING (not an object) — e.g. \'{"schema_version":1,"criteria":{"min_artefacts":8}}\'. Sent as a string because the exact bytes you send are the hash preimage: the returned spec_hash is keccak256 of them, and re-serialising would change it. Without a spec there is nothing to check, so the task can only resolve in the worker\'s favour.'
        ),
    },
    async ({
      to_human_wallet,
      task_description,
      amount_usdc,
      deadline_hours,
      acceptance_spec,
    }) => {
      const deadline_unix =
        Math.floor(Date.now() / 1000) + deadline_hours * 3600;

      try {
        // Emergency Intake Kill Switch (ADR-0003 D4 / CC-086):
        // Pause intake only, never claims or settlements. If active, reject new tasks cleanly.
        const pauseStatus = isIntakePaused();
        if (pauseStatus.paused) {
          log("warn", "request_human_work_intake_paused", {
            caller: context?.callerWallet ?? "unauthenticated",
            notice: pauseStatus.notice,
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: `Task creation is temporarily paused: ${pauseStatus.notice}`,
                  intake_paused: true,
                  claims_active: true,
                  retry_after_s: 300,
                }),
              },
            ],
          };
        }

        // Authorization: the *** agent must be an authenticated wallet, and the
        // task is attributed to it. Same shape as the three mutating tools below.
        if (!context?.callerWallet) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error:
                    "Authentication required. POST { walletAddress } to /api/basedhuman.mcp/challenge, sign the returned message with your wallet, and re-initialize the session with the x-caller-wallet, x-caller-signature and x-caller-nonce headers.",
                }),
              },
            ],
          };
        }
        const from_agent_wallet = context.callerWallet;

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
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: "Task creation rate limit exceeded for this wallet.",
                  retry_after_s: retryAfterS,
                }),
              },
            ],
          };
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
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error:
                    "to_human_wallet does not belong to a registered worker. Use search_whitepages to find one.",
                }),
              },
            ],
          };
        }

        // Validate and hash before any row is written, so a malformed spec fails
        // the whole call rather than creating a task the agent cannot commit.
        let spec = null;
        if (acceptance_spec !== undefined) {
          try {
            spec = parseAndHashSpec(acceptance_spec);
          } catch (err) {
            const message =
              err instanceof SpecValidationError ? err.message : String(err);
            return {
              isError: true,
              content: [
                { type: "text", text: JSON.stringify({ ok: false, error: message }) },
              ],
            };
          }
        }

        const response = await initiateX402Payment({
          from_agent_wallet,
          to_human_wallet: worker.wallet,
          task_description,
          amount_usdc,
          deadline_unix,
          spec,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, ...response }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: message }),
            },
          ],
        };
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
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: "Task not found",
                }),
              },
            ],
          };
        }

        // Try to read on-chain state (may fail if contract not deployed)
        let onChain = null;
        const escrowConfig = getEscrowConfig();
        if (escrowConfig.address) {
          try {
            const onChainTask = await getOnChainTask(payment_request_id);
            onChain = {
              state: onChainTask.state,
              amount_wei: onChainTask.amount.toString(),
              deadline: Number(onChainTask.deadline),
              agent: onChainTask.agent,
              worker: onChainTask.worker,
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
                  created_at: dbTask.created_at,
                },
                on_chain: onChain,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: message }),
            },
          ],
        };
      }
    }
  );

  // ─── Tool: confirm_task_completion ────────────────────────────────────────
  server.tool(
    "confirm_task_completion",
    "Mark a task as completed and release escrowed USDC to the worker on-chain.",
    {
      payment_request_id: z
        .string()
        .min(1)
        .describe("The payment_request_id of the task to complete"),
    },
    async ({ payment_request_id }) => {
      try {
        // Authorization: only the originating agent may confirm completion
        if (!context?.callerWallet) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: "Authentication required. Provide a verified wallet to confirm task completion.",
                }),
              },
            ],
          };
        }

        const task = await getTaskByPaymentId(payment_request_id);
        if (!task) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: "Task not found",
                }),
              },
            ],
          };
        }

        if (task.from_agent_wallet.toLowerCase() !== context.callerWallet.toLowerCase()) {
          log("warn", "confirm_completion_unauthorized", {
            payment_request_id,
            caller: context.callerWallet,
            task_agent: task.from_agent_wallet,
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: "Not authorized. Only the originating agent may confirm task completion.",
                }),
              },
            ],
          };
        }

        if (task.status !== "active" && task.status !== "pending") {
          // If DB says not active/pending, check if this is a partial-failure
          // recovery case: on-chain completed but DB update failed previously.
          if (task.status !== "completed") {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: false,
                    error: `Task is ${task.status}, cannot complete`,
                  }),
                },
              ],
            };
          }
          // Already completed in DB — return success idempotently
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  payment_request_id,
                  status: "completed",
                  txHash: null,
                  note: "Task was already completed.",
                }),
              },
            ],
          };
        }

        // Release USDC on-chain via platform signer
        const taskId = toTaskId(payment_request_id);
        let txHash: string | null = null;

        // Check on-chain state first — handles partial-failure recovery where
        // a previous call completed on-chain but the DB update failed.
        let alreadyCompletedOnChain = false;
        const escrowConfig = getEscrowConfig();
        if (escrowConfig.address) {
          try {
            const onChainTask = await getOnChainTask(payment_request_id);
            if (onChainTask.state === "Completed") {
              alreadyCompletedOnChain = true;
              log("info", "signer_complete_task_already_done", {
                payment_request_id,
                onChainState: onChainTask.state,
              });
            }
          } catch {
            // Contract may not be deployed yet — proceed with on-chain call
          }
        }

        if (!alreadyCompletedOnChain) {
          try {
            txHash = await completeTaskOnChain(taskId);
          } catch (chainErr: unknown) {
            const chainMsg = chainErr instanceof Error ? chainErr.message : String(chainErr);
            log("error", "signer_complete_task_failed", {
              payment_request_id,
              error: chainMsg,
            });
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: false,
                    error: `On-chain completeTask failed: ${chainMsg}`,
                  }),
                },
              ],
            };
          }
        }

        await updateTaskStatus(payment_request_id, "completed");

        log("info", "task_completed", {
          payment_request_id,
          amount_usdc: task.amount_usdc,
          txHash,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                payment_request_id,
                status: "completed",
                txHash,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: message }),
            },
          ],
        };
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
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, error: message }),
            },
          ],
        };
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
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  error: "Provide either wallet or id",
                }),
              },
            ],
          };
        }

        const human = wallet
          ? await getHumanByWallet(wallet)
          : await getHumanById(id!);

        if (!human) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  error: "Contractor not found",
                }),
              },
            ],
          };
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
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, error: message }),
            },
          ],
        };
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
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, error: message }),
            },
          ],
        };
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
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, error: message }),
            },
          ],
        };
      }
    }
  );

  // ─── Tool: dispute_task ──────────────────────────────────────────────────
  server.tool(
    "dispute_task",
    "Flag a task as disputed in the database. The caller (agent or worker) should also call escrow.disputeTask(taskId) on-chain to freeze escrowed funds. Requires task status 'active' or 'pending'.",
    {
      payment_request_id: z
        .string()
        .min(1)
        .describe("The payment_request_id of the task to dispute"),
      reason: z
        .string()
        .min(10)
        .max(500)
        .describe("Reason for the dispute"),
    },
    async ({ payment_request_id, reason }) => {
      try {
        // Authorization: only the originating agent may dispute a task
        if (!context?.callerWallet) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  error: "Authentication required. Provide a verified wallet to dispute tasks.",
                }),
              },
            ],
          };
        }

        const task = await getTaskByPaymentId(payment_request_id);
        if (!task) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  error: "Task not found",
                }),
              },
            ],
          };
        }

        if (task.from_agent_wallet.toLowerCase() !== context.callerWallet.toLowerCase()) {
          log("warn", "dispute_task_unauthorized", {
            payment_request_id,
            caller: context.callerWallet,
            task_agent: task.from_agent_wallet,
          });
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  error: "Not authorized. Only the originating agent may dispute this task.",
                }),
              },
            ],
          };
        }

        if (task.status !== "active" && task.status !== "pending") {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  error: `Task is ${task.status}, cannot dispute`,
                }),
              },
            ],
          };
        }

        await updateTaskStatus(payment_request_id, "disputed");

        const taskIdBytes32 = toTaskId(payment_request_id);
        const escrowConfig = getEscrowConfig();

        log("info", "task_disputed", {
          payment_request_id,
          reason,
          amount_usdc: task.amount_usdc,
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
                note: "Database updated. Call escrow.disputeTask(taskId) on-chain to freeze funds.",
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, error: message }),
            },
          ],
        };
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
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  error: "Authentication required. Provide a verified wallet to resolve disputes.",
                }),
              },
            ],
          };
        }

        const task = await getTaskByPaymentId(payment_request_id);
        if (!task) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  error: "Task not found",
                }),
              },
            ],
          };
        }

        if (task.from_agent_wallet.toLowerCase() !== context.callerWallet.toLowerCase()) {
          log("warn", "resolve_dispute_unauthorized", {
            payment_request_id,
            caller: context.callerWallet,
            task_agent: task.from_agent_wallet,
          });
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  error: "Not authorized. Only the originating agent may resolve this dispute.",
                }),
              },
            ],
          };
        }

        if (task.status !== "disputed") {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  error: `Task is ${task.status}, can only resolve disputed tasks`,
                }),
              },
            ],
          };
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
              return {
                isError: true,
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      ok: false,
                      error: `DB/chain state mismatch: DB says disputed, on-chain state is ${onChainTask.state}`,
                    }),
                  },
                ],
              };
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
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    ok: false,
                    error: `On-chain resolveDispute failed: ${chainMsg}`,
                  }),
                },
              ],
            };
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
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, error: message }),
            },
          ],
        };
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
