// src/app/api/market/industry-posture/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchTwelveDataTimeSeries } from "@/lib/market-data/twelvedata";
import { LOCAL_WATCHLISTS } from "@/lib/watchlists/local-watchlists";

type RelToIndex = "OUTPERFORM" | "INLINE" | "UNDERPERFORM";
type Trend5d = "UP" | "FLAT" | "DOWN";

type IndustryPostureItem = {
  industryCode: string;
  industryAbbrev: string;
  dayChangePct: number;
  volRel: number; // 0..1, midpoint at 0.5
  trend5d: Trend5d;
  relToIndex: RelToIndex;
  hasNews?: boolean;
  symbols?: string[];
};

type CacheEntry = { expiresAt: number; value: any };
const CACHE = new Map<string, CacheEntry>();
const INFLIGHT = new Map<string, Promise<any>>();

function cacheGet<T>(key: string): T | null {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    CACHE.delete(key);
    return null;
  }
  return hit.value as T;
}

function cacheSet(key: string, value: any, ttlMs: number) {
  CACHE.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function qpBool(v: string | null): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function computeTwelveDataBreakerUntil(message: string): number {
  const m = message.toLowerCase();

  // Minute-limit / rate-limit: cool down to the next minute boundary (+2s buffer)
  if (
    m.includes("current limit") ||
    m.includes("current minute") ||
    m.includes("per minute") ||
    m.includes("too many requests")
  ) {
    const now = Date.now();
    const nextMinute = Math.floor(now / 60_000) * 60_000 + 60_000;
    return nextMinute + 2_000;
  }

  // Generic provider failure: short backoff
  return Date.now() + 60_000;
}

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  if (!serviceKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

function normalizeSymbol(s: string): string {
  return String(s ?? "")
    .trim()
    .toUpperCase();
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function avg(nums: number[]): number {
  const v = nums.filter((n) => Number.isFinite(n));
  if (v.length === 0) return 0;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function todayKeyNy(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function computeDayChangePct(series: { close: number }[]): number | null {
  if (!series || series.length < 2) return null;
  const last = series[series.length - 1]?.close;
  const prev = series[series.length - 2]?.close;
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev === 0) return null;
  return ((last - prev) / prev) * 100;
}

function computeTrend5d(series: { close: number }[]): Trend5d {
  // Need at least 6 daily closes to compare (t vs t-5)
  if (!series || series.length < 6) return "FLAT";
  const last = series[series.length - 1]?.close;
  const prev5 = series[series.length - 6]?.close;
  if (!Number.isFinite(last) || !Number.isFinite(prev5) || prev5 === 0) return "FLAT";

  const pct = (last - prev5) / prev5;
  if (pct > 0.02) return "UP";
  if (pct < -0.02) return "DOWN";
  return "FLAT";
}

function computeVolRatio(series: { volume?: number }[]): { todayVol: number; baselineVol: number } {
  if (!series || series.length === 0) return { todayVol: 0, baselineVol: 0 };

  const last = series[series.length - 1];
  const todayVol = Number.isFinite(last?.volume as any) ? Number(last?.volume) : 0;

  // Baseline = avg of prior up to 5 sessions (excluding today)
  const prior = series.slice(0, -1).slice(-5);
  const priorVols = prior
    .map((c) => (Number.isFinite(c?.volume as any) ? Number(c?.volume) : 0))
    .filter((v) => v > 0);

  const baselineVol = avg(priorVols);
  return { todayVol, baselineVol };
}

function volRelFromRatio(ratio: number): number {
  // ratio=1 => 0.5 midpoint
  // gentle scaling: +/-100% maps to about [0.25..0.75]
  if (!Number.isFinite(ratio) || ratio <= 0) return 0.5;
  return clamp01(0.5 + (ratio - 1) * 0.25);
}

function relToIndexFromDelta(deltaPct: number): RelToIndex {
  if (!Number.isFinite(deltaPct)) return "INLINE";
  if (deltaPct > 0.25) return "OUTPERFORM";
  if (deltaPct < -0.25) return "UNDERPERFORM";
  return "INLINE";
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const ownerUserId = searchParams.get("ownerUserId");
    const watchlistKey = searchParams.get("watchlistKey"); // optional narrowing
    const scheduler = qpBool(searchParams.get("scheduler"));
    const cacheOnly = qpBool(searchParams.get("cacheOnly"));

    if (!ownerUserId) {
      return NextResponse.json({ ok: false, error: "MISSING_OWNER_USER_ID" }, { status: 400 });
    }

    const ttlMs = Number(process.env.INDUSTRY_POSTURE_TTL_MS ?? "60000");
    const cacheKey = `industry-posture:${todayKeyNy()}:${ownerUserId}:${watchlistKey ?? "ALL"}`;

    const cached = cacheGet<any>(cacheKey);
    if (cached) return NextResponse.json(cached);

    const inflight = INFLIGHT.get(cacheKey);
    if (inflight) return NextResponse.json(await inflight);

    const marketSource = (process.env.MARKET_SOURCE ?? "stub").toLowerCase();

    // Prevent accidental credit burn.
    const twelvedataEnabled =
      (process.env.TWELVEDATA_ENABLE ?? "false").toLowerCase() === "true" && marketSource !== "stub";

    // Circuit breaker stored per server instance.
    const TWELVEDATA_BREAKER_KEY = "twelvedata:breaker";
    const breaker = cacheGet<{ until: number; reason: string }>(TWELVEDATA_BREAKER_KEY);
    const breakerActive = breaker ? Date.now() < breaker.until : false;

    const p = (async () => {
      const supabase = getAdmin();

      // -----------------------------
      // 1) Universe: DB watchlists + holdings, with LOCAL_WATCHLISTS fallback
      // -----------------------------
      let symbolsFromWatchlists: string[] = [];

      // Watchlists
      {
        let wlQuery = supabase.from("watchlists").select("id").eq("owner_user_id", ownerUserId);
        if (watchlistKey) wlQuery = wlQuery.eq("key", watchlistKey);

        const { data: wlData, error: wlErr } = await wlQuery;
        if (wlErr) throw new Error(wlErr.message);

        const watchlistIds = (wlData ?? []).map((r: any) => r.id).filter(Boolean);
        if (watchlistIds.length > 0) {
          const { data: rows, error } = await supabase
            .from("watchlist_symbols")
            .select("symbol")
            .in("watchlist_id", watchlistIds)
            .eq("is_active", true);

          if (error) throw new Error(error.message);
          symbolsFromWatchlists = (rows ?? []).map((r: any) => r.symbol).filter(Boolean);
        }
      }

      // Holdings (only when not narrowed to a specific watchlist)
      let symbolsFromHoldings: string[] = [];
      if (!watchlistKey) {
        const { data: rows, error } = await supabase
          .from("holdings")
          .select("symbol, is_held")
          .eq("owner_user_id", ownerUserId);

        if (error) throw new Error(error.message);

        // Only include held positions for posture context; avoids pulling in stale “tracked but not held” entries.
        symbolsFromHoldings = (rows ?? [])
          .filter((r: any) => Boolean(r?.is_held))
          .map((r: any) => r.symbol)
          .filter(Boolean);
      }

      // Fallback (dev-friendly)
      const fallbackLocal =
        symbolsFromWatchlists.length === 0 && symbolsFromHoldings.length === 0
          ? Object.values(LOCAL_WATCHLISTS).flat()
          : [];

      const allSymbols = Array.from(
        new Set([...symbolsFromWatchlists, ...symbolsFromHoldings, ...fallbackLocal].map(normalizeSymbol).filter(Boolean))
      );

      const maxSymbols = Number(process.env.INDUSTRY_POSTURE_MAX_SYMBOLS ?? "160");
      const boundedSymbols = allSymbols.slice(0, Math.max(0, maxSymbols));

      if (boundedSymbols.length === 0) {
        return { ok: true, items: [] as IndustryPostureItem[] };
      }

      // -----------------------------
      // 2) Classification: industry_code + industry_abbrev
      // -----------------------------
      const { data: scData, error: scErr } = await supabase
        .from("symbol_classification")
        .select("symbol, industry_code, industry_abbrev")
        .in("symbol", boundedSymbols);

      if (scErr) throw new Error(scErr.message);

      const byIndustry = new Map<string, { abbrev: string; symbols: string[] }>();

      for (const r of scData ?? []) {
        const symbol = normalizeSymbol((r as any).symbol);
        const code = String((r as any).industry_code ?? "").trim();
        const abbrev = String((r as any).industry_abbrev ?? "").trim();
        if (!symbol || !code || !abbrev) continue;

        const existing = byIndustry.get(code) ?? { abbrev, symbols: [] };
        if (!existing.abbrev) existing.abbrev = abbrev;
        if (!existing.symbols.includes(symbol)) existing.symbols.push(symbol);
        byIndustry.set(code, existing);
      }

      if (byIndustry.size === 0) {
        return { ok: true, items: [] as IndustryPostureItem[] };
      }

      // -----------------------------
      // 3) Provider fetch (guarded)
      // -----------------------------
      const indexSymbol = "QQQ";
      const symbolsForProvider = Array.from(
        new Set([indexSymbol, ...Array.from(byIndustry.values()).flatMap((v) => v.symbols)])
      );

      // If cacheOnly OR disabled OR breaker active: return classification-only posture stubs
      if (cacheOnly || !twelvedataEnabled || breakerActive) {
        const items: IndustryPostureItem[] = Array.from(byIndustry.entries()).map(([industryCode, v]) => ({
          industryCode,
          industryAbbrev: v.abbrev,
          dayChangePct: 0,
          volRel: 0.5,
          trend5d: "FLAT",
          relToIndex: "INLINE",
          hasNews: false,
          symbols: v.symbols.slice(),
        }));

        return { ok: true, items };
      }

      let seriesBySymbol: Record<string, any[]> = {};
      try {
        seriesBySymbol = await fetchTwelveDataTimeSeries({
          symbols: symbolsForProvider,
          resolution: "1d",
          range: "1M",
          outputsizeExtraLookback: 0,
        });
      } catch (e: any) {
        // Trip breaker so we don’t storm the provider.
        const msg = String(e?.message ?? "Twelve Data error");
        cacheSet(
          TWELVEDATA_BREAKER_KEY,
          { until: computeTwelveDataBreakerUntil(msg), reason: msg },
          5 * 60_000
        );

        // Fail soft: classification-only response (keeps UI stable)
        const items: IndustryPostureItem[] = Array.from(byIndustry.entries()).map(([industryCode, v]) => ({
          industryCode,
          industryAbbrev: v.abbrev,
          dayChangePct: 0,
          volRel: 0.5,
          trend5d: "FLAT",
          relToIndex: "INLINE",
          hasNews: false,
          symbols: v.symbols.slice(),
        }));

        return { ok: true, items, ...(scheduler ? { debug: { providerError: msg } } : {}) };
      }

      const qqqSeries = (seriesBySymbol[indexSymbol] ?? []).slice().sort((a, b) => a.time - b.time);
      const indexDayPct = computeDayChangePct(qqqSeries) ?? 0;

      // -----------------------------
      // 4) Aggregate posture per industry (equal-weight dayChangePct)
      // -----------------------------
      const items: IndustryPostureItem[] = [];

      for (const [industryCode, v] of byIndustry.entries()) {
        const symbols = v.symbols.slice();

        const perSymbolDayPct: number[] = [];
        const perSymbolTrend: Trend5d[] = [];

        let aggTodayVol = 0;
        let aggBaselineVol = 0;

        for (const s of symbols) {
          const series = (seriesBySymbol[s] ?? []).slice().sort((a, b) => a.time - b.time);
          if (series.length < 2) continue;

          const dayPct = computeDayChangePct(series);
          if (dayPct != null) perSymbolDayPct.push(dayPct);

          perSymbolTrend.push(computeTrend5d(series));

          const { todayVol, baselineVol } = computeVolRatio(series);
          aggTodayVol += todayVol;
          aggBaselineVol += baselineVol;
        }

        if (perSymbolDayPct.length === 0) continue;

        const dayChangePct = avg(perSymbolDayPct);

        // Trend = majority vote (UP vs DOWN), else FLAT
        const up = perSymbolTrend.filter((t) => t === "UP").length;
        const down = perSymbolTrend.filter((t) => t === "DOWN").length;
        const trend5d: Trend5d =
          up > down && up > 0 ? "UP" : down > up && down > 0 ? "DOWN" : "FLAT";

        const volRatio = aggBaselineVol > 0 ? aggTodayVol / aggBaselineVol : 1;
        const volRel = volRelFromRatio(volRatio);

        const relToIndex = relToIndexFromDelta(dayChangePct - indexDayPct);

        items.push({
          industryCode,
          industryAbbrev: v.abbrev,
          dayChangePct,
          volRel,
          trend5d,
          relToIndex,
          hasNews: false,
          symbols,
        });
      }

      // Stable ordering (UI will still select/slice, but this helps repeatability)
      items.sort(
        (a, b) =>
          b.volRel - a.volRel ||
          Math.abs(b.dayChangePct) - Math.abs(a.dayChangePct) ||
          a.industryAbbrev.localeCompare(b.industryAbbrev) ||
          a.industryCode.localeCompare(b.industryCode)
      );

      return { ok: true, items };
    })();

    INFLIGHT.set(cacheKey, p);
    const value = await p;
    INFLIGHT.delete(cacheKey);

    cacheSet(cacheKey, value, ttlMs);
    return NextResponse.json(value);
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? "UNKNOWN_ERROR" },
      { status: 500 }
    );
  }
}