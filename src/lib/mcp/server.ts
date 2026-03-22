/**
 * server.ts
 * Per-session McpServer factory.
 * Registers all tools and resources for the Base-Human marketplace.
 * Output is intentionally terse and machine-optimized (no markdown, no prose).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  searchBySkill,
  getAllHumans,
  getHumanByWallet,
  getHumanById,
  getDistinctSkills,
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
} from "@/lib/contracts/escrow";
import { getReputationStakeConfig } from "@/lib/contracts/reputation";
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
    "Query the Base-Human whitepages for verified wallet addresses by skill. Returns JSON array of matching humans sorted by reputation desc.",
    {
      skill: z
        .string()
        .min(1)
        .describe(
          "Skill slug to search for, e.g. 'solidity', 'typescript', 'zk-proofs'"
        ),
    },
    async ({ skill }) => {
      const results = await searchBySkill(skill);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                skill,
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
              skill,
              count: results.length,
              results: results.map((h) => ({
                wallet: h.wallet,
                skills: h.skills,
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
  server.tool(
    "request_human_work",
    "Initiate a task to hire a verified human on Base L2. Returns a payment_request_id and a fund_url. POST { payment_request_id } to fund_url using an x402-compatible HTTP client (@x402/fetch) — the endpoint returns 402 Payment Required, your client auto-pays USDC, and the task activates.",
    {
      from_agent_wallet: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .describe("Agent's Base wallet address (0x…)"),
      to_human_wallet: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .describe("Human's Base wallet address from search_whitepages"),
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
    },
    async ({
      from_agent_wallet,
      to_human_wallet,
      task_description,
      amount_usdc,
      deadline_hours,
    }) => {
      const deadline_unix =
        Math.floor(Date.now() / 1000) + deadline_hours * 3600;

      try {
        const response = await initiateX402Payment({
          from_agent_wallet,
          to_human_wallet,
          task_description,
          amount_usdc,
          deadline_unix,
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
                  task_description: dbTask.task_description,
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
    "Mark a task as completed in the database. The agent should also call escrow.completeTask() on-chain to release funds to the worker.",
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

        await updateTaskStatus(payment_request_id, "completed");

        log("info", "task_completed", {
          payment_request_id,
          amount_usdc: task.amount_usdc,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                payment_request_id,
                status: "completed",
                note: "Database updated. Call escrow.completeTask(taskId) on-chain to release USDC to worker.",
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
                  contractor_id: channel.contractor_id,
                  type: channel.type,
                  address: channel.address,
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
    "Look up a single contractor's full profile by wallet address or UUID. Returns skills, rate, availability, reputation score, and notification channels.",
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
                  skills: human.skills,
                  rate_usdc: human.rate_usdc,
                  availability: human.availability,
                  reputation_score: human.reputation_score,
                  accepts_auto_booking: channels.some(
                    (c) => c.accepts_auto_booking
                  ),
                  notification_channels: channels.map((c) => ({
                    type: c.type,
                    accepts_auto_booking: c.accepts_auto_booking,
                  })),
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

  // ─── Tool: list_skills ─────────────────────────────────────────────────
  server.tool(
    "list_skills",
    "Returns the canonical skill taxonomy — all unique skills registered by contractors on the platform. Use this to discover valid skill slugs before calling search_whitepages.",
    {},
    async () => {
      try {
        const skills = await getDistinctSkills();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                count: skills.length,
                skills,
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
    "Resolve a disputed task. Sets status to 'completed' (release to worker) or 'expired' (refund agent). The platform owner should also call escrow.resolveDispute(taskId, releaseToWorker) on-chain.",
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

        const newStatus = release_to_worker ? "completed" : "expired";
        await updateTaskStatus(payment_request_id, newStatus);

        const taskIdBytes32 = toTaskId(payment_request_id);
        const escrowConfig = getEscrowConfig();

        log("info", "dispute_resolved", {
          payment_request_id,
          release_to_worker,
          resolution_note,
          amount_usdc: task.amount_usdc,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                payment_request_id,
                status: newStatus,
                release_to_worker,
                task_id_bytes32: taskIdBytes32,
                escrow_contract: escrowConfig.address,
                note: `Database updated. Call escrow.resolveDispute(taskId, ${release_to_worker}) on-chain to ${release_to_worker ? "release USDC to worker" : "refund USDC to agent"}.`,
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
              humans: all,
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
