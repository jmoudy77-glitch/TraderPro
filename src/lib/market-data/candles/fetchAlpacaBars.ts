// src/lib/market-data/candles/fetchAlpacaBars.ts
// Canonical Alpaca REST candle fetcher (symbol-scoped)
// NOTE: No window math here. Callers must supply startISO/endISO.

import { env } from "process";
import type { Candle } from "../types";

export type AlpacaBar = {
  t: string | number; // timestamp (ISO or epoch ms depending on client)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export type FetchAlpacaBarsInput = {
  symbol: string;
  timeframe: string; // e.g. 1Min, 5Min, 1Hour, 1Day
  startISO: string;
  endISO: string;
  feed?: "sip" | "iex";
};

export type FetchAlpacaBarsResult =
  | { ok: true; bars: AlpacaBar[] }
  | { ok: false; status: number; error: string };

export type FetchAlpacaCandlesResult =
  | { ok: true; candles: Candle[] }
  | { ok: false; status: number; error: string };

function toEpochMs(t: string | number): number {
  if (typeof t === "number") {
    // Alpaca may return epoch ms depending on client; treat large numbers as ms.
    if (t > 1_000_000_000_000) return t;
    // If seconds, convert.
    if (t > 1_000_000_000) return t * 1000;
    return t;
  }
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : NaN;
}

export function normalizeAlpacaBarsToCandles(bars: AlpacaBar[]): Candle[] {
  const out: Candle[] = [];
  for (const b of bars) {
    const time = toEpochMs(b.t);
    if (!Number.isFinite(time)) continue;
    out.push({
      time,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    });
  }
  // Ensure ascending time
  out.sort((a, b) => a.time - b.time);
  return out;
}

function getAlpacaHeaders() {
  const key = env.ALPACA_KEY || env.ALPACA_API_KEY || env.NEXT_PUBLIC_ALPACA_API_KEY;
  const secret = env.ALPACA_SECRET || env.ALPACA_API_SECRET || env.NEXT_PUBLIC_ALPACA_API_SECRET;

  if (!key || !secret) {
    throw new Error("Missing Alpaca API credentials");
  }

  return {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
  } as Record<string, string>;
}

export async function fetchAlpacaBarsSymbol(
  input: FetchAlpacaBarsInput
): Promise<FetchAlpacaBarsResult> {
  const { symbol, timeframe, startISO, endISO, feed = "sip" } = input;

  const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars`);
  url.searchParams.set("timeframe", timeframe);
  url.searchParams.set("start", startISO);
  url.searchParams.set("end", endISO);
  url.searchParams.set("adjustment", "raw");
  url.searchParams.set("feed", feed);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: getAlpacaHeaders(),
    });
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      error: err?.message || "Network error",
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      error: text || `Alpaca error ${res.status}`,
    };
  }

  const json = (await res.json()) as { bars?: AlpacaBar[] };

  return {
    ok: true,
    bars: Array.isArray(json?.bars) ? json.bars : [],
  };
}

export async function fetchAlpacaCandlesSymbol(
  input: FetchAlpacaBarsInput
): Promise<FetchAlpacaCandlesResult> {
  const res = await fetchAlpacaBarsSymbol(input);
  if (!res.ok) return res;
  return { ok: true, candles: normalizeAlpacaBarsToCandles(res.bars) };
}