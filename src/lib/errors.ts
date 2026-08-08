/**
 * errors.ts
 * Safe error response helper — prevents leaking internal details to clients.
 */

import { NextResponse } from "next/server";
import { log } from "@/lib/logging";

/**
 * Extract a human-readable message from an unknown thrown value.
 * Supabase gateway-level rejections (e.g. an invalid API key) come back as a plain
 * `{ message, hint }` object, not a `PostgrestError`/`Error` instance — `err instanceof Error`
 * is false for these, and `String(err)` degrades to the useless "[object Object]", which
 * defeats server-side error logging just as much as it defeats a dev-mode client message.
 */
function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

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
  const message = extractMessage(err);
  log("error", context, { error: message, ...meta });

  const isDev = process.env.NODE_ENV === "development";
  return NextResponse.json(
    { ok: false, error: isDev ? message : "Internal server error" },
    { status: 500 },
  );
}
