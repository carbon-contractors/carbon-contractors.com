/**
 * route.ts — /api/basedhuman.mcp (GET + POST + DELETE)
 *
 * Single endpoint for the MCP Streamable HTTP transport (Web Standards).
 * - GET  → opens an SSE stream for server-initiated notifications
 * - POST → receives JSON-RPC messages, responds via SSE per request
 * - DELETE → terminates the session
 *
 * Transport: WebStandardStreamableHTTPServerTransport (native Request/Response)
 * Compatible with Next.js App Router (Node.js runtime, NOT edge).
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer, type McpSessionContext } from "@/lib/mcp/server";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { NextRequest } from "next/server";
import { log } from "@/lib/logging";
import { getConfig } from "@/lib/config";
import { setSessionCount } from "@/lib/mcp/session-count";

// ── Session registry ─────────────────────────────────────────────────────────

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport;
  context: McpSessionContext;
  createdAt: number;
  lastActivityAt: number;
}

const sessions = new Map<string, SessionEntry>();

/** Exported for the health check endpoint. */
export function getSessionCount(): number {
  return sessions.size;
}

/**
 * Purge sessions that have been idle longer than SESSION_TIMEOUT_MS.
 * Runs inline on each request — no setInterval needed (Vercel-safe).
 */
function purgeExpiredSessions(): void {
  const now = Date.now();
  let timeoutMs: number;
  try {
    timeoutMs = getConfig().SESSION_TIMEOUT_MS;
  } catch {
    timeoutMs = 1_800_000; // fallback 30 min
  }

  for (const [id, entry] of sessions) {
    if (now - entry.lastActivityAt > timeoutMs) {
      log("info", "session_expired", { sessionId: id, age_ms: now - entry.createdAt });
      try {
        entry.transport.close();
      } catch {
        // transport may already be closed
      }
      sessions.delete(id);
    }
  }
  setSessionCount(sessions.size);
}

function createTransport(context: McpSessionContext): WebStandardStreamableHTTPServerTransport {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sessionId) => {
      const now = Date.now();
      sessions.set(sessionId, { transport, context, createdAt: now, lastActivityAt: now });
      setSessionCount(sessions.size);
    },
    onsessionclosed: (sessionId) => {
      if (sessionId) sessions.delete(sessionId);
      setSessionCount(sessions.size);
    },
  });
  return transport;
}

// ── JSON-RPC error helpers ───────────────────────────────────────────────────

function jsonRpcError(code: number, message: string, status: number): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function handler(req: NextRequest): Promise<Response> {
  // Purge stale sessions on every request
  purgeExpiredSessions();

  if (req.method === "POST") {
    let body: unknown;
    try {
      body = await req.clone().json();
    } catch {
      return jsonRpcError(-32700, "Parse error", 400);
    }

    const isInit = Array.isArray(body)
      ? body.some(isInitializeRequest)
      : isInitializeRequest(body as Parameters<typeof isInitializeRequest>[0]);

    const sessionId = req.headers.get("mcp-session-id");

    if (!isInit && sessionId) {
      // Route to existing session transport.
      const entry = sessions.get(sessionId);
      if (entry) {
        entry.lastActivityAt = Date.now();
        return entry.transport.handleRequest(req);
      }
      log("warn", "session_not_found", { sessionId });
      return jsonRpcError(-32001, "Session expired or not found. Re-initialize to continue.", 404);
    }

    // Check capacity before creating a new session
    let maxSessions: number;
    try {
      maxSessions = getConfig().MAX_SESSIONS;
    } catch {
      maxSessions = 100;
    }
    if (sessions.size >= maxSessions) {
      log("warn", "session_limit_reached", { current: sessions.size, max: maxSessions });
      return jsonRpcError(-32000, "Server at capacity. Try again later.", 503);
    }

    // Extract caller wallet from header (set by authenticated agent clients).
    // Validated as a 0x-prefixed 40-hex-char address; null if missing/invalid.
    const rawWallet = req.headers.get("x-caller-wallet");
    const callerWallet =
      rawWallet && /^0x[0-9a-fA-F]{40}$/.test(rawWallet) ? rawWallet : null;

    const sessionContext: McpSessionContext = { callerWallet };

    // New session: fresh server + transport per connection.
    const server = createMcpServer(sessionContext);
    const transport = createTransport(sessionContext);
    try {
      await server.connect(transport);
      log("info", "session_created", { total: sessions.size });
    } catch (err) {
      log("error", "server_connect_failed", { err: String(err) });
      return jsonRpcError(-32000, "Server connect failed", 500);
    }
    return transport.handleRequest(req, { parsedBody: body });
  }

  // GET/DELETE: route by session ID.
  const sessionId = req.headers.get("mcp-session-id");
  if (sessionId) {
    const entry = sessions.get(sessionId);
    if (entry) {
      entry.lastActivityAt = Date.now();
      return entry.transport.handleRequest(req);
    }
    log("warn", "session_not_found_get_delete", { sessionId, method: req.method });
    return jsonRpcError(-32001, "Session expired or not found. Re-initialize to continue.", 404);
  }

  return jsonRpcError(-32000, "Mcp-Session-Id required", 400);
}

export { handler as GET, handler as POST, handler as DELETE };
