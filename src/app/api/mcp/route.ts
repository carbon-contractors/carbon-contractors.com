/**
 * route.ts — /api/mcp (GET + POST + DELETE)
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
import { createMcpServer } from "@/lib/mcp/server";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { NextRequest } from "next/server";
import { log } from "@/lib/logging";

// ── Session registry ─────────────────────────────────────────────────────────
// Maps sessionId → transport. Replace with Redis for multi-replica.
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

function createTransport(): WebStandardStreamableHTTPServerTransport {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, transport);
    },
    onsessionclosed: (sessionId) => {
      if (sessionId) sessions.delete(sessionId);
    },
  });
  return transport;
}

// ── Handler ───────────────────────────────────────────────────────────────────
async function handler(req: NextRequest): Promise<Response> {
  // For POST: check if this is an initialize or a subsequent session request.
  if (req.method === "POST") {
    let body: unknown;
    try {
      body = await req.clone().json();
    } catch {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const isInit = Array.isArray(body)
      ? body.some(isInitializeRequest)
      : isInitializeRequest(body as Parameters<typeof isInitializeRequest>[0]);

    const sessionId = req.headers.get("mcp-session-id");

    if (!isInit && sessionId) {
      // Route to existing session transport.
      const existing = sessions.get(sessionId);
      if (existing) {
        return existing.handleRequest(req);
      }
      log("warn", "session_not_found", { sessionId });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // New session: fresh server + transport per connection.
    const server = createMcpServer();
    const transport = createTransport();
    try {
      await server.connect(transport);
      log("info", "session_created");
    } catch (err) {
      log("error", "server_connect_failed", { err: String(err) });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Server connect failed" }, id: null }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    return transport.handleRequest(req, { parsedBody: body });
  }

  // GET/DELETE: route by session ID.
  const sessionId = req.headers.get("mcp-session-id");
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) {
      return existing.handleRequest(req);
    }
    log("warn", "session_not_found_get_delete", { sessionId, method: req.method });
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Mcp-Session-Id required" }, id: null }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

export { handler as GET, handler as POST, handler as DELETE };
