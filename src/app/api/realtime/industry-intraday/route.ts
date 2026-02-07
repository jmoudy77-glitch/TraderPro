import { NextResponse } from "next/server";

const TIMEOUT_MS = 6500;

function jsonResponse(body: unknown, status = 200) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

type CandleLike = {
  t?: number | string; // timestamp (ms or iso) depending on upstream
  time?: number | string;
  o?: number;
  c?: number;
  open?: number;
  close?: number;
  v?: number;
  volume?: number;
};

function toMs(x: unknown): number | null {
  if (x == null) return null;
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const s = String(x);
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  const d = Date.parse(s);
  return Number.isFinite(d) ? d : null;
}

function candleTsMs(c: CandleLike): number | null {
  return toMs(c.t ?? c.time ?? null);
}

function candleOpen(c: CandleLike): number | null {
  const v = c.o ?? c.open ?? null;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function candleClose(c: CandleLike): number | null {
  const v = c.c ?? c.close ?? null;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pct(a: number, b: number): number {
  // (b - a) / a
  if (!Number.isFinite(a) || a === 0) return 0;
  return (b - a) / a;
}

function ymdUTC(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function fetchSymbol5m(req: Request, symbol: string, limit: number) {
  const params = new URLSearchParams();
  params.set("target", "SYMBOL");
  params.set("symbol", symbol);
  params.set("range", "1D");
  params.set("res", "5m");
  // This endpoint is used for regular-session breadth stats.
  params.set("session", "regular");

  const url = new URL(req.url);
  const origin = url.origin;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${origin}/api/market/candles/window?${params.toString()}`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });

    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = {
        ok: false,
        error: { code: "BAD_JSON", message: "Non-JSON response", upstream: "fly", status: null },
      };
    }

    return json;
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get("symbols") ?? "").trim();

  const symbols = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (!symbols.length) {
    return jsonResponse({ ok: false, error: { code: "MISSING_SYMBOLS", message: "No symbols provided" } }, 200);
  }

  // Keep modest to avoid hammering Fly; modal use-case is bounded
  const unique = Array.from(new Set(symbols)).slice(0, 120);

  // 5m bars: 78 bars/day regular session; use buffer for premarket/noise
  const limit = 140;

  const results = await Promise.all(
    unique.map(async (sym) => {
      const payload = await fetchSymbol5m(req, sym, limit);

      if (payload?.ok === false) {
        return { symbol: sym, ok: false as const, error: payload.error ?? { code: "UPSTREAM_ERROR" } };
      }

      const candles: CandleLike[] = Array.isArray(payload?.candles) ? payload.candles : [];
      const normalized = candles
        .map((c) => ({ c, t: candleTsMs(c) }))
        .filter((x) => x.t != null)
        .sort((a, b) => (a.t! - b.t!));

      if (!normalized.length) {
        return { symbol: sym, ok: false as const, error: { code: "NO_CANDLES", message: "No candles returned" } };
      }

      const last = normalized[normalized.length - 1];
      const lastClose = candleClose(last.c);
      const lastTs = last.t!;

      // “Session day” heuristic: use the day of the most recent candle, then take first candle of that same day.
      const dayKey = ymdUTC(lastTs);
      const sameDay = normalized.filter((x) => ymdUTC(x.t!) === dayKey);

      const openCandle = sameDay.length ? sameDay[0] : normalized[0];
      const openPrice = candleOpen(openCandle.c);

      // 60m change: 12 candles back in same-day slice if possible, else overall
      const back12 = (sameDay.length ? sameDay : normalized);
      const idx = back12.length - 1;
      const prev60 = idx - 12 >= 0 ? back12[idx - 12] : null;
      const prev60Close = prev60 ? candleClose(prev60.c) : null;

      const pctSinceOpen =
        openPrice != null && lastClose != null ? pct(openPrice, lastClose) : 0;

      const pct60m =
        prev60Close != null && lastClose != null ? pct(prev60Close, lastClose) : 0;

      return {
        symbol: sym,
        ok: true as const,
        last: lastClose ?? null,
        pctSinceOpen,
        pct60m,
      };
    })
  );

  const okRows = results.filter((r) => (r as any).ok === true) as Array<{
    symbol: string;
    ok: true;
    last: number | null;
    pctSinceOpen: number;
    pct60m: number;
  }>;

  const green = okRows.filter((r) => r.pctSinceOpen > 0).length;
  const red = okRows.filter((r) => r.pctSinceOpen < 0).length;
  const total = okRows.length;

  const sorted = [...okRows].sort((a, b) => b.pctSinceOpen - a.pctSinceOpen);
  const leaders = sorted.slice(0, 3);
  const laggards = sorted.slice(-3).reverse();

  return jsonResponse({
    ok: true,
    meta: {
      res: "5m",
      symbolsRequested: unique.length,
      symbolsOk: total,
    },
    summary: {
      breadth: {
        green,
        red,
        total,
        pctGreen: total ? green / total : 0,
        pctRed: total ? red / total : 0,
      },
      leaders,
      laggards,
    },
    rows: okRows,
    errors: results.filter((r) => (r as any).ok === false),
  });
}