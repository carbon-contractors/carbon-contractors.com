import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/db/client";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";

// Linear-time email check: no nested quantifiers, max 254 chars (RFC 5321)
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const MAX_EMAIL_LEN = 254;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.email ?? "").trim().toLowerCase();

    if (!email || email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) {
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
