// /Users/joshmoudy/dev/traderpro/src/app/api/user/preferences/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function supabaseService() {
  return createClient(getEnv("SUPABASE_URL"), getEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

// Until auth is wired, mirror the pattern used elsewhere: drive by DEV owner id.
function devUserId() {
  const v = process.env.TRADERPRO_DEV_OWNER_USER_ID;
  if (!v) throw new Error("Missing env: TRADERPRO_DEV_OWNER_USER_ID");
  return v;
}

export async function GET() {
  try {
    const userId = devUserId();
    const supabase = supabaseService();

    const { data, error } = await supabase
      .from("user_preferences")
      .select("timezone,default_time_range,default_resolution,default_indicators")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;

    return NextResponse.json({
      ok: true,
      preferences: {
        timezone: data?.timezone ?? "America/Chicago",
        default_time_range: data?.default_time_range ?? "1D",
        default_resolution: data?.default_resolution ?? "5m",
        default_indicators: data?.default_indicators ?? {
          rsi: true,
          macd: true,
          sma50: true,
          sma200: true,
        },
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "unknown_error", preferences: { timezone: "America/Chicago" } },
      { status: 200 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const userId = devUserId();
    const supabase = supabaseService();
    const body = (await req.json()) as { timezone?: unknown };

    const timezone = typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : null;
    if (!timezone) return NextResponse.json({ ok: false, error: "missing_timezone" }, { status: 400 });

    const { error } = await supabase.from("user_preferences").upsert(
      {
        user_id: userId,
        timezone,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    if (error) throw error;

    return NextResponse.json({ ok: true, preferences: { timezone } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "unknown_error" }, { status: 500 });
  }
}