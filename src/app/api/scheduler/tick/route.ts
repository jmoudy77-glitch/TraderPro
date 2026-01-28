// src/app/api/scheduler/tick/route.ts
import { NextResponse } from "next/server";
import { LOCAL_WATCHLISTS } from "@/lib/watchlists/local-watchlists";
import { createClient } from "@supabase/supabase-js";
import { getProfile } from "@/lib/market-data/twelvedata";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const DRY_RUN = process.env.SECTOR_HYDRATOR_DRY_RUN === "1";
const MAX = Number(process.env.MAX_SECTOR_HYDRATES_PER_TICK ?? "5");

function normalizeSymbol(s: string) {
  return s.trim().toUpperCase();
}

function deriveSectorCode(sector: string): string {
  // Keep this deterministic + compatible with your sectors table
  // (If you already have a mapping table, use it instead.)
  return sector.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function normalizeIndustry(raw: string): string {
  return raw
    .trim()
    .replace(/[–—]/g, "-")
    .replace(/&/g, "AND")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function deriveIndustryCode(industry: string): string {
  return industry.replace(/[^A-Z0-9]+/g, "_");
}

const INDUSTRY_ABBREV_OVERRIDES: Record<string, string> = {
  CAPITAL_MARKETS: "CAP-MKTS",
  OIL_AND_GAS_MIDSTREAM: "OIL-GAS",
  OTHER_INDUSTRIAL_METALS_AND_MINING: "MTL-MIN",
  SEMICONDUCTORS: "SEMIS",
  SOFTWARE_APPLICATION: "SW-APP",
  SOFTWARE_INFRASTRUCTURE: "SW-INFRA",
};

function deriveIndustryAbbrev(industryCode: string): string {
  const override = INDUSTRY_ABBREV_OVERRIDES[industryCode];
  if (override) return override;

  // Stopwords / low-signal tokens to drop from the abbreviation.
  const STOP = new Set(["OTHER", "AND", "OF", "THE", "FOR", "IN", "ON", "TO", "WITH"]);

  // Token-level abbreviations for common finance/industry words.
  const TOK: Record<string, string> = {
    APPLICATION: "APP",
    BASIC: "BSC",
    CAPITAL: "CAP",
    COMMUNICATION: "COM",
    CONSUMER: "CNS",
    CYCLICAL: "CYC",
    DEFENSIVE: "DEF",
    ENERGY: "NRG",
    EQUIPMENT: "EQP",
    FINANCIAL: "FIN",
    HEALTHCARE: "HLTH",
    INDUSTRIAL: "IND",
    INFRASTRUCTURE: "INF",
    INFORMATION: "INFO",
    INTERNET: "NET",
    MATERIALS: "MAT",
    METALS: "MTL",
    MINING: "MIN",
    OIL: "OIL",
    GAS: "GAS",
    REAL: "RE",
    ESTATE: "EST",
    RETAIL: "RTL",
    SERVICES: "SVC",
    SOFTWARE: "SW",
    SEMICONDUCTORS: "SEMIS",
    TECHNOLOGY: "TECH",
    TRANSPORTATION: "TRNS",
    UTILITIES: "UTIL",
  };

  const rawTokens = industryCode
    .split("_")
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !STOP.has(t));

  const mapToken = (t: string) => {
    const m = TOK[t];
    if (m) return m;
    // Fallback: up to 4 chars for readability; prefer full token if already short.
    return t.length <= 4 ? t : t.slice(0, 4);
  };

  // Prefer the most-specific tail tokens.
  const tail = rawTokens.slice(-3).map(mapToken);

  // Compose candidates from tail to head, trying to fit within 8 chars.
  const candidates: string[] = [];
  if (tail.length >= 2) candidates.push(`${tail[tail.length - 2]}-${tail[tail.length - 1]}`);
  if (tail.length >= 3) candidates.push(`${tail[tail.length - 3]}-${tail[tail.length - 2]}`);
  if (tail.length >= 1) candidates.push(`${tail[tail.length - 1]}`);

  const MAX_LEN = 8;
  for (const c of candidates) {
    if (c.length <= MAX_LEN) return c;
  }

  // Last-resort: hard truncate to MAX_LEN.
  return candidates[0].slice(0, MAX_LEN);
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export async function GET(req: Request) {
  const startedAt = new Date();

  const url = new URL(req.url);
  const ownerUserId =
    url.searchParams.get("ownerUserId") ||
    process.env.NEXT_PUBLIC_DEV_OWNER_USER_ID ||
    process.env.DEV_OWNER_USER_ID ||
    "";

  if (!ownerUserId || !isUuid(ownerUserId)) {
    return NextResponse.json(
      { ok: false, error: "MISSING_OR_INVALID_OWNER_USER_ID" },
      { status: 400 }
    );
  }

  const watchlistKey = url.searchParams.get("watchlistKey")?.trim() || "";
  const maxParam = url.searchParams.get("max")?.trim() || "";
  const maxPerTick = Math.max(1, Math.min(50, Number(maxParam || MAX)));

  // 2.1 Symbol collection
  // - If watchlistKey is provided: ONLY that watchlist's symbols (scheduled warmer behavior)
  // - Else: global set = all watchlists + held holdings + sentinel

  let watchlistsQuery = supabase
    .from("watchlists")
    .select("id")
    .eq("owner_user_id", ownerUserId);

  if (watchlistKey) {
    watchlistsQuery = watchlistsQuery.eq("key", watchlistKey);
  }

  const { data: watchlists, error: watchlistsErr } = await watchlistsQuery;

  if (watchlistsErr) {
    return NextResponse.json(
      { ok: false, error: watchlistsErr.message },
      { status: 500 }
    );
  }

  const watchlistIds = (watchlists ?? []).map((w: any) => w.id).filter(Boolean);

  let symbolsFromWatchlists: string[] = [];
  if (watchlistIds.length > 0) {
    const { data: watchlistSymbols, error: watchlistSymbolsErr } = await supabase
      .from("watchlist_symbols")
      .select("symbol")
      .in("watchlist_id", watchlistIds);

    if (watchlistSymbolsErr) {
      return NextResponse.json(
        { ok: false, error: watchlistSymbolsErr.message },
        { status: 500 }
      );
    }

    symbolsFromWatchlists = (watchlistSymbols ?? [])
      .map((r: any) => r.symbol)
      .filter(Boolean);
  }

  // Holdings (only in global mode)
  let symbolsFromHoldings: string[] = [];
  if (!watchlistKey) {
    const { data: holdings, error: holdingsErr } = await supabase
      .from("holdings")
      .select("symbol")
      .eq("owner_user_id", ownerUserId)
      .eq("is_held", true);

    if (holdingsErr) {
      return NextResponse.json(
        { ok: false, error: holdingsErr.message },
        { status: 500 }
      );
    }

    symbolsFromHoldings = (holdings ?? []).map((r: any) => r.symbol).filter(Boolean);
  }

  // Sentinel (local) (only in global mode)
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
  for (const s of [
    ...symbolsFromWatchlists,
    ...symbolsFromHoldings,
    ...symbolsFromSentinel,
  ]) {
    const n = normalizeSymbol(s);
    if (n) set.add(n);
  }
  const allSymbols = Array.from(set);

  if (allSymbols.length === 0) {
    return NextResponse.json({
      ok: true,
      dryRun: DRY_RUN,
      ownerUserId,
      watchlistKey: watchlistKey || null,
      maxPerTick,
      sources: {
        watchlists: symbolsFromWatchlists.length,
        holdings: symbolsFromHoldings.length,
        sentinel: symbolsFromSentinel.length,
      },
      symbolsTotal: 0,
      missCount: 0,
      selectedCount: 0,
      hydratedCount: 0,
      errorCount: 0,
      startedAt,
      finishedAt: new Date(),
    });
  }

  // Query existing classification rows
  const { data: rows, error: readErr } = await supabase
    .from("symbol_classification")
    .select("symbol, sector, industry, updated_at")
    .in("symbol", allSymbols);

  if (readErr) {
    return NextResponse.json({ ok: false, error: readErr.message }, { status: 500 });
  }

  const rowBySymbol = new Map<string, any>();
  for (const r of rows ?? []) {
    rowBySymbol.set(normalizeSymbol(r.symbol), r);
  }

  // Phase 2 miss semantics:
  // - no row exists, OR
  // - sector is null/empty
  const misses: string[] = [];
  for (const s of allSymbols) {
    const r = rowBySymbol.get(s);
    if (!r) {
      misses.push(s);
      continue;
    }

    const sector = (r.sector ?? "").toString().trim();
    if (!sector) misses.push(s);
  }

  const selected = misses.slice(0, maxPerTick);

  // Dry run (Rollout step 4)
  if (DRY_RUN) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      ownerUserId,
      watchlistKey: watchlistKey || null,
      maxPerTick,
      sources: {
        watchlists: symbolsFromWatchlists.length,
        holdings: symbolsFromHoldings.length,
        sentinel: symbolsFromSentinel.length,
      },
      symbolsTotal: allSymbols.length,
      missCount: misses.length,
      selectedCount: selected.length,
      wouldHydrate: selected,
      startedAt,
      finishedAt: new Date(),
    });
  }

  // Writes enabled (Rollout step 5)
  let hydratedCount = 0;
  let errorCount = 0;

  for (const symbol of selected) {
    try {
      const profile = await getProfile(symbol); // Twelve Data /profile (1 credit)
      const sector = (profile?.sector ?? "").trim();
      const industryRaw = (profile?.industry ?? "").trim();

      // If sector missing, do NOT write partials (schema invariants)
      if (!sector) continue;

      const { error: upsertErr } = await supabase
        .from("symbol_classification")
        .upsert(
          {
            symbol: normalizeSymbol(symbol),
            sector,
            industry: industryRaw || null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "symbol" }
        );

      if (upsertErr) throw upsertErr;
      hydratedCount++;
    } catch {
      errorCount++;
      // silent failure per Note; retry on later ticks
    }
  }

  return NextResponse.json({
    ok: true,
    dryRun: false,
    ownerUserId,
    watchlistKey: watchlistKey || null,
    maxPerTick,
    sources: {
      watchlists: symbolsFromWatchlists.length,
      holdings: symbolsFromHoldings.length,
      sentinel: symbolsFromSentinel.length,
    },
    symbolsTotal: allSymbols.length,
    missCount: misses.length,
    selectedCount: selected.length,
    hydratedCount,
    errorCount,
    startedAt,
    finishedAt: new Date(),
  });
}