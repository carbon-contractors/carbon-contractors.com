#!/usr/bin/env node

/**
 * emergency-broadcast.mjs
 *
 * Dispatches an emergency intake pause or resumption notice to configured
 * alerting channels (Discord / Webhooks) per ADR-0003 D4 / CC-086.
 *
 * Usage:
 *   node --env-file-if-exists=.env.local scripts/emergency-broadcast.mjs --pause --reason="Escrow solvency investigation"
 *   node --env-file-if-exists=.env.local scripts/emergency-broadcast.mjs --resume --reason="All checks nominal"
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    pause: { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
    reason: { type: "string", default: "Scheduled maintenance / incident investigation" },
    dry_run: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

const webhookUrl = process.env.MONITOR_WEBHOOK_URL;
const isPause = values.pause || (!values.resume && true);
const action = isPause ? "PAUSE" : "RESUME";

console.log(`[EMERGENCY BROADCAST] Action: ${action}`);
console.log(`[EMERGENCY BROADCAST] Reason: ${values.reason}`);

if (!webhookUrl) {
  console.warn("[EMERGENCY BROADCAST] MONITOR_WEBHOOK_URL is not set — broadcast skipped.");
  process.exit(0);
}

const payload = isPause
  ? {
      username: "Carbon Contractors Emergency Broadcast",
      embeds: [
        {
          title: "🚨 EMERGENCY NOTICE: Task Intake Paused",
          description:
            "**Task creation has been temporarily suspended across all MCP and API endpoints.**\n\nExisting tasks, reviews, and worker claims remain active and unaffected.",
          color: 0xed4245, // Red
          fields: [
            { name: "Reason / Incident", value: values.reason, inline: false },
            { name: "Task Intake", value: "🔴 FROZEN", inline: true },
            { name: "Claims & Settlements", value: "🟢 ACTIVE (Unpaused)", inline: true },
            {
              name: "Directives for Agents & Workers",
              value:
                "• Agents: Hold new task creation until notice clears.\n• Workers: Submissions and claims continue normally.",
              inline: false,
            },
          ],
          footer: {
            text: "ADR-0003 D4 Emergency Kill Switch Protocol (CC-086)",
          },
          timestamp: new Date().toISOString(),
        },
      ],
    }
  : {
      username: "Carbon Contractors System Broadcast",
      embeds: [
        {
          title: "✅ System Notice: Task Intake Resumed",
          description:
            "**Task creation has been restored across all MCP and API endpoints.** All systems nominal.",
          color: 0x57f287, // Green
          fields: [
            { name: "Resolution Note", value: values.reason, inline: false },
            { name: "Task Intake", value: "🟢 ACTIVE", inline: true },
            { name: "Claims & Settlements", value: "🟢 ACTIVE", inline: true },
          ],
          footer: {
            text: "Carbon Contractors Platform Operations",
          },
          timestamp: new Date().toISOString(),
        },
      ],
    };

if (values.dry_run) {
  console.log("[EMERGENCY BROADCAST] DRY RUN payload:\n", JSON.stringify(payload, null, 2));
  process.exit(0);
}

try {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[EMERGENCY BROADCAST] Webhook delivery failed: HTTP ${res.status} — ${text}`);
    process.exit(1);
  }

  console.log(`[EMERGENCY BROADCAST] Successfully broadcast ${action} alert to webhook.`);
} catch (err) {
  console.error(`[EMERGENCY BROADCAST] Network error delivering broadcast: ${err.message}`);
  process.exit(1);
}
