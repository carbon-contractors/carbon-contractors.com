/**
 * errors.ts
 * Safe error response helper — prevents leaking internal details to clients.
 */

import { NextResponse } from "next/server";
import { log } from "@/lib/logging";

/**
 * Returns a sanitized error response.
 * In development: includes the real error message for debugging.
 * In production: returns a generic message, logs full details server-side.
 */
export function safeErrorResponse(
  err: unknown,
  context: string,
  meta?: Record<string, unknown>,
): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  log("error", context, { error: message, ...meta });

  const isDev = process.env.NODE_ENV === "development";
  return NextResponse.json(
    { ok: false, error: isDev ? message : "Internal server error" },
    { status: 500 },
  );
}
