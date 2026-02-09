import { NextResponse } from "next/server";
import {
  createSupabaseServerAnon,
  createSupabaseServerWithJwt,
  createSupabaseServiceRole,
} from "@/lib/supabase/server";

function parseWatchlistKey(v: string | null): string | null {
  const s = (v ?? "").trim();
  return s ? s : null;
}

function parseSectors(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, 200);
}

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

/**
 * User-specific ordering of sectors within a watchlist.
 *
 * GET  /api/watchlists/sector-order?watchlistKey=LAUNCH_LEADERS
 * POST /api/watchlists/sector-order { watchlistKey, sectors: [...] }
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const watchlistKey = parseWatchlistKey(searchParams.get("watchlistKey"));

  if (!watchlistKey) {
    return NextResponse.json({ ok: false, error: "MISSING_PARAMS" }, { status: 400 });
  }

  const actor = await resolveActor(req);
  if (!actor.ok) {
    return NextResponse.json({ ok: false, error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const supabase = actor.supabase;
  const { data, error } = await supabase
    .from("watchlist_sector_order")
    .select("sector, sort_index")
    .eq("owner_user_id", actor.uid)
    .eq("watchlist_key", watchlistKey)
    .order("sort_index", { ascending: true })
    .order("sector", { ascending: true });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, sectors: (data ?? []).map((r: any) => r.sector) });
}

export async function POST(req: Request) {
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "BAD_JSON" }, { status: 400 });
  }

  const watchlistKey = parseWatchlistKey(body?.watchlistKey ?? null);
  const sectors = parseSectors(body?.sectors);

  if (!watchlistKey) {
    return NextResponse.json({ ok: false, error: "MISSING_PARAMS" }, { status: 400 });
  }

  const actor = await resolveActor(req);
  if (!actor.ok) {
    return NextResponse.json({ ok: false, error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const supabase = actor.supabase;

  // Upsert requested order. We do NOT delete other sectors here; client can omit for partial order.
  const rows = sectors.map((sector, i) => ({
    owner_user_id: actor.uid,
    watchlist_key: watchlistKey,
    sector,
    sort_index: (i + 1) * 10,
  }));

  if (rows.length > 0) {
    const { error } = await supabase
      .from("watchlist_sector_order")
      .upsert(rows, { onConflict: "owner_user_id,watchlist_key,sector" });
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
