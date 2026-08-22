/**
 * route.ts — /api/channels
 *
 * Notification channel management for the worker dashboard (CC-073),
 * plus the per-channel accepts_auto_booking toggle (CC-074).
 * The `notification_channels` table and the `register_notification_channel`
 * MCP tool already exist; this is the website-facing surface on top of them,
 * so a worker can add, change, and remove channels without calling MCP.
 *
 * All three methods require the same wallet challenge-response signature as
 * the MCP transport and /api/dispute (CC-004): get a nonce from
 * POST /api/basedhuman.mcp/challenge, sign the returned message, and send it
 * as x-caller-wallet / x-caller-signature / x-caller-nonce headers. GET is
 * authenticated too — channel destinations include email addresses, which are
 * never world-readable (ADR-0004 D5).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getChannelsForContractor,
  getChannelById,
  registerNotificationChannel,
  removeNotificationChannel,
  setChannelAutoBooking,
} from "@/lib/db/notifications";
import { getHumanByWallet } from "@/lib/db/whitepages";
import { verifyChallengeSignature } from "@/lib/auth/wallet-challenge";
import {
  isValidWalletAddress,
  isValidChannelAddress,
  normalizeChannelAddress,
} from "@/lib/validation";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";

const CHANNEL_TYPES = ["email", "webhook", "telegram", "discord"] as const;

const postSchema = z.object({
  type: z.enum(CHANNEL_TYPES),
  address: z.string().min(1).max(2048),
  accepts_auto_booking: z.boolean().optional(),
});

// Format-only UUID check — channel IDs from Postgres `gen_random_uuid()`
// are v4, but zod's .uuid() additionally enforces RFC variant bits and we
// only care that the shape is a UUID before it hits the DB.
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const deleteSchema = z.object({
  channel_id: z.string().regex(UUID_RE, "channel_id must be a UUID"),
});

// CC-074: the auto-booking toggle. The boolean is required, not defaulted —
// opting a worker in to auto-booking must be an explicit act, so a PATCH that
// omits it is a bad request rather than a silent `true` or `false`.
const patchSchema = z.object({
  channel_id: z.string().regex(UUID_RE, "channel_id must be a UUID"),
  accepts_auto_booking: z.boolean(),
});

const INVALID_ADDRESS_MESSAGES: Record<(typeof CHANNEL_TYPES)[number], string> =
  {
    email: "Invalid email address",
    webhook: "Webhook address must be an HTTPS URL",
    telegram:
      "Telegram address must be a numeric chat ID (negative for group chats) — not an @username",
    discord:
      "Discord address must be a numeric user ID — enable Developer Mode and use Copy User ID",
  };

type AuthResult =
  | { ok: true; wallet: string }
  | { ok: false; response: NextResponse };

/**
 * Verify the challenge-response headers on a request.
 * Returns the verified wallet on success, or a 401 response.
 */
async function requireWalletAuth(request: NextRequest): Promise<AuthResult> {
  const rawWallet = request.headers.get("x-caller-wallet");
  const signature = request.headers.get("x-caller-signature") as
    | `0x${string}`
    | null;
  const nonce = request.headers.get("x-caller-nonce");

  if (!rawWallet || !isValidWalletAddress(rawWallet) || !signature || !nonce) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error:
            "Wallet signature required. Get a nonce from /api/basedhuman.mcp/challenge, sign it, and retry with x-caller-wallet/x-caller-signature/x-caller-nonce headers.",
        },
        { status: 401 }
      ),
    };
  }

  try {
    const wallet = await verifyChallengeSignature(rawWallet, signature, nonce);
    return { ok: true, wallet };
  } catch (err) {
    log("warn", "channels_auth_failed", {
      wallet: rawWallet,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Signature verification failed" },
        { status: 401 }
      ),
    };
  }
}

/** Parse the request body as JSON; a 400 response if it is not valid JSON. */
async function readJsonBody(
  request: NextRequest
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Invalid JSON body" },
        { status: 400 }
      ),
    };
  }
}

