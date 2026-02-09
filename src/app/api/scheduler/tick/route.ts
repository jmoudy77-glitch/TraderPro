// src/app/api/scheduler/tick/route.ts
import { NextResponse } from "next/server";
import { LOCAL_WATCHLISTS } from "@/lib/watchlists/local-watchlists";
import { createSupabaseServiceRole } from "@/lib/supabase/server";


function normalizeSymbol(s: string) {
  return s.trim().toUpperCase();
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

type AlpacaBar = {
  t: string; // RFC3339
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n?: number;
  vw?: number;
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`MISSING_ENV:${name}`);
  return v;
}

function requireSchedulerAuth(req: Request): { ok: true } | { ok: false; error: string } {
  const expected = process.env.TRADERPRO_SCHEDULER_SECRET || "";
  if (!expected) return { ok: false, error: "SCHEDULER_SECRET_NOT_CONFIGURED" };
  const got = req.headers.get("x-traderpro-scheduler-secret") ?? "";
  if (!got || got !== expected) return { ok: false, error: "UNAUTHORIZED_SCHEDULER" };
  return { ok: true };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchSymbolMetaNeedsHydrate(params: {
  origin: string;
  symbols: string[];
}): Promise<{ needsHydrate: string[]; needsHydrateCount: number }> {
  const all = Array.from(new Set((params.symbols ?? []).map(normalizeSymbol).filter(Boolean)));
  if (all.length === 0) return { needsHydrate: [], needsHydrateCount: 0 };

  const batches = chunk(all, 200);
  const needs = new Set<string>();
  let count = 0;

  for (const b of batches) {
    const u = new URL(`${params.origin}/api/market/symbol-meta`);
    u.searchParams.set("symbols", b.join(","));
    u.searchParams.set("debug", "1");

    const res = await fetch(u.toString(), { cache: "no-store" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`SYMBOL_META_HTTP_${res.status}:${text.slice(0, 200)}`);
    }

    const json: any = await res.json();
    const list: string[] = (json?.debug?.needsHydrate ?? []) as any;
    for (const s of list) needs.add(normalizeSymbol(s));
    if (typeof json?.needsHydrateCount === "number") count += json.needsHydrateCount;
    else count += list.length;
  }

  return { needsHydrate: Array.from(needs), needsHydrateCount: count };
}

function computeSectorCode(sector: string | null): string | null {
  if (!sector) return null;
  const s = sector.trim();
  if (!s) return null;
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().split(/\s+/).join("").slice(0, 6) || null;
}

const ETF_INDEX_CLASSIFICATION: Record<string, { sector: string; industry: string; industry_code: string; industry_abbrev: string }> = {
  QQQ: { sector: "ETF", industry: "Index ETF", industry_code: "INDEX_ETF", industry_abbrev: "IDX-ETF" },
  ONEQ: { sector: "ETF", industry: "Index ETF", industry_code: "INDEX_ETF", industry_abbrev: "IDX-ETF" },
  SPY: { sector: "ETF", industry: "Index ETF", industry_code: "INDEX_ETF", industry_abbrev: "IDX-ETF" },
  DIA: { sector: "ETF", industry: "Index ETF", industry_code: "INDEX_ETF", industry_abbrev: "IDX-ETF" },
  IWM: { sector: "ETF", industry: "Index ETF", industry_code: "INDEX_ETF", industry_abbrev: "IDX-ETF" },
};

async function hydrateSymbolClassificationEtfStubs(
  supabase: any,
  params: { ownerUserId: string; symbols: string[] }
): Promise<{ hydrated: string[]; skipped: string[] }> {
  const hydrated: string[] = [];
  const skipped: string[] = [];

  const now = new Date().toISOString();

  const rows = (params.symbols ?? [])
    .map(normalizeSymbol)
    .filter(Boolean)
    .map((symbol) => {
      const c = ETF_INDEX_CLASSIFICATION[symbol];
      if (!c) return null;
      return {
        symbol,
        sector: c.sector,
        sector_code: computeSectorCode(c.sector),
        industry: c.industry,
        industry_code: c.industry_code,
        industry_abbrev: c.industry_abbrev,
        updated_at: now,
      };
    })
    .filter(Boolean) as any[];

  const symbolsSet = new Set((params.symbols ?? []).map(normalizeSymbol).filter(Boolean));
  for (const s of symbolsSet) {
    if (ETF_INDEX_CLASSIFICATION[s]) hydrated.push(s);
    else skipped.push(s);
  }

  if (rows.length === 0) return { hydrated: [], skipped };

  const { error } = await supabase.from("symbol_classification").upsert(rows, { onConflict: "symbol" });
  if (error) throw error;

  return { hydrated, skipped };
}

function nowIso() {
  return new Date().toISOString();
}

function isoMinusDays(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function nyTradeDateFromBarTs(ts: string): string {
  // Returns YYYY-MM-DD in America/New_York
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ts));

  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  const y = get("year");
  const m = get("month");
  const d = get("day");
  if (!y || !m || !d) return new Date(ts).toISOString().slice(0, 10);
  return `${y}-${m}-${d}`;
}

