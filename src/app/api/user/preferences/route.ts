// /Users/joshmoudy/dev/traderpro/src/app/api/user/preferences/route.ts
import { NextResponse } from "next/server";
import {
  createSupabaseServerAnon,
  createSupabaseServerWithJwt,
  createSupabaseServiceRole,
} from "@/lib/supabase/server";

function getBearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

function getDevOwnerId() {
  if (process.env.NODE_ENV !== "development") return null;
  if (process.env.TRADERPRO_DEV_OWNER_FALLBACK !== "true") return null;
  return process.env.TRADERPRO_DEV_OWNER_USER_ID || null;
}

async function resolveActor(req: Request) {
  const jwt = getBearerToken(req);

  if (jwt) {
    const supabase = createSupabaseServerAnon();
    const { data: auth, error: authErr } = await supabase.auth.getUser(jwt);
    if (authErr || !auth?.user) return { ok: false as const };

    const supabaseBound = createSupabaseServerWithJwt(jwt);
    return {
      ok: true as const,
      uid: auth.user.id,
      supabase: supabaseBound,
      mode: "authed" as const,
    };
  }

  const devOwnerId = getDevOwnerId();
  if (devOwnerId) {
    const supabase = createSupabaseServiceRole();
    return {
      ok: true as const,
      uid: devOwnerId,
      supabase,
      mode: "dev" as const,
    };
  }

  return { ok: false as const };
}

export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req);
    if (!actor.ok) {
      return NextResponse.json({ ok: false, error: "UNAUTHENTICATED" }, { status: 401 });
    }
    const userId = actor.uid;
    const supabase = actor.supabase;

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
      { ok: false, error: e?.message ?? "unknown_error" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req);
    if (!actor.ok) {
      return NextResponse.json({ ok: false, error: "UNAUTHENTICATED" }, { status: 401 });
    }
    const userId = actor.uid;
    const supabase = actor.supabase;
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