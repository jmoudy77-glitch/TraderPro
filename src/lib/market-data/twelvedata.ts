import type { Candle } from "@/lib/market-data/types";

// Twelve Data base
const BASE = "https://api.twelvedata.com";

type TwelveValue = {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
};

type TwelveProfile = {
  symbol?: string;
  name?: string;
  exchange?: string;
  mic_code?: string;
  currency?: string;
  country?: string;
  type?: string;
  sector?: string;
  industry?: string;
  // Twelve Data may return additional fields; we only rely on sector/industry.
  [k: string]: any;
};

function toInterval(resolution: string): string {
  switch (resolution) {
    case "1m":
      return "1min";
    case "5m":
      return "5min";
    case "15m":
      return "15min";
    case "1h":
      return "1h";
    case "4h":
      return "4h";
    case "1d":
      return "1day";
    default:
      return "5min";
  }
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

// Twelve Data returns `datetime` without timezone suffix.
// We force timezone=UTC in the request, then parse by appending "Z".
function parseUtcDatetimeToEpochSeconds(dt: string): number {
  // dt can be "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS"
  if (dt.length === 10) {
    return Math.floor(Date.parse(`${dt}T00:00:00Z`) / 1000);
  }
  // "YYYY-MM-DD HH:MM:SS"
  return Math.floor(Date.parse(dt.replace(" ", "T") + "Z") / 1000);
}

/**
 * Batch fetch time_series for one or many symbols.
 * Uses Twelve Data "Method 1" batch via comma-separated `symbol` query param.  [oai_citation:0‡Twelve Data Support](https://support.twelvedata.com/en/articles/5203360-batch-api-requests)
 *
 * Returns a map: symbol -> candles (ASC by time)
 */
export async function fetchTwelveDataTimeSeries(opts: {
  symbols: string[];
  resolution: string;
  range: string;
  outputsizeExtraLookback?: number; // extra bars for indicators/lookback
}): Promise<Record<string, Candle[]>> {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) throw new Error("Missing TWELVEDATA_API_KEY");

  const interval = toInterval(opts.resolution);

  const durationSeconds = durationSecondsForRange(opts.range);
  const stepSeconds = stepSecondsForResolution(opts.resolution);
  const visibleCount = Math.ceil(durationSeconds / stepSeconds);

  const lookback = opts.outputsizeExtraLookback ?? 220;
  const outputsize = Math.min(5000, Math.max(2, visibleCount + lookback));

  const symbolsJoined = opts.symbols.join(",");

  const url = new URL(`${BASE}/time_series`);
  url.searchParams.set("symbol", symbolsJoined);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(outputsize));
  url.searchParams.set("format", "JSON");
  url.searchParams.set("order", "ASC");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("prepost", "false");
  url.searchParams.set("apikey", apiKey);

  const res = await fetch(url.toString(), { method: "GET", cache: "no-store" });
  const json = await res.json();

  // Single-symbol shape: { status, meta, values: [...] }
  // Batch shape: { "AAPL": { status, meta, values }, "MSFT": { ... } }
  if (json && typeof json === "object" && json.status === "error") {
    throw new Error(json.message ?? "Twelve Data error");
  }

  const out: Record<string, Candle[]> = {};

  const handleOne = (sym: string, payload: any) => {
    if (!payload) {
      out[sym] = [];
      return;
    }
    if (payload.status === "error") {
      out[sym] = [];
      return;
    }
    const values: TwelveValue[] = Array.isArray(payload.values) ? payload.values : [];
    out[sym] = values
      .map((v) => {
        const t = parseUtcDatetimeToEpochSeconds(v.datetime);
        const open = Number(v.open);
        const high = Number(v.high);
        const low = Number(v.low);
        const close = Number(v.close);
        const volume = v.volume != null ? Number(v.volume) : undefined;

        return {
          time: t,
          open,
          high,
          low,
          close,
          ...(Number.isFinite(volume as number) ? { volume } : {}),
        } satisfies Candle;
      })
      .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.close));
  };

  if (Array.isArray(opts.symbols) && opts.symbols.length === 1) {
    handleOne(opts.symbols[0], json);
    return out;
  }

  // Batch response: keys are symbols (per Twelve Data batch behavior).  [oai_citation:1‡GitHub](https://github.com/twelvedata/twelvedata-python)
  for (const sym of opts.symbols) {
    handleOne(sym, json?.[sym]);
  }

  return out;
}

/**
 * Fetch company profile data (sector/industry) for a single symbol.
 * Twelve Data endpoint: /profile
 */
export async function fetchTwelveDataProfile(symbol: string): Promise<TwelveProfile | null> {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) throw new Error("Missing TWELVEDATA_API_KEY");

  const sym = symbol.trim().toUpperCase();
  if (!sym) return null;

  const url = new URL(`${BASE}/profile`);
  url.searchParams.set("symbol", sym);
  url.searchParams.set("format", "JSON");
  url.searchParams.set("apikey", apiKey);

  const res = await fetch(url.toString(), { method: "GET", cache: "no-store" });
  const json = await res.json();

  if (json && typeof json === "object" && (json as any).status === "error") {
    return null;
  }

  if (!json || typeof json !== "object") return null;
  return json as TwelveProfile;
}

// Back-compat alias used by the scheduler tick.
export async function getProfile(symbol: string): Promise<TwelveProfile | null> {
  return fetchTwelveDataProfile(symbol);
}