async function upsertEodRows(
  supabase: any,
  rows: Array<{ symbol: string; trade_date: string; close: number }>
) {
  if (rows.length === 0) return 0;
  const batches = chunk(rows, 1000);
  let written = 0;
  for (const batch of batches) {
    const { error } = await supabase.from("symbol_eod").upsert(batch, { onConflict: "symbol,trade_date" });
    if (error) throw error;
    written += batch.length;
  }
  return written;
}

const TIMEFRAMES = [
  { key: "1h" as const, alpaca: "1Hour", table: "candles_1h", recentDays: 3, bootstrapDays: 14 },
  { key: "4h" as const, alpaca: "4Hour", table: "candles_4h", recentDays: 14, bootstrapDays: 60 },
  { key: "1d" as const, alpaca: "1Day", table: "candles_daily", recentDays: 30, bootstrapDays: 400 },
];

async function fetchAlpacaBars(params: {
  symbols: string[];
  timeframe: string;
  start: string;
  end: string;
  pageToken?: string | null;
}) {
  const ALPACA_KEY = requireEnv("ALPACA_KEY");
  const ALPACA_SECRET = requireEnv("ALPACA_SECRET");

  // Alpaca data v2 stocks bars endpoint.
  // https://data.alpaca.markets/v2/stocks/bars?symbols=...&timeframe=...&start=...&end=...&feed=sip&adjustment=raw
  const base = "https://data.alpaca.markets/v2/stocks/bars";
  const url = new URL(base);
  url.searchParams.set("symbols", params.symbols.join(","));
  url.searchParams.set("timeframe", params.timeframe);
  url.searchParams.set("start", params.start);
  url.searchParams.set("end", params.end);
  url.searchParams.set("feed", "sip");
  url.searchParams.set("adjustment", "raw");
  if (params.pageToken) url.searchParams.set("page_token", params.pageToken);

  const res = await fetch(url.toString(), {
    headers: {
      "APCA-API-KEY-ID": ALPACA_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ALPACA_BARS_HTTP_${res.status}:${text.slice(0, 200)}`);
  }

  const json: any = await res.json();

  // Expected shape:
  // { bars: { "AAPL": [{t,o,h,l,c,v,n,vw}, ...], ... }, next_page_token?: string }
  const barsBySymbol: Record<string, AlpacaBar[]> = (json?.bars ?? {}) as any;
  return { barsBySymbol, nextPageToken: json?.next_page_token ?? null };
}

async function upsertCandleRows(
  supabase: any,
  table: string,
  rows: any[]
) {
  if (rows.length === 0) return 0;

  // Keep chunk size conservative for PostgREST payload limits.
  const batches = chunk(rows, 1000);
  let written = 0;

  for (const batch of batches) {
    const { error } = await supabase.from(table).upsert(batch, { onConflict: "symbol,ts" });
    if (error) throw error;
    written += batch.length;
  }

  return written;
}

export async function GET(req: Request) {
  const startedAt = new Date();
  const url = new URL(req.url);

  const authz = requireSchedulerAuth(req);
  if (!authz.ok) {
    return NextResponse.json({ ok: false, error: authz.error }, { status: 401 });
  }

  const supabase = createSupabaseServiceRole();

  const origin = url.origin;
  const metaDebug = (url.searchParams.get("metaDebug") || "").toLowerCase() === "1";

  const ownerUserId = process.env.TRADERPRO_DEV_OWNER_USER_ID || "";

  if (!ownerUserId || !isUuid(ownerUserId)) {
    return NextResponse.json(
      { ok: false, error: "MISSING_OR_INVALID_OWNER_USER_ID" },
      { status: 400 }
    );
  }

  // mode=recent (default) keeps it light; mode=bootstrap does initial fill.
  const mode = (url.searchParams.get("mode") || "recent").toLowerCase();
  const isBootstrap = mode === "bootstrap";

  const watchlistKey = url.searchParams.get("watchlistKey")?.trim() || "";

  // Symbol universe:
  // - If watchlistKey provided: ONLY that watchlist’s symbols.
  // - Else: all watchlists + held holdings + sentinel.
  let watchlistsQuery = supabase
    .from("watchlists")
    .select("id")
    .eq("owner_user_id", ownerUserId);

  if (watchlistKey) {
    watchlistsQuery = watchlistsQuery.eq("key", watchlistKey);
  }

  const { data: watchlists, error: watchlistsErr } = await watchlistsQuery;
  if (watchlistsErr) {
    return NextResponse.json({ ok: false, error: watchlistsErr.message }, { status: 500 });
  }

  const watchlistIds = (watchlists ?? []).map((w: any) => w.id).filter(Boolean);

  let symbolsFromWatchlists: string[] = [];
  if (watchlistIds.length > 0) {
    const { data: watchlistSymbols, error: watchlistSymbolsErr } = await supabase
      .from("watchlist_symbols")
      .select("symbol")
      .in("watchlist_id", watchlistIds);

    if (watchlistSymbolsErr) {
      return NextResponse.json({ ok: false, error: watchlistSymbolsErr.message }, { status: 500 });
    }

    symbolsFromWatchlists = (watchlistSymbols ?? []).map((r: any) => r.symbol).filter(Boolean);
  }

  let symbolsFromHoldings: string[] = [];
  if (!watchlistKey) {
    const { data: holdings, error: holdingsErr } = await supabase
      .from("holdings")
      .select("symbol")
      .eq("owner_user_id", ownerUserId)
      .eq("is_held", true);

    if (holdingsErr) {
      return NextResponse.json({ ok: false, error: holdingsErr.message }, { status: 500 });
    }
    symbolsFromHoldings = (holdings ?? []).map((r: any) => r.symbol).filter(Boolean);
  }

  let symbolsFromSentinel: string[] = [];
  if (!watchlistKey) {
    const sentinelRaw: any = (LOCAL_WATCHLISTS as any)?.SENTINEL;
    symbolsFromSentinel = Array.isArray(sentinelRaw)
      ? sentinelRaw
      : Array.isArray(sentinelRaw?.symbols)
        ? sentinelRaw.symbols
        : [];
  }

  const set = new Set<string>();
  for (const s of [...symbolsFromWatchlists, ...symbolsFromHoldings, ...symbolsFromSentinel]) {
    const n = normalizeSymbol(s);
    if (n) set.add(n);
  }

  // Index anchor for DB-owned daily analytics (e.g., industry-posture relToIndex).
  // Only include in global mode (no watchlistKey) so watchlist-scoped ticks remain strict.
  if (!watchlistKey) set.add("QQQ");

  const allSymbols = Array.from(set);

  let metaNeedsHydrate: string[] = [];
  let metaNeedsHydrateCount = 0;
  let metaError: string | null = null;

  try {
    const r = await fetchSymbolMetaNeedsHydrate({ origin, symbols: allSymbols });
    metaNeedsHydrate = r.needsHydrate;
    metaNeedsHydrateCount = r.needsHydrateCount;
  } catch (e: any) {
    metaError = e?.message ?? String(e);
  }

  let symbolMetaHydratedEtf: string[] = [];
  let symbolMetaSkippedEtf: string[] = [];

  // If we have missing/expired symbol meta, opportunistically hydrate known ETF/index stubs.
  // Alpaca does not provide sector/industry classification; this keeps ETF/index proxies from staying perpetually "missing".
  if (metaNeedsHydrate.length > 0) {
    try {
      const r = await hydrateSymbolClassificationEtfStubs(supabase, { ownerUserId, symbols: metaNeedsHydrate });
      symbolMetaHydratedEtf = r.hydrated;
      symbolMetaSkippedEtf = r.skipped;

      // Re-check after hydration to reflect updated truth.
      const rr = await fetchSymbolMetaNeedsHydrate({ origin, symbols: allSymbols });
      metaNeedsHydrate = rr.needsHydrate;
      metaNeedsHydrateCount = rr.needsHydrateCount;
    } catch (e: any) {
      // Preserve original metaError if present; otherwise set it.
      if (!metaError) metaError = e?.message ?? String(e);
    }
  }

  if (allSymbols.length === 0) {
    return NextResponse.json({
      ok: true,
      mode,
      ownerUserId,
      watchlistKey: watchlistKey || null,
      sources: {
        watchlists: symbolsFromWatchlists.length,
        holdings: symbolsFromHoldings.length,
        sentinel: symbolsFromSentinel.length,
      },
      symbolsTotal: 0,
      symbolMeta: {
        needsHydrateCount: 0,
        needsHydrate: metaDebug ? [] : null,
        error: null,
        hydratedEtf: metaDebug ? symbolMetaHydratedEtf : null,
        skippedEtf: metaDebug ? symbolMetaSkippedEtf : null,
      },
      hydrated: { "1h": 0, "4h": 0, "1d": 0 },
      startedAt,
      finishedAt: new Date(),
    });
  }

  const end = nowIso();

  // NOTE: We rely on Alpaca to return finalized bars for 1Hour/4Hour/1Day.
  // We upsert idempotently; your retention policy trims the tables later.
  const hydrated: Record<string, number> = { "1h": 0, "4h": 0, "1d": 0 };
  let eodWritten = 0;
  const errors: Array<{ timeframe: string; error: string }> = [];

  for (const tf of TIMEFRAMES) {
    const days = isBootstrap ? tf.bootstrapDays : tf.recentDays;
    const start = isoMinusDays(days);

    try {
      // Alpaca supports multi-symbol requests; keep batch size safe.
      // 200 is conservative; you’re currently ~50 symbols anyway.
      const symbolBatches = chunk(allSymbols, 200);

      let totalRows = 0;

      for (const symbols of symbolBatches) {
        let pageToken: string | null = null;
        let pageCount = 0;

        while (true) {
          // Guard against infinite pagination loops.
          if (pageCount++ > 200) throw new Error("ALPACA_BARS_PAGINATION_GUARD");

          const { barsBySymbol, nextPageToken } = await fetchAlpacaBars({
            symbols,
            timeframe: tf.alpaca,
            start,
            end,
            pageToken,
          });

          const rows: any[] = [];
          const eodRows: Array<{ symbol: string; trade_date: string; close: number }> = [];

          for (const [sym, bars] of Object.entries(barsBySymbol)) {
            const symbol = normalizeSymbol(sym);
            for (const b of bars ?? []) {
              rows.push({
                symbol,
                ts: b.t,
                o: b.o,
                h: b.h,
                l: b.l,
                c: b.c,
                v: b.v,
              });

              // `symbol_eod` is the durable session-based EOD tape.
              // Populate ONLY from Alpaca 1Day bars.
              if (tf.key === "1d") {
                const trade_date = nyTradeDateFromBarTs(b.t);
                if (trade_date && Number.isFinite(b.c)) {
                  eodRows.push({ symbol, trade_date, close: b.c });
                }
              }
            }
          }

          // Write this page immediately to keep memory bounded.
          totalRows += await upsertCandleRows(supabase, tf.table, rows);
          if (tf.key === "1d") {
            eodWritten += await upsertEodRows(supabase, eodRows);
          }

          if (!nextPageToken) break;
          pageToken = nextPageToken;
        }
      }

      hydrated[tf.key] = totalRows;
    } catch (e: any) {
      errors.push({ timeframe: tf.key, error: e?.message ?? String(e) });
    }
  }

  return NextResponse.json({
    ok: true,
    mode,
    ownerUserId,
    watchlistKey: watchlistKey || null,
    sources: {
      watchlists: symbolsFromWatchlists.length,
      holdings: symbolsFromHoldings.length,
      sentinel: symbolsFromSentinel.length,
    },
    symbolsTotal: allSymbols.length,
    symbolMeta: {
      needsHydrateCount: metaNeedsHydrateCount,
      needsHydrate: metaDebug ? metaNeedsHydrate : null,
      error: metaError,
      hydratedEtf: metaDebug ? symbolMetaHydratedEtf : null,
      skippedEtf: metaDebug ? symbolMetaSkippedEtf : null,
    },
    hydrated,
    symbolEodWritten: eodWritten,
    errorCount: errors.length,
    errors: errors.length ? errors : null,
    startedAt,
    finishedAt: new Date(),
  });
}