/**
 * logging.ts
 * Wazuh-compatible structured JSON logger.
 * All output is single-line JSON to stdout for log aggregation.
 */

type LogLevel = "info" | "warn" | "error";

export function log(
  level: LogLevel,
  event: string,
  meta?: Record<string, unknown>,
): void {
  console.log(JSON.stringify({ level, event, ts: Date.now(), ...meta }));
}
