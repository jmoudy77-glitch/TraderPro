import { NextResponse } from "next/server";
import { generateStubCandles } from "@/lib/market-data/stub";
import { fetchTwelveDataTimeSeries } from "@/lib/market-data/twelvedata";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type Candle = { time: number; open: number; high: number; low: number; close: number };

type DurableResolution = "1h" | "4h" | "1d";

function durableTableForResolution(resolution: string): "candles_1h" | "candles_4h" | "candles_daily" | null {
  switch (resolution) {
    case "1h":
      return "candles_1h";
    case "4h":
      return "candles_4h";
    case "1d":
      return "candles_daily";
    default:
      return null;
  }
}

function toIsoFromEpochSeconds(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

async function persistDurableCandles(args: {
  supabase: SupabaseClient;
  symbol: string;
  resolution: string;
  candles: Array<Candle & { volume?: number }>;
  source: string;
  ownerUserId?: string | null;
}) {
  const table = durableTableForResolution(args.resolution);
  if (!table) return;

  const rows = (args.candles ?? []).map((c) => ({
    owner_user_id: args.ownerUserId ?? null,
    symbol: args.symbol,
    ts: toIsoFromEpochSeconds(c.time),
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
    v: typeof (c as any).volume === "number" ? (c as any).volume : null,
    source: args.source,
  }));

  if (rows.length === 0) return;

  const { error } = await args.supabase.from(table).upsert(rows, { onConflict: "symbol,ts" });
  if (error) throw error;
}

// --- NY session helpers for previous regular-session close ---
const NY_TZ = "America/New_York";

function nyParts(ms: number): { y: number; m: number; d: number; hh: number; mm: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = dtf.formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");

  return {
    y: get("year"),
    m: get("month"),
    d: get("day"),
    hh: get("hour"),
    mm: get("minute"),
  };
}

function isSameNyDate(aMs: number, bMs: number): boolean {
  const a = nyParts(aMs);
  const b = nyParts(bMs);
  return a.y === b.y && a.m === b.m && a.d === b.d;
}

function findPrevRegularClose(series: Candle[]): number | null {
  if (!series || series.length < 2) return null;

  // Assume Candle.time is epoch seconds.
  const msLast = series[series.length - 1].time * 1000;

  // Find the first candle on the latest NY trading date at or after 09:30.
  let firstSessionIdx = -1;
  for (let i = 0; i < series.length; i++) {
    const ms = series[i].time * 1000;
    if (!isSameNyDate(ms, msLast)) continue;
    const p = nyParts(ms);
    if (p.hh > 9 || (p.hh === 9 && p.mm >= 30)) {
      firstSessionIdx = i;
      break;
    }
  }

  if (firstSessionIdx <= 0) {
    // If we can't find a session boundary in the returned window, fall back to the earliest candle close.
    return series[0]?.close ?? null;
  }

  // Previous regular-session close is the candle immediately before the first session candle.
  const prev = series[firstSessionIdx - 1];
  return prev?.close ?? null;
}

function clipToNyRegularSessionAndRebuild(candles: Candle[]): Candle[] {
  if (!candles || candles.length === 0) return [];

  const msLast = candles[candles.length - 1].time * 1000;

  // Keep only candles on the last NY trading date and at/after 09:30 NY.
  const kept = candles.filter((c) => {
    const ms = c.time * 1000;
    if (!isSameNyDate(ms, msLast)) return false;
    const p = nyParts(ms);
    return p.hh > 9 || (p.hh === 9 && p.mm >= 30);
  });

  if (kept.length === 0) return [];

  // Rebuild open/high/low so the first candle doesn't "open" from a clipped-away prior close.
  const rebuilt: Candle[] = [];
  for (let i = 0; i < kept.length; i++) {
    const close = kept[i].close;
    const open = i === 0 ? close : rebuilt[i - 1].close;
    rebuilt.push({
      time: kept[i].time,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
    });
  }
  return rebuilt;
}

// Simple in-memory TTL cache to prevent refetch storms (dev-safe, per server instance)
// Keyed by symbol+range+resolution.
// NOTE: This is intentionally minimal; replace with Redis/upstash if you later need multi-instance coherence.

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
  if (m.includes("current limit") || m.includes("current minute") || m.includes("per minute") || m.includes("too many requests")) {
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

function durationSecondsForRange(range: string): number {
  switch (range) {
    case "1D":
      return 24 * 60 * 60;
    case "5D":
      return 5 * 24 * 60 * 60;
    case "1M":
      return 30 * 24 * 60 * 60;
    case "3M":
      return 90 * 24 * 60 * 60;
    case "6M":
      return 180 * 24 * 60 * 60;
    default:
      return 24 * 60 * 60;
  }
}

function stepSecondsForResolution(resolution: string): number {
  switch (resolution) {
    case "1m":
      return 60;
    case "5m":
      return 5 * 60;
    case "15m":
      return 15 * 60;
    case "1h":
      return 60 * 60;
    case "4h":
      return 4 * 60 * 60;
    case "1d":
      return 24 * 60 * 60;
    default:
      return 5 * 60;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const target = searchParams.get("target") ?? "SYMBOL";
  const symbol = searchParams.get("symbol") ?? null;
  const range = searchParams.get("range") ?? "1D";
  const resolution = searchParams.get("resolution") ?? "5m";
  const scheduler = qpBool(searchParams.get("scheduler"));
  const cacheOnly = qpBool(searchParams.get("cacheOnly"));

  const marketSource = (process.env.MARKET_SOURCE ?? "stub").toLowerCase();

  // Belt & suspenders: require explicit opt-in before calling external providers.
  // This prevents accidental credit burn during development.
  const twelvedataEnabled = (process.env.TWELVEDATA_ENABLE ?? "false").toLowerCase() === "true";

  // Circuit breaker: if Twelve Data signals a hard limit (e.g. out of credits), stop calling it for a period.
  // Stored in-memory per server instance.
  const TWELVEDATA_BREAKER_KEY = "twelvedata:breaker";
  const breaker = cacheGet<{ until: number; reason: string }>(TWELVEDATA_BREAKER_KEY);
  const breakerActive = breaker ? Date.now() < breaker.until : false;

  const supabase = getAdmin();

  // --- WATCHLIST COMPOSITE (symbols from DB, candles from provider) ---
  if (target === "WATCHLIST_COMPOSITE") {
    const watchlistKey = searchParams.get("watchlistKey");
    const ownerUserId = searchParams.get("ownerUserId");

    if (!watchlistKey || !ownerUserId) {
      return NextResponse.json({ candles: [], visibleCount: 0 });
    }

    const { data: wl } = await supabase
      .from("watchlists")
      .select("id")
      .eq("owner_user_id", ownerUserId)
      .eq("key", watchlistKey)
      .limit(1);

    const watchlistId = wl?.[0]?.id;
    if (!watchlistId) {
      return NextResponse.json({ candles: [], visibleCount: 0 });
    }

    const { data: rows } = await supabase
      .from("watchlist_symbols")
      .select("symbol, sort_order")
      .eq("watchlist_id", watchlistId)
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .order("symbol", { ascending: true });

    const symbols = (rows ?? [])
      .slice()
      .sort((a: any, b: any) => {
        const ao = a?.sort_order ?? 0;
        const bo = b?.sort_order ?? 0;
        if (ao !== bo) return ao - bo;
        const as = String(a?.symbol ?? "");
        const bs = String(b?.symbol ?? "");
        return as.localeCompare(bs);
      })
      .map((r: any) => r.symbol);
    if (symbols.length === 0) {
      return NextResponse.json({ candles: [], visibleCount: 0 });
    }

    const durationSeconds = durationSecondsForRange(range);
    const stepSeconds = stepSecondsForResolution(resolution);
    const visibleCount = Math.ceil(durationSeconds / stepSeconds);

    // Cache-driven by default:
    // - If cached, always serve cache.
    // - If not cached and NOT scheduler, do not call external providers (prevents load-time storms).
    // - Scheduler requests (scheduler=1) are allowed to populate the cache on the defined cadence.
    const compositeCacheKey = `td:wl:${ownerUserId}:${watchlistKey}:${symbols.join(",")}:${range}:${resolution}`;
    const cachedComposite = cacheGet<any>(compositeCacheKey);
    if (cachedComposite) return NextResponse.json(cachedComposite);

    const allowWarm = scheduler || watchlistKey === "SENTINEL";

    if (!allowWarm) {
      // If the scheduler is currently warming this key, wait for it so the UI can render immediately
      // on first session without triggering external calls.
      const inflight = INFLIGHT.get(compositeCacheKey);
      if (inflight) {
        try {
          const v = await inflight;
          return NextResponse.json(v);
        } catch {
          // fall through to CACHE_MISS
        }
      }

      return NextResponse.json(
        {
          ok: false,
          error: "CACHE_MISS",
          target: "WATCHLIST_COMPOSITE",
          watchlistKey,
          ownerUserId,
          range,
          resolution,
          message:
            "Cache miss. This endpoint is cache-driven by default to prevent watchlist storms. Populate cache via the scheduler (add ?scheduler=1) and retry.",
          retryAfterMs: 60_000,
        },
        { status: 202 }
      );
    }

    // De-dupe concurrent scheduler warms for the same key
    const inflight = INFLIGHT.get(compositeCacheKey);
    if (inflight) {
      try {
        const v = await inflight;
        return NextResponse.json(v);
      } catch {
        // fall through and attempt fresh
      }
    }

    const work = (async () => {
      // 1) Get per-symbol series (real or stub)
      let seriesBySymbol: Record<string, Candle[]> = {};

      if (marketSource === "twelvedata" && twelvedataEnabled && !breakerActive) {
        try {
          const map = await fetchTwelveDataTimeSeries({
            symbols,
            resolution,
            range,
            outputsizeExtraLookback: 220,
          });
          seriesBySymbol = map as any;
          // Persist only durable resolutions (1h/4h/1d). Never persist intraday (30m/5m/1m/15m).
          const persistTable = durableTableForResolution(resolution);
          if (persistTable) {
            void Promise.allSettled(
              symbols.map(async (sym) => {
                const series = (seriesBySymbol[sym] ?? []) as any;
                try {
                  await persistDurableCandles({
                    supabase,
                    symbol: sym,
                    resolution,
                    candles: series,
                    source: "twelvedata",
                    ownerUserId: ownerUserId ?? null,
                  });
                } catch (e) {
                  console.error(`[candles][persist][watchlist] ${sym} ${resolution} failed`, e);
                }
              })
            );
          }
        } catch (err: any) {
          const message = err?.message ?? String(err);
          // Trip breaker on provider hard limits / rate limits to prevent repeated burn.
          if (typeof message === "string") {
            const until = computeTwelveDataBreakerUntil(message);
            cacheSet(TWELVEDATA_BREAKER_KEY, { until, reason: message }, Math.max(1_000, until - Date.now()));
          }

          // fall back to stub
          for (const sym of symbols) {
            seriesBySymbol[sym] = generateStubCandles({ symbol: sym, resolution, range }) as any;
          }
        }
      } else {
        for (const sym of symbols) {
          seriesBySymbol[sym] = generateStubCandles({ symbol: sym, resolution, range }) as any;
        }
      }

      // 2) Composite + constituents meta
      const length = Math.min(...Object.values(seriesBySymbol).map((s) => s.length));
      const composite: Candle[] = [];

      const constituents: Record<
        string,
        { pctChange: number; sparkline1d: number[]; prevClose: number | null; prevCloseDate: string | null }
      > = {};

      // Prefer normalized EOD close as the baseline for "day %" (prev close → now).
      // Fallback to inferred previous-regular-session close from the returned candle window when EOD is missing.
      const { data: eodRows } = await supabase
        .from("symbol_eod")
        .select("symbol, trade_date, close")
        .in("symbol", symbols)
        .order("trade_date", { ascending: false });

      const eodBySymbol: Record<string, { close: number; trade_date: string }> = {};
      for (const r of eodRows ?? []) {
        const sym = String((r as any).symbol ?? "").toUpperCase();
        if (!sym) continue;
        // Because rows are ordered by trade_date desc, first seen per symbol is the latest.
        if (!eodBySymbol[sym]) {
          eodBySymbol[sym] = { close: Number((r as any).close), trade_date: String((r as any).trade_date) };
        }
      }

      for (const symRaw of symbols) {
        const sym = String(symRaw ?? "").toUpperCase();
        const s = seriesBySymbol[symRaw] ?? [];
        const sparkline1d = s.map((c) => c.close);

        const eod = eodBySymbol[sym] ?? null;
        const inferredPrev = findPrevRegularClose(s as any);
        const prevClose = eod?.close ?? inferredPrev ?? null;
        const prevCloseDate = eod?.trade_date ?? null;
        const lastClose = s.length > 0 ? s[s.length - 1].close : null;

        if (prevClose && prevClose > 0 && lastClose != null) {
          const pct = ((lastClose / prevClose) - 1) * 100;
          constituents[symRaw] = { pctChange: pct, sparkline1d, prevClose, prevCloseDate };
        } else {
          constituents[symRaw] = { pctChange: 0, sparkline1d, prevClose, prevCloseDate };
        }
      }

      // --- Composite baseline: previous close (EOD preferred, fallback inference) ---
      const baselineBySymbol: Record<string, number> = {};
      for (const symRaw of symbols) {
        const m = constituents[symRaw];
        const s = seriesBySymbol[symRaw] ?? [];
        const fallback = s[0]?.close ?? 1;
        const base = typeof m?.prevClose === "number" && m.prevClose > 0 ? m.prevClose : fallback;
        baselineBySymbol[symRaw] = base > 0 ? base : 1;
      }

      for (let i = 0; i < length; i++) {
        let acc = 0;
        for (const sym of symbols) {
          const s = seriesBySymbol[sym];
          const base = baselineBySymbol[sym] ?? (s[0]?.close ?? 1);
          acc += s[i].close / (base > 0 ? base : 1);
        }
        const value = 100 * (acc / symbols.length);

        const prevClose = i === 0 ? value : composite[i - 1].close;
        composite.push({
          time: seriesBySymbol[symbols[0]][i].time,
          open: prevClose,
          high: Math.max(prevClose, value),
          low: Math.min(prevClose, value),
          close: value,
        });
      }

      const compositeSession = clipToNyRegularSessionAndRebuild(composite);

      const payload = {
        candles: compositeSession,
        visibleCount: compositeSession.length,
        meta: { constituents, source: marketSource },
      };

      // Cache longer than the watchlist warm cadence so reloads and scheduled reads can consistently hit.
      // Symbols can remain short-lived elsewhere; composites are intentionally durable.
      cacheSet(compositeCacheKey, payload, 600_000);
      return payload;
    })();

    INFLIGHT.set(compositeCacheKey, work);
    try {
      const v = await work;
      return NextResponse.json(v);
    } finally {
      INFLIGHT.delete(compositeCacheKey);
    }
  }

  // --- SINGLE SYMBOL / INDEX ---
  const durationSeconds = durationSecondsForRange(range);
  const stepSeconds = stepSecondsForResolution(resolution);
  const visibleCount = Math.ceil(durationSeconds / stepSeconds);

  // indicator lookback so SMA200 can be computed across the visible window
  const lookback = 220;
  const candleCount = visibleCount + lookback;
  void candleCount; // kept for parity (if you later want server-side indicator generation)

  const requestSymbol = symbol && symbol !== "EMPTY" ? symbol : null;

  if (!requestSymbol) {
    return NextResponse.json(
      {
        ok: false,
        error: "MISSING_SYMBOL",
        message: "No symbol provided for SYMBOL target.",
      },
      { status: 400 }
    );
  }

  if (marketSource === "twelvedata" && (!twelvedataEnabled || breakerActive)) {
    // Provide a clear signal to the client instead of silently serving stub.
    if (!twelvedataEnabled) {
      return NextResponse.json(
        {
          ok: false,
          error: "TWELVEDATA_DISABLED",
          message: "Twelve Data is disabled. Set TWELVEDATA_ENABLE=true to allow external market data calls.",
        },
        { status: 429 }
      );
    }

    const retryAfterMs = Math.max(1_000, (breaker?.until ?? Date.now() + 60_000) - Date.now());
    return NextResponse.json(
      {
        ok: false,
        error: "TWELVEDATA_CIRCUIT_BREAKER_ACTIVE",
        message: `Twelve Data calls are temporarily disabled due to a prior provider hard-limit. Reason: ${breaker?.reason ?? "unknown"}`,
        retryAfterMs,
      },
      { status: 202 }
    );
  }

    if (marketSource === "twelvedata" && twelvedataEnabled && !breakerActive) {
      const cacheKey = `td:symbol:${requestSymbol}:${range}:${resolution}`;

      if (cacheOnly) {
        const cached = cacheGet<any>(cacheKey);
        if (cached) return NextResponse.json(cached);

        return NextResponse.json(
          {
            ok: false,
            error: "CACHE_MISS",
            target: "SYMBOL",
            requestSymbol,
            range,
            resolution,
            message: "Cache-only read requested. Scheduler must warm this symbol.",
            retryAfterMs: 60_000,
          },
          { status: 202 }
        );
      }

      const cached = cacheGet<any>(cacheKey);
      if (cached) return NextResponse.json(cached);

      // Allow non-cacheOnly requests to fetch on-demand, regardless of scheduler flag.
      const inflight = INFLIGHT.get(cacheKey);
      if (inflight) {
        try {
          const v = await inflight;
          return NextResponse.json(v);
        } catch {
          // fall through
        }
      }

      const work = (async () => {
        try {
          const map = await fetchTwelveDataTimeSeries({
            symbols: [requestSymbol],
            resolution,
            range,
            outputsizeExtraLookback: 220,
          });

          const candles = (map[requestSymbol] ?? []) as any;
          try {
            await persistDurableCandles({
              supabase,
              symbol: requestSymbol,
              resolution,
              candles,
              source: "twelvedata",
            });
          } catch (e) {
            console.error(`[candles][persist][symbol] ${requestSymbol} ${resolution} failed`, e);
          }

          const payload = {
            target: symbol ? `${target}:${symbol}` : target,
            range,
            resolution,
            candles,
            visibleCount,
            source: "twelvedata",
          };

          // 30s cache prevents rapid refetch storms that can trigger Twelve Data credit/rate-limit errors.
          cacheSet(cacheKey, payload, 30_000);
          return payload;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          if (typeof message === "string") {
            const until = computeTwelveDataBreakerUntil(message);
            cacheSet(TWELVEDATA_BREAKER_KEY, { until, reason: message }, Math.max(1_000, until - Date.now()));
          }
          // Do not silently fall back to stub; it masks provider failures as "bad prices".
          throw Object.assign(new Error(message), { __tp_provider_error: true });
        }
      })();

      INFLIGHT.set(cacheKey, work);
      try {
        const v = await work;
        return NextResponse.json(v);
      } catch (err: any) {
        const message = err?.message ?? String(err);
        return NextResponse.json(
          {
            ok: false,
            error: "TWELVEDATA_SINGLE_SYMBOL_FAILED",
            requestSymbol,
            range,
            resolution,
            message,
          },
          { status: 502 }
        );
      } finally {
        INFLIGHT.delete(cacheKey);
      }
    }

  const candles = generateStubCandles({
    symbol: requestSymbol,
    resolution,
    range,
  });

  return NextResponse.json({
    target: symbol ? `${target}:${symbol}` : target,
    range,
    resolution,
    candles,
    visibleCount,
    source: "stub",
  });
}