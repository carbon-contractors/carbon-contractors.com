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
import { recoverAddress, hashMessage } from "viem";
import { getSupabaseAdmin } from "@/lib/db/client";
import { mcpRateLimiter } from "@/lib/ratelimit";

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

// ── Challenge-response signature verification (NOR-178) ─────────────────────

/**
 * Verify a challenge-response signature for MCP authentication.
 * Returns the verified wallet address on success, throws on failure.
 */
async function verifyChallengeSignature(
  claimedWallet: string,
  signature: `0x${string}`,
  nonce: string,
): Promise<string> {
  const supabase = getSupabaseAdmin();

  // Look up the challenge
  const { data: challenge, error } = await supabase
    .from("mcp_challenges")
    .select("wallet_address, nonce, expires_at, used_at, created_at")
    .eq("nonce", nonce)
    .single();

  if (error || !challenge) {
    throw new Error("Challenge not found or expired");
  }

  // Check not already used
  if (challenge.used_at) {
    throw new Error("Challenge already consumed");
  }

  // Check not expired
  if (new Date(challenge.expires_at) < new Date()) {
    throw new Error("Challenge expired");
  }

  // Check wallet matches
  if (challenge.wallet_address !== claimedWallet.toLowerCase()) {
    throw new Error("Challenge was issued for a different wallet");
  }

  // Reconstruct the message and verify signature
  const timestamp = Math.floor(new Date(challenge.created_at).getTime() / 1000);
  const challengeMessage = `carbon-contractors.com wants to verify wallet ownership\nNonce: ${nonce}\nTimestamp: ${timestamp}`;

  const recovered = await recoverAddress({
    hash: hashMessage(challengeMessage),
    signature,
  });

  if (recovered.toLowerCase() !== claimedWallet.toLowerCase()) {
    throw new Error("Signature does not match claimed wallet");
  }

  // Mark nonce as used
  await supabase
    .from("mcp_challenges")
    .update({ used_at: new Date().toISOString() })
    .eq("nonce", nonce);

  return claimedWallet;
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

// ── Rate limiting (NOR-179) ──────────────────────────────────────────────────
  const ip = req.headers.get("x-forwarded-for") ?? "127.0.0.1";
  const { success, retryAfterS } = await mcpRateLimiter.limit(ip);
  if (!success) {
  return jsonRpcError(-32029, "Rate limit exceeded. Try again later.", 429);
  }

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

    // ── Challenge-response wallet authentication (NOR-178) ──
    // Agent must first GET a challenge from /api/basedhuman.mcp/challenge,
    // sign it with their wallet, and include signature + nonce in headers.
    const rawWallet = req.headers.get("x-caller-wallet");
    let callerWallet: string | null = null;

    if (rawWallet && /^0x[0-9a-fA-F]{40}$/.test(rawWallet)) {
      const signature = req.headers.get("x-caller-signature") as `0x${string}` | null;
      const nonce = req.headers.get("x-caller-nonce");

      if (signature && nonce) {
        try {
          callerWallet = await verifyChallengeSignature(rawWallet, signature, nonce);
        } catch (err) {
          log("warn", "mcp_auth_failed", { wallet: rawWallet, error: String(err) });
          return jsonRpcError(-32001, "Signature verification failed", 401);
        }
      }
      // If no signature provided, callerWallet stays null — read-only tools still work,
      // but mutating tools (confirm_task, dispute, resolve) will reject.
    }

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
