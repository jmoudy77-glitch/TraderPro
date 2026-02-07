import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type Candle = { time: number; open: number; high: number; low: number; close: number; volume?: number };

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
  resolution: DurableResolution;
  candles: Candle[];
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
    v: typeof c.volume === "number" ? c.volume : null,
    source: args.source,
  }));

  if (rows.length === 0) return;

  const { error } = await args.supabase.from(table).upsert(rows, { onConflict: "symbol,ts" });
  if (error) throw error;
}

const NY_TZ = "America/New_York";

function nyMsFromParts(y: number, m: number, d: number, hh: number, mm: number, ss = 0): number {
  // Create a Date in local tz then reinterpret using Intl in NY; safest simple approach:
  // build an ISO date-time, then let Date parse as UTC and adjust by NY offset via formatter.
  // Here we just create a UTC date from components then iterate to NY parts below.
  // This function is only used to produce stable bucket keys, not exact exchange offsets.
  return Date.UTC(y, m - 1, d, hh, mm, ss, 0);
}

function nyPartsFromMs(ms: number): { y: number; m: number; d: number; hh: number; mm: number } {
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

function bucketStartNyMsFor4h(ms: number): number {
  // Canon: 4h candles begin at 01:00 NY.
  // Bucket boundaries: 01:00, 05:00, 09:00, 13:00, 17:00, 21:00.
  const p = nyPartsFromMs(ms);
  const minutesOfDay = p.hh * 60 + p.mm;
  const anchor = 1 * 60; // 01:00

  // Normalize minutes since anchor into [0, 1440)
  let delta = minutesOfDay - anchor;
  while (delta < 0) delta += 1440;

  const bucketIndex = Math.floor(delta / (4 * 60));
  const bucketStartMinutes = (anchor + bucketIndex * 4 * 60) % 1440;

  const hh = Math.floor(bucketStartMinutes / 60);
  const mm = bucketStartMinutes % 60;

  // Use NY date components + bucketStart clock.
  return nyMsFromParts(p.y, p.m, p.d, hh, mm);
}

function bucketKeyNyDate(p: { y: number; m: number; d: number }): string {
  const mm = String(p.m).padStart(2, "0");
  const dd = String(p.d).padStart(2, "0");
  return `${p.y}-${mm}-${dd}`;
}

function aggregate4hFrom1hBars(bars: Candle[]): Candle[] {
  if (!bars || bars.length === 0) return [];

  // bars expected ascending by time
  const out: Candle[] = [];
  let curKey: number | null = null;
  let cur: Candle | null = null;

  for (const b of bars) {
    const ms = b.time * 1000;
    const bucketStart = bucketStartNyMsFor4h(ms);

    if (curKey === null || bucketStart !== curKey) {
      if (cur) out.push(cur);
      curKey = bucketStart;
      cur = {
        time: Math.floor(bucketStart / 1000),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: typeof b.volume === "number" ? b.volume : undefined,
      };
      continue;
    }

    // same bucket
    cur!.high = Math.max(cur!.high, b.high);
    cur!.low = Math.min(cur!.low, b.low);
    cur!.close = b.close;
    if (typeof b.volume === "number") {
      cur!.volume = (cur!.volume ?? 0) + b.volume;
    }
  }

  if (cur) out.push(cur);
  return out;
}

function qpBool(v: string | null): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
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

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  if (!serviceKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

function getAlpacaCreds(): { key: string; secret: string; dataBaseUrl: string; feed?: string } {
  // Support existing env naming in this repo (.env.local): ALPACA_KEY / ALPACA_SECRET
  // Also support common variants used in other deployments.
  const key =
    process.env.ALPACA_KEY ??
    process.env.ALPACA_API_KEY_ID ??
    process.env.ALPACA_KEY_ID ??
    "";

  const secret =
    process.env.ALPACA_SECRET ??
    process.env.ALPACA_API_SECRET_KEY ??
    process.env.ALPACA_SECRET_KEY ??
    "";

  // Alpaca data base URL (defaults to v2 stocks data)
  const dataBaseUrl =
    process.env.ALPACA_DATA_BASE_URL ??
    process.env.ALPACA_DATA_URL ??
    "https://data.alpaca.markets";

  const feed = process.env.ALPACA_FEED ?? undefined;

  if (!key) throw new Error("Missing Alpaca API key (ALPACA_KEY / ALPACA_API_KEY_ID / ALPACA_KEY_ID)");
  if (!secret) throw new Error("Missing Alpaca API secret (ALPACA_SECRET / ALPACA_API_SECRET_KEY / ALPACA_SECRET_KEY)");

  return { key, secret, dataBaseUrl, feed };
}

async function fetchAlpacaBars(args: {
  symbol: string;
  timeframe: "1Hour" | "1Day";
  startIso: string;
  endIso: string;
  limit: number;
}): Promise<Candle[]> {
  const { key, secret, dataBaseUrl, feed } = getAlpacaCreds();

  const url = new URL(`${dataBaseUrl}/v2/stocks/${encodeURIComponent(args.symbol)}/bars`);
  url.searchParams.set("timeframe", args.timeframe);
  url.searchParams.set("start", args.startIso);
  url.searchParams.set("end", args.endIso);
  url.searchParams.set("limit", String(args.limit));
  url.searchParams.set("sort", "asc");
  url.searchParams.set("adjustment", "raw");
  if (feed) url.searchParams.set("feed", feed);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Alpaca bars fetch failed (${res.status}): ${text || res.statusText}`);
  }

  const json = (await res.json()) as any;
  const bars = (json?.bars ?? []) as any[];

  return bars.map((b) => ({
    time: Math.floor(new Date(b.t).getTime() / 1000),
    open: Number(b.o),
    high: Number(b.h),
    low: Number(b.l),
    close: Number(b.c),
    volume: typeof b.v === "number" ? b.v : undefined,
  }));
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const target = searchParams.get("target") ?? "SYMBOL";
  const symbol = searchParams.get("symbol") ?? null;
  const range = searchParams.get("range") ?? "1D";
  const resolution = (searchParams.get("resolution") ?? "1h").toLowerCase();
  const scheduler = qpBool(searchParams.get("scheduler"));

  // Canon: Twelve Data is not used. All market data is ingested via Alpaca.
  // This route is for DURABLE candles only (1h / 4h / 1d). Intraday comes from realtime-ws.
  if (target !== "SYMBOL") {
    return NextResponse.json(
      {
        ok: false,
        error: "UNSUPPORTED_TARGET",
        target,
        message: "This endpoint supports durable SYMBOL candles only (1h/4h/1d).",
      },
      { status: 400 }
    );
  }

  const requestSymbol = symbol && symbol !== "EMPTY" ? symbol : null;
  if (!requestSymbol) {
    return NextResponse.json(
      { ok: false, error: "MISSING_SYMBOL", message: "No symbol provided for SYMBOL target." },
      { status: 400 }
    );
  }

  if (resolution !== "1h" && resolution !== "4h" && resolution !== "1d") {
    return NextResponse.json(
      {
        ok: false,
        error: "UNSUPPORTED_RESOLUTION",
        resolution,
        message: "Durable candles only. Use /api/market/candles/window for intraday resolutions.",
      },
      { status: 400 }
    );
  }

  const supabase = getAdmin();

  // Range window: request enough lookback for charting continuity.
  const durationSeconds = durationSecondsForRange(range);

  // For durable bars, we fetch more than the visible window to avoid gaps at boundaries.
  // (Scheduler runs shortly after close; this endpoint is safe for ad-hoc backfill too.)
  const endMs = Date.now();
  const startMs = endMs - (durationSeconds + 14 * 24 * 60 * 60) * 1000; // +14d buffer
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  // Alpaca limits vary; keep it conservative and rely on range windows.
  const limit = 5000;

  try {
    let candles: Candle[] = [];

    if (resolution === "1d") {
      // Canon: daily candles are based on regular market hours.
      // Alpaca 1Day bars are session-based; we persist them directly.
      candles = await fetchAlpacaBars({
        symbol: requestSymbol,
        timeframe: "1Day",
        startIso,
        endIso,
        limit,
      });
    } else {
      // Fetch 1h bars and either persist directly (1h) or aggregate to 4h anchored at 02:00 NY.
      const h1 = await fetchAlpacaBars({
        symbol: requestSymbol,
        timeframe: "1Hour",
        startIso,
        endIso,
        limit,
      });

      candles = resolution === "1h" ? h1 : aggregate4hFrom1hBars(h1);
    }

    // Persist durable bars whenever we successfully fetched.
    // Scheduler is the canonical caller (shortly after candle close), but ad-hoc calls are allowed.
    await persistDurableCandles({
      supabase,
      symbol: requestSymbol,
      resolution: resolution as DurableResolution,
      candles,
      source: "alpaca",
      ownerUserId: null,
    });

    return NextResponse.json({
      ok: true,
      target: `SYMBOL:${requestSymbol}`,
      range,
      resolution,
      candles,
      visibleCount: candles.length,
      source: "alpaca",
      scheduler,
    });
  } catch (err: any) {
    const message = err?.message ?? String(err);
    return NextResponse.json(
      {
        ok: false,
        error: "ALPACA_DURABLE_CANDLES_FAILED",
        requestSymbol,
        range,
        resolution,
        scheduler,
        message,
      },
      { status: 502 }
    );
  }
}