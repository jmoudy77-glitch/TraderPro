// app/api/market/candles/window/route.ts
import { NextRequest, NextResponse } from "next/server";

import { getWatchlistSymbols } from "@/app/actions/holdings";

import type { CanonicalCandle, CanonicalMeta, Session, TargetKind } from "@/lib/market-data/candles/types";
import {
  computeWindow,
  isDurableRes,
  normalizeRange,
  normalizeRangeResPair,
  normalizeRes,
} from "@/lib/market-data/candles/window";
import { fetchAlpacaCandlesSymbol } from "@/lib/market-data/candles/fetchAlpacaBars";

/**
 * /api/market/candles/window
 *
 * Canonical historical candles endpoint.
 *
 * Source priority:
 * - Durable resolutions (>= 1h): delegate to existing DB-backed pipeline via `/api/market/candles`.
 * - Intraday resolutions (< 1h): primary = realtime-ws candle cache; fallback/backfill = Alpaca REST.
 *
 * IMPORTANT: This route is designed to work with the current system during transition,
 * without requiring downstream refactors.
 */

export const runtime = "nodejs";
const INCLUDE_REST_DIAGNOSTICS = process.env.NODE_ENV !== "production";

function jsonOk(payload: any, status = 200) {
  return NextResponse.json(payload, { status });
}

function jsonErr(code: string, message: string, status = 400, extra?: any) {
  return NextResponse.json(
    { ok: false, code, error: message, ...(extra ?? {}) },
    { status }
  );
}

function parseTarget(s: string | null): TargetKind | null {
  if (!s) return null;
  const v = s.toUpperCase();
  if (v === "SYMBOL") return "SYMBOL";
  if (v === "WATCHLIST_COMPOSITE") return "WATCHLIST_COMPOSITE";
  return null;
}

function parseSession(s: string | null): Session {
  if (!s) return "regular";
  const v = s.toLowerCase();
  if (v === "regular" || v === "extended" || v === "auto") return v as Session;
  return "regular";
}



function normalizeCandleArray(input: any): CanonicalCandle[] {
  if (!Array.isArray(input)) return [];

  const out: CanonicalCandle[] = [];
  for (const c of input) {
    if (!c || typeof c !== "object") continue;

    // Accept either canonical {time,open,high,low,close,volume}
    // or ws shorthand {ts,o,h,l,c,v}
    let time = (c.time ?? c.ts) as any;
    const open = (c.open ?? c.o) as any;
    const high = (c.high ?? c.h) as any;
    const low = (c.low ?? c.l) as any;
    const close = (c.close ?? c.c) as any;
    const volume = (c.volume ?? c.v) as any;

    if (
      typeof time !== "number" ||
      typeof open !== "number" ||
      typeof high !== "number" ||
      typeof low !== "number" ||
      typeof close !== "number" ||
      typeof volume !== "number"
    ) {
      continue;
    }

    // Normalize time to epoch ms (durable route currently returns seconds)
    if (time > 0 && time < 20_000_000_000) {
      // looks like seconds
      time = time * 1000;
    }

    out.push({ time, open, high, low, close, volume });
  }

  // Ensure ascending sort by time
  out.sort((a, b) => a.time - b.time);
  return out;
}

