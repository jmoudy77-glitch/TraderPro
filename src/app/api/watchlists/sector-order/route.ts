import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  if (!serviceKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

function parseOwner(v: string | null): string | null {
  const s = (v ?? "").trim();
  return s ? s : null;
}

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

/**
 * User-specific ordering of sectors within a watchlist.
 *
 * GET  /api/watchlists/sector-order?ownerUserId=<uuid>&watchlistKey=LAUNCH_LEADERS
 * POST /api/watchlists/sector-order { ownerUserId, watchlistKey, sectors: [...] }
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const ownerUserId = parseOwner(searchParams.get("ownerUserId"));
  const watchlistKey = parseWatchlistKey(searchParams.get("watchlistKey"));

  if (!ownerUserId || !watchlistKey) {
    return NextResponse.json({ ok: false, error: "MISSING_PARAMS" }, { status: 400 });
  }

  const supabase = getAdmin();
  const { data, error } = await supabase
    .from("watchlist_sector_order")
    .select("sector, sort_index")
    .eq("owner_user_id", ownerUserId)
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

  const ownerUserId = parseOwner(body?.ownerUserId ?? null);
  const watchlistKey = parseWatchlistKey(body?.watchlistKey ?? null);
  const sectors = parseSectors(body?.sectors);

  if (!ownerUserId || !watchlistKey) {
    return NextResponse.json({ ok: false, error: "MISSING_PARAMS" }, { status: 400 });
  }

  const supabase = getAdmin();

  // Upsert requested order. We do NOT delete other sectors here; client can omit for partial order.
  const rows = sectors.map((sector, i) => ({
    owner_user_id: ownerUserId,
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