/** List the caller's channels. The wallet comes from the signature, not the query. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireWalletAuth(request);
    if (!auth.ok) return auth.response;

    const human = await getHumanByWallet(auth.wallet);
    if (!human) {
      return NextResponse.json(
        { ok: false, error: "Worker not registered" },
        { status: 404 }
      );
    }

    const channels = await getChannelsForContractor(human.id);

    return NextResponse.json({ ok: true, channels });
  } catch (err: unknown) {
    return safeErrorResponse(err, "channels_list_failed");
  }
}

/** Add or update a channel. One channel per type — re-registering overwrites. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireWalletAuth(request);
    if (!auth.ok) return auth.response;

    const parsedBody = await readJsonBody(request);
    if (!parsedBody.ok) return parsedBody.response;

    const parsed = postSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { type, address } = parsed.data;
    if (!isValidChannelAddress(type, address)) {
      return NextResponse.json(
        { ok: false, error: INVALID_ADDRESS_MESSAGES[type] },
        { status: 400 }
      );
    }

    const human = await getHumanByWallet(auth.wallet);
    if (!human) {
      return NextResponse.json(
        { ok: false, error: "Worker not registered" },
        { status: 404 }
      );
    }

    // Preserve the existing auto-booking flag on update unless the caller
    // sets it explicitly (the dashboard toggle itself is CC-074).
    let acceptsAutoBooking = parsed.data.accepts_auto_booking;
    if (acceptsAutoBooking === undefined) {
      const existing = (await getChannelsForContractor(human.id)).find(
        (c) => c.type === type
      );
      acceptsAutoBooking = existing?.accepts_auto_booking ?? false;
    }

    const channel = await registerNotificationChannel({
      contractor_id: human.id,
      type,
      address: normalizeChannelAddress(type, address),
      accepts_auto_booking: acceptsAutoBooking,
    });

    // Never log the address — email destinations are PII (ADR-0002 D9).
    log("info", "notification_channel_dashboard", {
      wallet: auth.wallet,
      type,
      accepts_auto_booking: acceptsAutoBooking,
    });

    return NextResponse.json({ ok: true, channel }, { status: 201 });
  } catch (err: unknown) {
    return safeErrorResponse(err, "channel_register_failed");
  }
}

/**
 * Toggle accepts_auto_booking on a channel (CC-074). Only the channel
 * owner's wallet may do this — the flag pre-authorises agents to book the
 * worker directly, so it is never settable by anyone else.
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireWalletAuth(request);
    if (!auth.ok) return auth.response;

    const parsedBody = await readJsonBody(request);
    if (!parsedBody.ok) return parsedBody.response;

    const parsed = patchSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Invalid request body — channel_id (UUID) and accepts_auto_booking (boolean) are both required",
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { channel_id, accepts_auto_booking } = parsed.data;

    const channel = await getChannelById(channel_id);
    if (!channel) {
      return NextResponse.json(
        { ok: false, error: "Channel not found" },
        { status: 404 }
      );
    }

    const human = await getHumanByWallet(auth.wallet);
    if (!human || channel.contractor_id !== human.id) {
      log("warn", "channel_autobook_unauthorized", {
        channel_id,
        caller: auth.wallet,
      });
      return NextResponse.json(
        {
          ok: false,
          error:
            "Not authorized. Only the channel owner may change auto-booking.",
        },
        { status: 403 }
      );
    }

    const updated = await setChannelAutoBooking(channel_id, accepts_auto_booking);
    if (!updated) {
      return NextResponse.json(
        { ok: false, error: "Channel not found" },
        { status: 404 }
      );
    }

    log("info", "channel_autobook_changed", {
      wallet: auth.wallet,
      type: channel.type,
      accepts_auto_booking,
    });

    return NextResponse.json({ ok: true, channel: updated });
  } catch (err: unknown) {
    return safeErrorResponse(err, "channel_autobook_patch_failed");
  }
}

/** Remove a channel by ID. Only the channel owner's wallet may do this. */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireWalletAuth(request);
    if (!auth.ok) return auth.response;

    const parsedBody = await readJsonBody(request);
    if (!parsedBody.ok) return parsedBody.response;

    const parsed = deleteSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "channel_id (UUID) required" },
        { status: 400 }
      );
    }

    const channel = await getChannelById(parsed.data.channel_id);
    if (!channel) {
      return NextResponse.json(
        { ok: false, error: "Channel not found" },
        { status: 404 }
      );
    }

    const human = await getHumanByWallet(auth.wallet);
    if (!human || channel.contractor_id !== human.id) {
      log("warn", "channel_delete_unauthorized", {
        channel_id: parsed.data.channel_id,
        caller: auth.wallet,
      });
      return NextResponse.json(
        { ok: false, error: "Not authorized. Only the channel owner may remove it." },
        { status: 403 }
      );
    }

    await removeNotificationChannel(channel.id);

    log("info", "notification_channel_removed_dashboard", {
      wallet: auth.wallet,
      type: channel.type,
    });

    return NextResponse.json({ ok: true, id: channel.id });
  } catch (err: unknown) {
    return safeErrorResponse(err, "channel_delete_failed");
  }
}