function buildCompositeCandlesFromCanonical(args: {
  candlesBySymbol: Record<string, CanonicalCandle[]>;
}): { candles: CanonicalCandle[]; meta: { constituents: Record<string, { base: number; bars: number }> } } {
  const symbols = Object.keys(args.candlesBySymbol);
  if (symbols.length === 0) return { candles: [], meta: { constituents: {} } };

  // Build union timestamp index.
  const byTs: Record<number, Record<string, CanonicalCandle>> = {};
  const tsSet = new Set<number>();

  for (const sym of symbols) {
    const bars = args.candlesBySymbol[sym] ?? [];
    for (const b of bars) {
      tsSet.add(b.time);
      if (!byTs[b.time]) byTs[b.time] = {};
      byTs[b.time][sym] = b;
    }
  }

  const timestamps = Array.from(tsSet).sort((a, b) => a - b);

  // Per-symbol normalization factor: first bar open (fallback to close).
  const baseBySymbol: Record<string, number> = {};
  for (const sym of symbols) {
    const bars = args.candlesBySymbol[sym] ?? [];
    const first = bars[0];
    const base = first ? (Number.isFinite(first.open) ? first.open : first.close) : NaN;
    if (Number.isFinite(base) && base > 0) baseBySymbol[sym] = base;
  }

  const constituents: Record<string, { base: number; bars: number }> = {};
  for (const sym of symbols) {
    const base = baseBySymbol[sym];
    if (Number.isFinite(base) && base > 0) {
      constituents[sym] = { base, bars: (args.candlesBySymbol[sym] ?? []).length };
    }
  }

  const out: CanonicalCandle[] = [];

  for (const t of timestamps) {
    const row = byTs[t] ?? {};
    let n = 0;
    let o = 0;
    let h = 0;
    let l = 0;
    let c = 0;
    let v = 0;

    for (const sym of symbols) {
      const b = row[sym];
      const base = baseBySymbol[sym];
      if (!b || !Number.isFinite(base) || base <= 0) continue;

      // Normalize to base=100.
      const no = (b.open / base) * 100;
      const nh = (b.high / base) * 100;
      const nl = (b.low / base) * 100;
      const nc = (b.close / base) * 100;

      if (!Number.isFinite(no) || !Number.isFinite(nh) || !Number.isFinite(nl) || !Number.isFinite(nc)) continue;

      o += no;
      h += nh;
      l += nl;
      c += nc;
      v += Number.isFinite(b.volume) ? b.volume : 0;
      n += 1;
    }

    if (n === 0) continue;

    out.push({
      time: t,
      open: o / n,
      high: h / n,
      low: l / n,
      close: c / n,
      volume: v,
    });
  }

  return { candles: out, meta: { constituents } };
}

function getRealtimeWsOrigin(fallbackOrigin: string): string {
  const raw =
    process.env.REALTIME_WS_ORIGIN ||
    process.env.NEXT_PUBLIC_REALTIME_WS_ORIGIN ||
    "";

  const v = String(raw).trim();
  if (!v) return fallbackOrigin;

  // Allow either full origin (http(s)://host) or bare host (host).
  if (v.startsWith("http://") || v.startsWith("https://")) return v;

  // Dev ergonomics: default to http for localhost/private dev hosts when scheme omitted.
  const lower = v.toLowerCase();
  const isLocal =
    lower.startsWith("localhost") ||
    lower.startsWith("127.") ||
    lower.startsWith("0.0.0.0") ||
    lower.endsWith(".local");

  return `${isLocal ? "http" : "https"}://${v}`;
}

function buildKey(parts: Record<string, string | undefined | null>) {
  return Object.entries(parts)
    .filter(([, v]) => v != null && String(v).length > 0)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("&");
}

async function fetchJson(url: URL, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    // Avoid caching at the edge for this phase; live-ish data.
    cache: "no-store",
    headers: {
      ...(init?.headers ?? {}),
      "content-type": "application/json",
    },
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, rawText: text };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}


function undersupplied(received: number, expected: number | null) {
  if (!expected || expected <= 0) return false;
  return received < expected * 0.6;
}

function computeWindowSkewMs(canonStartISO: string | null | undefined, wsStartISO: string | null | undefined) {
  if (!canonStartISO || !wsStartISO) return null;
  const a = Date.parse(canonStartISO);
  const b = Date.parse(wsStartISO);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(a - b);
}

