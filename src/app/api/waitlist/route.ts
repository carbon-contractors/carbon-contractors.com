import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/db/client";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";
import { isValidEmail } from "@/lib/validation";

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
