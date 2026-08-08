import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/db/client";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";
import { isValidEmail } from "@/lib/validation";
import { apiRateLimiter } from "@/lib/ratelimit";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.email ?? "").trim().toLowerCase();

    if (!isValidEmail(email)) {
      return NextResponse.json(
        { ok: false, error: "Invalid email address" },
        { status: 400 },
      );
    }

    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("waitlist")
      .upsert({ email }, { onConflict: "email", ignoreDuplicates: true });

    if (error) throw error;

    log("info", "waitlist_signup", { email });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return safeErrorResponse(err, "waitlist_signup_failed");
  }
}

/**
 * Self-serve unsubscribe (CC-067). No auth, no token — this is a low-stakes marketing
 * list, not sensitive data, and the threat model is the same as joining it in the first
 * place (you already know the email you're typing in). Always returns a generic success
 * response so the endpoint can't be used to check whether a given email is on the list.
 */
export async function DELETE(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for") ?? "127.0.0.1";
    const { success, retryAfterS } = await apiRateLimiter.limit(ip);
    if (!success) {
      return NextResponse.json(
        { ok: false, error: "Rate limit exceeded. Try again later." },
        { status: 429, headers: { "Retry-After": String(retryAfterS) } },
      );
    }

    const body = await req.json();
    const email = (body.email ?? "").trim().toLowerCase();

    if (!isValidEmail(email)) {
      return NextResponse.json(
        { ok: false, error: "Invalid email address" },
        { status: 400 },
      );
    }

    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("waitlist").delete().eq("email", email);

    if (error) throw error;

    log("info", "waitlist_unsubscribed", { email });
    return NextResponse.json({
      ok: true,
      message: "If that email was on our list, it has been removed.",
    });
  } catch (err) {
    return safeErrorResponse(err, "waitlist_unsubscribe_failed");
  }
}