function extractWsSessionStartISO(wsMeta: any): string | null {
  const v = wsMeta?.window?.session_start_ts;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function toAlpacaTimeframe(res: string): string | null {
  // Alpaca v2 bars timeframe tokens
  if (res === "1m") return "1Min";
  if (res === "5m") return "5Min";
  if (res === "15m") return "15Min";
  if (res === "30m") return "30Min";
  if (res === "1h") return "1Hour";
  if (res === "4h") return "4Hour";
  if (res === "1d") return "1Day";
  return null;
}



export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const target = parseTarget(searchParams.get("target"));
  const symbol = (searchParams.get("symbol") || "").trim().toUpperCase();
  const watchlistKey = (searchParams.get("watchlistKey") || "").trim();
  const ownerUserId = (searchParams.get("ownerUserId") || "").trim();
  const rangeRaw = normalizeRange(searchParams.get("range"));
  const range = (rangeRaw || "").trim();
  const res = normalizeRes(searchParams.get("res") || searchParams.get("resolution"));
  const session = parseSession(searchParams.get("session"));

  if (!target) return jsonErr("BAD_REQUEST", "Missing/invalid target (SYMBOL|WATCHLIST_COMPOSITE).");
  if (!range) return jsonErr("BAD_REQUEST", "Missing range.");
  if (!res) return jsonErr("BAD_REQUEST", "Missing res (resolution).");

  if (target === "SYMBOL") {
    if (!symbol) return jsonErr("BAD_REQUEST", "Missing symbol for target=SYMBOL.");
  } else {
    if (!watchlistKey)
      return jsonErr(
        "BAD_REQUEST",
        "Missing watchlistKey for target=WATCHLIST_COMPOSITE."
      );
    if (!ownerUserId)
      return jsonErr(
        "BAD_REQUEST",
        "Missing ownerUserId for target=WATCHLIST_COMPOSITE."
      );
  }

  // Enforce canonical range↔resolution compatibility (server-side auto-bump)
  const normalizedPair = range && res ? normalizeRangeResPair(range, res) : null;
  const effectiveRange = normalizedPair?.range ?? range;
  const effectiveRes = normalizedPair?.res ?? res;
  const normalizedFrom = normalizedPair?.normalizedFrom;

  // Canonical window bounds + expected bar count (session-aware for 1D).
  const windowSession: "regular" | "extended" = session === "extended" ? "extended" : "regular";
  const computedWindow = computeWindow({
    range: effectiveRange,
    res: effectiveRes,
    session: windowSession,
  });

  const expectedBars = computedWindow.expectedBars;

  // Base URL for same-origin calls (works in Vercel + local)
  const origin = new URL(req.url).origin;

  // --- Durable path (>= 1h) --------------------------------------------------
  // Delegate to the existing durable DB-backed pipeline. This preserves the current
  // "persist on close" behavior without refactoring yet.
  if (isDurableRes(effectiveRes)) {
    if (target !== "SYMBOL") {
      // If you later want durable composites, define it explicitly rather than silently degrading.
      return jsonErr(
        "NOT_IMPLEMENTED",
        "Durable WATCHLIST_COMPOSITE is not implemented yet. Use intraday resolutions for composites for now.",
        501,
        { target, res: effectiveRes, range: effectiveRange, ...(normalizedFrom ? { normalizedFrom } : {}) }
      );
    }

    const url = new URL("/api/market/candles", origin);
    url.searchParams.set("target", "SYMBOL");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("range", effectiveRange);
    url.searchParams.set("resolution", effectiveRes);

    const durable = await fetchJson(url);
    if (!durable.ok || !durable.json) {
      return jsonErr(
        "UPSTREAM_ERROR",
        "Failed to fetch durable candles from /api/market/candles.",
        502,
        { upstreamStatus: durable.status }
      );
    }
    if (durable.json.ok === false) return jsonOk(durable.json, 200);

    const candles = normalizeCandleArray(durable.json.candles);
    const meta: CanonicalMeta = {
      ...(durable.json.meta ?? {}),
      source: durable.json.source ?? "durable_db",
      expectedBars: expectedBars ?? undefined,
      receivedBars: candles.length,
      session,
      res: effectiveRes,
      range: effectiveRange,
      ...(normalizedFrom ? { normalizedFrom } : {}),
    };

    return jsonOk({
      ok: true,
      target,
      symbol,
      range: effectiveRange,
      res: effectiveRes,
      session,
      candles,
      meta,
    });
  }

  // --- Intraday path (< 1h) --------------------------------------------------
  // Priority:
  // 1) realtime-ws candle cache (via existing proxy route)
  // 2) Alpaca REST fallback/backfill (via existing after-hours route)
  //
  // Note: composites currently only exist via after-hours route in the current system,
  // so they go directly to after-hours for now.

  if (target === "WATCHLIST_COMPOSITE") {
    // Durable change: composites are built from constituent SYMBOL candles using the same
    // canonical intraday source priority (WS primary + REST backfill).
    let symbols: string[] = [];
    try {
      symbols = await getWatchlistSymbols(ownerUserId, watchlistKey);
    } catch (e: any) {
      return jsonErr(
        "WATCHLIST_SYMBOLS_FAILED",
        e?.message ?? "Failed to load watchlist symbols.",
        500
      );
    }

    const uniq = Array.from(
      new Set(
        (symbols ?? [])
          .map((s) => String(s ?? "").trim().toUpperCase())
          .filter(Boolean)
      )
    );

    if (uniq.length === 0) {
      const meta: CanonicalMeta = {
        expectedBars: expectedBars ?? undefined,
        receivedBars: 0,
        session,
        res: effectiveRes,
        range: effectiveRange,
        source: "composite",
        fallbackUsed: false,
        constituents: {},
        window: { start: computedWindow.startISO, end: computedWindow.endISO },
        ...(normalizedFrom ? { normalizedFrom } : {}),
      };

      return jsonOk({
        ok: true,
        target,
        watchlistKey,
        ownerUserId,
        range: effectiveRange,
        res: effectiveRes,
        session,
        candles: [],
        meta,
      });
    }

    // Fetch constituent candles via this same route’s SYMBOL intraday logic (WS primary + REST backfill).
    // To avoid explosive fanout, cap to a sane maximum (durability guard).
    const MAX_CONSTITUENTS = 60;
    const picked = uniq.slice(0, MAX_CONSTITUENTS);

    const candlesBySymbol: Record<string, CanonicalCandle[]> = {};
    const sourceBySymbol: Record<string, string> = {};
    const fallbackBySymbol: Record<string, { used: boolean; reason?: string }> = {};

    // Inline helper to fetch intraday candles for a symbol (mirrors the SYMBOL intraday path below).
    async function fetchSymbolIntraday(sym: string) {
      const wsOrigin = getRealtimeWsOrigin(origin);
      const wsUrl = new URL("/api/realtime/candles/intraday", wsOrigin);
      wsUrl.searchParams.set("symbol", sym);
      wsUrl.searchParams.set("resolution", effectiveRes);
      wsUrl.searchParams.set("range", effectiveRange);
      wsUrl.searchParams.set("session", session);
      const wsLimit = expectedBars ? clamp(expectedBars, 1, 5000) : 500;
      wsUrl.searchParams.set("limit", String(wsLimit));

      const ws = await fetchJson(wsUrl);

      let wsCandles: CanonicalCandle[] = [];
      let wsMeta: any = null;
      let wsUpstreamError: any = null;

      if (!ws.ok) {
        wsUpstreamError = {
          status: ws.status,
          body: typeof ws.rawText === "string" ? ws.rawText.slice(0, 500) : null,
        };
      }

      if (ws.ok && ws.json) {
        if (ws.json.ok === false) {
          wsUpstreamError = ws.json.error ?? ws.json;
        } else {
          wsCandles = normalizeCandleArray(ws.json.candles);
          wsMeta = ws.json.meta ?? null;
        }
      }

      const wsTotalCount = typeof wsMeta?.total_count === "number" ? wsMeta.total_count : null;
      const wsReturnedCount = typeof wsMeta?.returned_count === "number" ? wsMeta.returned_count : null;

      const wsUndersupplied = undersupplied(wsCandles.length, expectedBars);

      const wsSessionStartISO = extractWsSessionStartISO(wsMeta);
      const wsWindowSkewMs = computeWindowSkewMs(computedWindow.startISO, wsSessionStartISO);
      const wsWindowMismatch = typeof wsWindowSkewMs === "number" && wsWindowSkewMs > 60_000;
      if (wsWindowMismatch) {
        wsUpstreamError = {
          code: "WS_WINDOW_MISMATCH",
          canonWindowStart: computedWindow.startISO,
          wsWindowStart: wsSessionStartISO,
          wsWindowSkewMs,
        };
      }

      // WS viability is WINDOW-AWARE: being "fully returned" only means "we got all cached bars",
      // not that the cache satisfies the canonical expected window.
      const wsViable = wsCandles.length > 0 && !wsUndersupplied && !wsWindowMismatch;

      if (wsViable) {
        return {
          candles: wsCandles,
          source: (wsMeta?.source as string) ?? "realtime_ws",
          fallbackUsed: false,
          fallbackReason: undefined as string | undefined,
          wsError: undefined,
        };
      }
      const tf = toAlpacaTimeframe(effectiveRes);
      if (!tf) {
        // If resolution cannot be mapped to Alpaca timeframe, treat as REST failure.
        if (wsCandles.length > 0) {
          return {
            candles: wsCandles,
            source: (wsMeta?.source as string) ?? "realtime_ws",
            fallbackUsed: true,
            fallbackReason: "REST_FALLBACK_FAILED",
            wsError: wsUpstreamError ?? undefined,
            ...(INCLUDE_REST_DIAGNOSTICS
              ? {
                  restError: { status: undefined, error: undefined },
                  restRequest: {
                    symbol: sym,
                    timeframe: tf,
                    startISO: computedWindow.startISO,
                    endISO: computedWindow.endISO,
                  },
                }
              : {}),
          };
        }

        return {
          candles: [],
          source: "none",
          fallbackUsed: true,
          fallbackReason: "NO_DATA",
          wsError: wsUpstreamError ?? undefined,
          ...(INCLUDE_REST_DIAGNOSTICS
            ? {
                restError: { status: undefined, error: undefined },
                restRequest: {
                  symbol: sym,
                  timeframe: tf,
                  startISO: computedWindow.startISO,
                  endISO: computedWindow.endISO,
                },
              }
            : {}),
        };
      }

      const alpaca = await fetchAlpacaCandlesSymbol({
        symbol: sym,
        timeframe: tf,
        startISO: computedWindow.startISO,
        endISO: computedWindow.endISO,
      });

      if (alpaca.ok) {
        const restCandles = alpaca.candles as unknown as CanonicalCandle[];
        return {
          candles: restCandles,
          source: "alpaca_rest",
          fallbackUsed: true,
          fallbackReason: wsUpstreamError
            ? "WS_ERROR"
            : wsCandles.length === 0
            ? "WS_EMPTY"
            : "WS_UNDERSUPPLIED",
          wsError: wsUpstreamError ?? undefined,
        };
      }

      // If REST fails but WS has something, return WS with an explicit fallback marker.
      if (wsCandles.length > 0) {
        return {
          candles: wsCandles,
          source: (wsMeta?.source as string) ?? "realtime_ws",
          fallbackUsed: true,
          fallbackReason: "REST_FALLBACK_FAILED",
          wsError: wsUpstreamError ?? undefined,
          ...(INCLUDE_REST_DIAGNOSTICS
            ? {
                restError: { status: alpaca.status, error: alpaca.error },
                restRequest: {
                  symbol: sym,
                  timeframe: tf,
                  startISO: computedWindow.startISO,
                  endISO: computedWindow.endISO,
                },
              }
            : {}),
        };
      }

      return {
        candles: [],
        source: "none",
        fallbackUsed: true,
        fallbackReason: "NO_DATA",
        wsError: wsUpstreamError ?? undefined,
        ...(INCLUDE_REST_DIAGNOSTICS
          ? {
              restError: { status: alpaca.status, error: alpaca.error },
              restRequest: {
                symbol: sym,
                timeframe: tf,
                startISO: computedWindow.startISO,
                endISO: computedWindow.endISO,
              },
            }
          : {}),
      };
    }

    const results = await Promise.all(
      picked.map(async (sym) => {
        const r = await fetchSymbolIntraday(sym);
        return { sym, ...r };
      })
    );

    // Aggregate wsError/restError for each symbol
    const wsErrorBySymbol: Record<string, any> = {};
    const restErrorBySymbol: Record<string, any> = {};

    for (const r of results) {
      candlesBySymbol[r.sym] = r.candles;
      sourceBySymbol[r.sym] = r.source;
      fallbackBySymbol[r.sym] = { used: r.fallbackUsed, reason: r.fallbackReason };
      if (r.wsError) {
        wsErrorBySymbol[r.sym] = r.wsError;
      }
      if (INCLUDE_REST_DIAGNOSTICS && (r as any).restError) {
        restErrorBySymbol[r.sym] = {
          ...(r as any).restError,
          request: (r as any).restRequest,
        };
      }
    }

    const composite = buildCompositeCandlesFromCanonical({ candlesBySymbol });
    const candles = composite.candles;

    // Meta: composite is WS-primary, but may include REST backfill per constituent.
    const anyFallback = Object.values(fallbackBySymbol).some((v) => v?.used);
    const fallbackReason = anyFallback ? "CONSTITUENT_FALLBACK" : undefined;

    const meta: CanonicalMeta = {
      expectedBars: expectedBars ?? undefined,
      receivedBars: candles.length,
      session,
      res: effectiveRes,
      range: effectiveRange,
      source: anyFallback ? "composite_mixed" : "composite_ws",
      fallbackUsed: anyFallback ? true : false,
      ...(fallbackReason ? { fallbackReason } : {}),
      constituents: composite.meta.constituents,
      sourcesBySymbol: sourceBySymbol,
      fallbackBySymbol: fallbackBySymbol,
      window: { start: computedWindow.startISO, end: computedWindow.endISO },
      ...(Object.keys(wsErrorBySymbol).length > 0
        ? { wsError: { bySymbol: wsErrorBySymbol } }
        : {}),
      ...(INCLUDE_REST_DIAGNOSTICS && Object.keys(restErrorBySymbol).length > 0
        ? { restError: { bySymbol: restErrorBySymbol } }
        : {}),
      ...(normalizedFrom ? { normalizedFrom } : {}),
    };

    return jsonOk({
      ok: true,
      target,
      watchlistKey,
      ownerUserId,
      range: effectiveRange,
      res: effectiveRes,
      session,
      candles,
      meta,
    });
  }

  // SYMBOL intraday: WS primary + REST fallback
  {
    // 1) WS primary (direct realtime-ws call)
    const wsOrigin = getRealtimeWsOrigin(origin);
    const wsUrl = new URL("/api/realtime/candles/intraday", wsOrigin);
    wsUrl.searchParams.set("symbol", symbol);
    wsUrl.searchParams.set("resolution", effectiveRes);
    wsUrl.searchParams.set("range", effectiveRange);
    wsUrl.searchParams.set("session", session);

    // realtime-ws supports `limit`; request enough bars to satisfy this window.
    // Cap to protect payload size while allowing 1D/1m extended (~960) and regular (~390).
    const wsLimit = expectedBars ? clamp(expectedBars, 1, 5000) : 500;
    wsUrl.searchParams.set("limit", String(wsLimit));

    const ws = await fetchJson(wsUrl);

    let wsCandles: CanonicalCandle[] = [];
    let wsMeta: any = null;
    let wsUpstreamError: any = null;

    if (!ws.ok) {
      wsUpstreamError = {
        status: ws.status,
        body: typeof ws.rawText === "string" ? ws.rawText.slice(0, 500) : null,
      };
    }

    if (ws.ok && ws.json) {
      // ws proxy normally returns {candles:[{ts,o,h,l,c,v}], meta:{...}} (no ok:true)
      // but it may also return HTTP 200 with { ok:false, error:{...} }.
      // For /candles/window, WS errors are NOT fatal; allow REST fallback.
      if (ws.json.ok === false) {
        wsUpstreamError = ws.json.error ?? ws.json;
      } else {
        wsCandles = normalizeCandleArray(ws.json.candles);
        wsMeta = ws.json.meta ?? null;
      }
    }

    const wsUndersupplied = undersupplied(wsCandles.length, expectedBars);

    const wsSessionStartISO = extractWsSessionStartISO(wsMeta);
    const wsWindowSkewMs = computeWindowSkewMs(computedWindow.startISO, wsSessionStartISO);
    const wsWindowMismatch = typeof wsWindowSkewMs === "number" && wsWindowSkewMs > 60_000;
    if (wsWindowMismatch) {
      wsUpstreamError = {
        code: "WS_WINDOW_MISMATCH",
        canonWindowStart: computedWindow.startISO,
        wsWindowStart: wsSessionStartISO,
        wsWindowSkewMs,
      };
    }

    if (!wsUndersupplied && !wsWindowMismatch && wsCandles.length > 0) {
      const meta: CanonicalMeta = {
        ...(wsMeta ?? {}),
        source: (wsMeta?.source as string) ?? "realtime_ws",
        expectedBars: expectedBars ?? undefined,
        receivedBars: wsCandles.length,
        session,
        res: effectiveRes,
        range: effectiveRange,
        fallbackUsed: false,
        window: { start: computedWindow.startISO, end: computedWindow.endISO },
        ...(normalizedFrom ? { normalizedFrom } : {}),
      };

      // Optional dev diagnostics (does not break prod)
      if (process.env.NODE_ENV !== "production" && expectedBars) {
        if (wsCandles.length < expectedBars * 0.6) {
          // eslint-disable-next-line no-console
          console.warn("[candles/window] undersupplied(ws)", {
            key: buildKey({ target, symbol, range: effectiveRange, res: effectiveRes, session }),
            expectedBars,
            receivedBars: wsCandles.length,
            cache_status: wsMeta?.cache_status,
            is_stale: wsMeta?.is_stale,
            last_update_ts: wsMeta?.last_update_ts,
          });
        }
      }

      return jsonOk({
        ok: true,
        target,
        symbol,
        range: effectiveRange,
        res: effectiveRes,
        session,
        candles: wsCandles,
        meta,
      });
    }

    // 2) REST fallback/backfill (direct Alpaca REST)
    const tf = toAlpacaTimeframe(effectiveRes);
    if (!tf) {
      // If WS gave *something*, prefer returning WS with an explicit marker rather than hard error.
      if (wsCandles.length > 0) {
        const meta: CanonicalMeta = {
          ...(wsMeta ?? {}),
          source: (wsMeta?.source as string) ?? "realtime_ws",
          expectedBars: expectedBars ?? undefined,
          receivedBars: wsCandles.length,
          session,
          res: effectiveRes,
          range: effectiveRange,
          fallbackUsed: true,
          fallbackReason: "REST_FALLBACK_FAILED",
          wsError: wsUpstreamError ?? undefined,
          window: { start: computedWindow.startISO, end: computedWindow.endISO },
          ...(INCLUDE_REST_DIAGNOSTICS
            ? {
                restRequest: {
                  symbol,
                  timeframe: null,
                  startISO: computedWindow.startISO,
                  endISO: computedWindow.endISO,
                },
              }
            : {}),
          ...(normalizedFrom ? { normalizedFrom } : {}),
        };
        return jsonOk({
          ok: true,
          target,
          symbol,
          range: effectiveRange,
          res: effectiveRes,
          session,
          candles: wsCandles,
          meta,
        });
      }

      return jsonErr(
        "UPSTREAM_ERROR",
        "Failed to fetch intraday candles from both realtime-ws and Alpaca REST.",
        502,
        {
          wsStatus: ws.status,
          wsError: wsUpstreamError,
          restStatus: 0,
          key: buildKey({ target, symbol, range: effectiveRange, res: effectiveRes, session }),
        }
      );
    }

    const alpaca = await fetchAlpacaCandlesSymbol({
      symbol,
      timeframe: tf,
      startISO: computedWindow.startISO,
      endISO: computedWindow.endISO,
    });

    if (!alpaca.ok) {
      // If WS gave *something*, prefer returning WS with staleness meta rather than hard error.
      if (wsCandles.length > 0) {
        const meta: CanonicalMeta = {
          ...(wsMeta ?? {}),
          source: (wsMeta?.source as string) ?? "realtime_ws",
          expectedBars: expectedBars ?? undefined,
          receivedBars: wsCandles.length,
          session,
          res: effectiveRes,
          range: effectiveRange,
          fallbackUsed: true,
          fallbackReason: "REST_FALLBACK_FAILED",
          wsError: wsUpstreamError ?? undefined,
          window: { start: computedWindow.startISO, end: computedWindow.endISO },
          ...(INCLUDE_REST_DIAGNOSTICS
            ? {
                restError: { status: alpaca.status, error: alpaca.error },
                restRequest: {
                  symbol,
                  timeframe: tf,
                  startISO: computedWindow.startISO,
                  endISO: computedWindow.endISO,
                },
              }
            : {}),
          ...(normalizedFrom ? { normalizedFrom } : {}),
        };
        return jsonOk({
          ok: true,
          target,
          symbol,
          range: effectiveRange,
          res: effectiveRes,
          session,
          candles: wsCandles,
          meta,
        });
      }

      return jsonErr(
        "UPSTREAM_ERROR",
        "Failed to fetch intraday candles from both realtime-ws and Alpaca REST.",
        502,
        {
          wsStatus: ws.status,
          wsError: wsUpstreamError,
          restStatus: alpaca.status,
          key: buildKey({ target, symbol, range: effectiveRange, res: effectiveRes, session }),
        }
      );
    }

    const restCandles = alpaca.candles as unknown as CanonicalCandle[];

    // WS viability rule (WINDOW-AWARE): WS is only viable if it is not materially undersupplied
    // versus the canonical expected window. "Fully returned" only means "all cached bars were returned",
    // and must not override undersupply or window mismatch.
    const wsIsViable = wsCandles.length > 0 && !wsUndersupplied && !wsWindowMismatch;

    const chosenCandles = wsIsViable ? wsCandles : restCandles;
    const chosenSource = wsIsViable
      ? ((wsMeta?.source as string) ?? "realtime_ws")
      : "alpaca_rest";
    const chosenMeta: any = wsIsViable ? (wsMeta ?? {}) : {};

    const fallbackUsed = !wsIsViable;
    const fallbackReason = fallbackUsed
      ? wsUpstreamError
        ? "WS_ERROR"
        : wsCandles.length === 0
        ? "WS_EMPTY"
        : "WS_UNDERSUPPLIED"
      : undefined;

    const meta: CanonicalMeta = {
      ...(chosenMeta ?? {}),
      source: chosenSource,
      expectedBars: expectedBars ?? undefined,
      receivedBars: chosenCandles.length,
      session,
      res: effectiveRes,
      range: effectiveRange,
      fallbackUsed,
      ...(fallbackReason ? { fallbackReason } : {}),
      wsError: wsUpstreamError ?? undefined,
      window: { start: computedWindow.startISO, end: computedWindow.endISO },
      ...(process.env.NODE_ENV !== "production" && (wsSessionStartISO || typeof wsWindowSkewMs === "number")
        ? {
            canonWindowStart: computedWindow.startISO,
            wsWindowStart: wsSessionStartISO ?? undefined,
            wsWindowSkewMs: typeof wsWindowSkewMs === "number" ? wsWindowSkewMs : undefined,
          }
        : {}),
      ...(normalizedFrom ? { normalizedFrom } : {}),
    };

    // Optional dev diagnostics
    if (process.env.NODE_ENV !== "production" && expectedBars) {
      if (chosenCandles.length < expectedBars * 0.6) {
        // eslint-disable-next-line no-console
        console.warn("[candles/window] undersupplied(chosen)", {
          key: buildKey({ target, symbol, range: effectiveRange, res: effectiveRes, session }),
          expectedBars,
          receivedBars: chosenCandles.length,
          chosenSource: chosenSource,
          ws: {
            status: ws.status,
            receivedBars: wsCandles.length,
            cache_status: wsMeta?.cache_status,
            is_stale: wsMeta?.is_stale,
            last_update_ts: wsMeta?.last_update_ts,
          },
          rest: {
            status: 200,
            receivedBars: restCandles.length,
          },
        });
      }
    }

    return jsonOk({
      ok: true,
      target,
      symbol,
      range: effectiveRange,
      res: effectiveRes,
      session,
      candles: chosenCandles,
      meta,
    });
  }
}