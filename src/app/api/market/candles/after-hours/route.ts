

/**
 * DEPRECATED: Historical candle hydration is now served by `/api/market/candles/window`.
 *
 * This endpoint is retained temporarily for rollback/reference and as an internal fallback/backfill
 * path while the new window route stabilizes. The UI must not call this route.
 * (See Note: “Single Endpoint Transition”.)
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceRole } from "@/lib/supabase/server";

// After-hours / extended-hours candles via Alpaca Data REST.
// Defaults to the most relevant extended-hours window based on current ET.
//
// Query params:
//   symbol   (required) e.g. QQQ
//   timeframe (optional) one of: 1Min, 5Min, 15Min, 30Min, 1Hour, 1Day  (default: 1Min)
//   start    (optional) ISO datetime
//   end      (optional) ISO datetime
//
// Notes:
// - Uses ALPACA_KEY / ALPACA_SECRET.
// - Uses Alpaca data host: https://data.alpaca.markets
// - Requests feed=sip by default.

export const runtime = "nodejs";

function requireSchedulerAuth(req: Request): { ok: true } | { ok: false; error: string } {
  const expected = process.env.TRADERPRO_SCHEDULER_SECRET || "";
  if (!expected) return { ok: false, error: "SCHEDULER_SECRET_NOT_CONFIGURED" };
  const got = req.headers.get("x-traderpro-scheduler-secret") ?? "";
  if (!got || got !== expected) return { ok: false, error: "UNAUTHORIZED_SCHEDULER" };
  return { ok: true };
}

function getAdmin() {
  return createSupabaseServiceRole();
}

function normalizeWatchlistKey(raw: string): string {
  const input = (raw ?? "").trim();
  if (!input) return "";

  const upper = input.toUpperCase();
  const slugBase = upper
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slugBase) return "";

  const RESERVED_ALIASES: Record<string, string> = {
    SENTINEL: "SENTINEL",
    SENTINELS: "SENTINEL",
    SAFE_HAVENS: "SAFE_HAVENS",
    SAFE_HAVEN: "SAFE_HAVENS",
    LAUNCH_LEADERS: "LAUNCH_LEADERS",
    HIGH_VELOCITY_MULTIPLIERS: "HIGH_VELOCITY_MULTIPLIERS",
    SLOW_BURNERS: "SLOW_BURNERS",
  };

  const canonicalReserved = RESERVED_ALIASES[slugBase];
  if (canonicalReserved) return canonicalReserved;

  if (/^CUSTOM_[A-Z0-9_]{1,44}$/.test(slugBase)) {
    return slugBase;
  }

  const slug = slugBase.slice(0, 44);
  return `CUSTOM_${slug}`;
}

type AlpacaBar = {
  t: string; // RFC3339 timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n?: number;
  vw?: number;
};

const ALLOWED_TIMEFRAMES = new Set([
  "1Min",
  "5Min",
  "15Min",
  "30Min",
  "1Hour",
  "1Day",
]);

function jsonError(status: number, error: string, detail?: unknown) {
  return NextResponse.json(
    { ok: false, error, detail: detail ?? null },
    { status }
  );
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function parseTimeframe(raw: string | null): string {
  const tf = (raw ?? "1Min").trim();
  if (!ALLOWED_TIMEFRAMES.has(tf)) return "1Min";
  return tf;
}

type TargetType = "SYMBOL" | "WATCHLIST_COMPOSITE";

function parseTarget(raw: string | null): TargetType {
  const t = (raw ?? "SYMBOL").trim().toUpperCase();
  if (t === "WATCHLIST_COMPOSITE") return "WATCHLIST_COMPOSITE";
  return "SYMBOL";
}

function parseTimeframeFromParams(sp: URLSearchParams): string {
  const tf = sp.get("timeframe");
  if (tf) return parseTimeframe(tf);

  // Back-compat: some callers send `resolution` like 1m/5m/15m/30m/1h/1d.
  const res = (sp.get("resolution") ?? "").trim().toLowerCase();
  switch (res) {
    case "1m":
    case "1min":
      return "1Min";
    case "5m":
    case "5min":
      return "5Min";
    case "15m":
    case "15min":
      return "15Min";
    case "30m":
    case "30min":
      return "30Min";
    case "1h":
    case "1hour":
      return "1Hour";
    case "1d":
    case "1day":
      return "1Day";
    default:
      return parseTimeframe(null);
  }
}
type ConstituentMeta = { pctChange: number; prevClose: number; prevCloseDate: string; sparkline1d: number[] };

function deriveConstituentMeta(bars: AlpacaBar[], session: string): ConstituentMeta | null {
  if (!bars || bars.length < 2) return null;
  const first = bars[0];
  const last = bars[bars.length - 1];
  const base = typeof first.o === "number" ? first.o : first.c;
  const end = typeof last.c === "number" ? last.c : last.o;
  if (!Number.isFinite(base) || !Number.isFinite(end) || base <= 0) return null;
  const pctChange = ((end / base) - 1) * 100;
  const sparkline1d = bars.map((b) => b.c).filter((x) => Number.isFinite(x));

  // session date for display: best-effort YYYY-MM-DD from first bar timestamp.
  const d = new Date(first.t);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const prevCloseDate = `${y}-${m}-${dd}`;

  return { pctChange, prevClose: base, prevCloseDate, sparkline1d };
}

function buildCompositeCandlesFromBars(args: {
  barsBySymbol: Record<string, AlpacaBar[]>;
}): { candles: AlpacaBar[] } {
  const symbols = Object.keys(args.barsBySymbol);
  if (symbols.length === 0) return { candles: [] };

  // Build union timestamp index.
  const byTs: Record<string, Record<string, AlpacaBar>> = {};
  const tsSet = new Set<string>();

  for (const sym of symbols) {
    const bars = args.barsBySymbol[sym] ?? [];
    for (const b of bars) {
      tsSet.add(b.t);
      if (!byTs[b.t]) byTs[b.t] = {};
      byTs[b.t][sym] = b;
    }
  }

  const timestamps = Array.from(tsSet).sort();

  // Per-symbol normalization factor: first bar open.
  const baseBySymbol: Record<string, number> = {};
  for (const sym of symbols) {
    const bars = args.barsBySymbol[sym] ?? [];
    const first = bars[0];
    const base = first ? (typeof first.o === "number" ? first.o : first.c) : NaN;
    if (Number.isFinite(base) && base > 0) baseBySymbol[sym] = base;
  }

  const out: AlpacaBar[] = [];

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
      const no = (b.o / base) * 100;
      const nh = (b.h / base) * 100;
      const nl = (b.l / base) * 100;
      const nc = (b.c / base) * 100;

      if (!Number.isFinite(no) || !Number.isFinite(nh) || !Number.isFinite(nl) || !Number.isFinite(nc)) continue;

      o += no;
      h += nh;
      l += nl;
      c += nc;
      v += typeof b.v === "number" ? b.v : 0;
      n += 1;
    }

    if (n === 0) continue;

    out.push({
      t,
      o: o / n,
      h: h / n,
      l: l / n,
      c: c / n,
      v,
    });
  }

  return { candles: out };
}

function normalizeSymbol(raw: string | null): string | null {
  const s = (raw ?? "").trim().toUpperCase();
  if (!s) return null;
  // Basic safety: Alpaca symbols are typically A-Z, ., -, / (for some assets). Keep it conservative.
  if (!/^[A-Z0-9.\-]+$/.test(s)) return null;
  return s;
}

function toIso(d: Date): string {
  return d.toISOString();
}

const NY_TZ = "America/New_York";

function etParts(nowUtc = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(nowUtc);

  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: NY_TZ, weekday: "short" })
    .format(nowUtc)
    .toUpperCase();

  return {
    yyyy: Number(get("year")),
    mm: Number(get("month")),
    dd: Number(get("day")),
    HH: Number(get("hour")),
    MM: Number(get("minute")),
    dow,
  };
}

function etWallClockToUtcDate(y: number, m: number, d: number, h: number, min: number): Date {
  const naive = new Date(Date.UTC(y, m - 1, d, h, min, 0, 0));

  const etStr = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(naive);

  const m2 = etStr.match(/^(\d{2})\/(\d{2})\/(\d{4}),\s(\d{2}):(\d{2}):(\d{2})$/);
  if (!m2) return naive;

  const em = Number(m2[1]);
  const ed = Number(m2[2]);
  const ey = Number(m2[3]);
  const eh = Number(m2[4]);
  const emin = Number(m2[5]);
  const es = Number(m2[6]);

  const asUtc = Date.UTC(ey, em - 1, ed, eh, emin, es);
  const naiveMs = naive.getTime();
  const offsetMs = naiveMs - asUtc;

  return new Date(Date.UTC(y, m - 1, d, h, min, 0, 0) + offsetMs);
}

function regularSessionWindowUtc(nowUtc = new Date()): { start: string; end: string; session: string } {
  const p = etParts(nowUtc);
  const minutes = p.HH * 60 + p.MM;
  const beforeOpen = minutes < 9 * 60 + 30;

  // Find the correct session date:
  // - Sat/Sun => Friday
  // - Mon before open => Friday
  // Otherwise => today
  let deltaDays = 0;
  if (p.dow === "SAT") deltaDays = 1;
  else if (p.dow === "SUN") deltaDays = 2;
  else if (p.dow === "MON" && beforeOpen) deltaDays = 3;

  const anchor = new Date(nowUtc.getTime() - deltaDays * 24 * 60 * 60 * 1000);
  const sp = etParts(anchor);

  const start = etWallClockToUtcDate(sp.yyyy, sp.mm, sp.dd, 9, 30);
  const regularEnd = etWallClockToUtcDate(sp.yyyy, sp.mm, sp.dd, 16, 0);

  // If we're currently inside the regular session of that day, end at now; else end at 16:00.
  const nowEt = etParts(nowUtc);
  const isSameEtDay = nowEt.yyyy === sp.yyyy && nowEt.mm === sp.mm && nowEt.dd === sp.dd;
  const nowMinutes = nowEt.HH * 60 + nowEt.MM;
  const inSession = isSameEtDay && nowMinutes >= 9 * 60 + 30 && nowMinutes <= 16 * 60;

  const end = inSession ? nowUtc : regularEnd;

  return { start: toIso(start), end: toIso(end), session: "regular" };
}

// Returns the full extended-hours 1D window (04:00 -> min(now, 20:00)) for the most recent trading day.
function fullExtendedDayWindowUtc(nowUtc = new Date()): { start: string; end: string; session: string } {
  const pNow = etParts(nowUtc);
  const nowMinutes = pNow.HH * 60 + pNow.MM;

  // Determine anchor trading day (Mon–Fri). If we're before 04:00 ET, anchor to the previous trading day.
  let anchor = nowUtc;
  if (nowMinutes < 4 * 60) {
    anchor = new Date(nowUtc.getTime() - 24 * 60 * 60 * 1000);
  }

  // Walk back to the most recent weekday (skip Sat/Sun).
  for (let i = 0; i < 7; i++) {
    const p = etParts(anchor);
    if (p.dow !== "SAT" && p.dow !== "SUN") break;
    anchor = new Date(anchor.getTime() - 24 * 60 * 60 * 1000);
  }

  const sp = etParts(anchor);

  const dayStart = etWallClockToUtcDate(sp.yyyy, sp.mm, sp.dd, 4, 0);
  const dayEnd = etWallClockToUtcDate(sp.yyyy, sp.mm, sp.dd, 20, 0);

  // If 'now' is during the anchored day (04:00 -> 20:00 ET), end at now; otherwise end at 20:00 ET.
  const nowEt = etParts(nowUtc);
  const isSameEtDay = nowEt.yyyy === sp.yyyy && nowEt.mm === sp.mm && nowEt.dd === sp.dd;
  const nowEtMinutes = nowEt.HH * 60 + nowEt.MM;
  const inExtendedDay = isSameEtDay && nowEtMinutes >= 4 * 60 && nowEtMinutes <= 20 * 60;

  const end = inExtendedDay ? nowUtc : dayEnd;

  return { start: toIso(dayStart), end: toIso(end), session: "extended" };
}

// Returns an ISO window in UTC for the most relevant extended-hours session.
// Uses America/New_York session semantics:
//   premarket: 04:00 -> 09:30
//   regular:   09:30 -> 16:00
//   after:     16:00 -> 20:00
//
// If now is:
// - 16:00-20:00 ET: after-hours today (16:00 -> now)
// - 20:00-04:00 ET: most recent after-hours (yesterday or today depending) (16:00 -> 20:00)
// - 04:00-09:30 ET: premarket today (04:00 -> now)
// - 09:30-16:00 ET: returns today regular session window (09:30 -> now) (still useful)
function defaultExtendedHoursWindowUtc(nowUtc = new Date()): { start: string; end: string; session: string } {
  // Convert "now" into ET components using Intl.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(nowUtc);

  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  const yyyy = Number(get("year"));
  const mm = Number(get("month"));
  const dd = Number(get("day"));
  const HH = Number(get("hour"));
  const MM = Number(get("minute"));

  // Helper: build a UTC Date from an ET wall-clock date/time.
  // We do this by formatting the ET wall-clock as ISO-like and re-parsing via Date in UTC using offset.
  // The simplest reliable way in Node is to construct a Date from the equivalent time in ET by using Intl
  // to get the offset at that moment.
  const etWallClockToUtcDate = (y: number, m: number, d: number, h: number, min: number) => {
    // Create a UTC date that *pretends* to be the wall clock, then compute actual offset.
    const naive = new Date(Date.UTC(y, m - 1, d, h, min, 0, 0));

    // Determine the offset between UTC and ET at that instant.
    const etStr = new Intl.DateTimeFormat("en-US", {
      timeZone: NY_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(naive);

    // Parse formatted "MM/DD/YYYY, HH:MM:SS" to get wall-clock back.
    // Example: "02/02/2026, 15:30:00"
    const m2 = etStr.match(/^(\d{2})\/(\d{2})\/(\d{4}),\s(\d{2}):(\d{2}):(\d{2})$/);
    if (!m2) return naive;

    const em = Number(m2[1]);
    const ed = Number(m2[2]);
    const ey = Number(m2[3]);
    const eh = Number(m2[4]);
    const emin = Number(m2[5]);
    const es = Number(m2[6]);

    // This Date.UTC is what those ET components would be if they were UTC.
    const asUtc = Date.UTC(ey, em - 1, ed, eh, emin, es);
    const naiveMs = naive.getTime();

    // Offset is difference between the two interpretations.
    const offsetMs = naiveMs - asUtc;

    // Apply offset to align the wall clock to ET.
    return new Date(Date.UTC(y, m - 1, d, h, min, 0, 0) + offsetMs);
  };

  // Define ET session boundaries for the *current ET date*.
  const preStart = etWallClockToUtcDate(yyyy, mm, dd, 4, 0);
  const regularStart = etWallClockToUtcDate(yyyy, mm, dd, 9, 30);
  const regularEnd = etWallClockToUtcDate(yyyy, mm, dd, 16, 0);
  const afterEnd = etWallClockToUtcDate(yyyy, mm, dd, 20, 0);

  const now = nowUtc;

  // Determine which window to use.
  if (now >= regularEnd && now <= afterEnd) {
    return { start: toIso(regularEnd), end: toIso(now), session: "after_hours" };
  }

  if (now > afterEnd) {
    // After 20:00 ET, show today's after-hours full window.
    return { start: toIso(regularEnd), end: toIso(afterEnd), session: "after_hours" };
  }

  if (now >= preStart && now < regularStart) {
    return { start: toIso(preStart), end: toIso(now), session: "pre_market" };
  }

  if (now >= regularStart && now < regularEnd) {
    // During regular session, still return a sane window.
    return { start: toIso(regularStart), end: toIso(now), session: "regular" };
  }

  // Between 20:00 and 04:00 ET: use *most recent* after-hours (yesterday).
  // Compute "yesterday" by subtracting 24h and re-deriving its ET date.
  const yUtc = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yParts = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(yUtc);
  const yGet = (type: string) => yParts.find((p) => p.type === type)?.value;
  const yyy = Number(yGet("year"));
  const ymm = Number(yGet("month"));
  const ydd = Number(yGet("day"));

  const yRegularEnd = etWallClockToUtcDate(yyy, ymm, ydd, 16, 0);
  const yAfterEnd = etWallClockToUtcDate(yyy, ymm, ydd, 20, 0);

  return { start: toIso(yRegularEnd), end: toIso(yAfterEnd), session: "after_hours" };
}

function normalizeBarTimeToIso(raw: any): string | null {
  if (typeof raw === "string") {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  if (typeof raw === "number") {
    // Heuristics:
    // - ns epoch ~ 1e18
    // - ms epoch ~ 1e12–1e13
    // - seconds epoch ~ 1e9–1e10
    let ms = raw;

    if (raw > 1e15) {
      // likely nanoseconds -> ms
      ms = Math.floor(raw / 1e6);
    } else if (raw > 1e12) {
      // likely milliseconds already
      ms = raw;
    } else {
      // likely seconds -> ms
      ms = raw * 1000;
    }

    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  return null;
}

async function fetchAlpacaBars(args: {
  symbol: string;
  timeframe: string;
  start: string;
  end: string;
  feed: string;
}): Promise<AlpacaBar[]> {
  const key = requireEnv("ALPACA_KEY");
  const secret = requireEnv("ALPACA_SECRET");

  const base = "https://data.alpaca.markets";
  const url = new URL(`${base}/v2/stocks/${encodeURIComponent(args.symbol)}/bars`);
  url.searchParams.set("timeframe", args.timeframe);
  url.searchParams.set("start", args.start);
  url.searchParams.set("end", args.end);
  url.searchParams.set("feed", args.feed);
  url.searchParams.set("adjustment", "raw");
  url.searchParams.set("sort", "asc");
  // Keep a high limit; Alpaca will cap as needed.
  url.searchParams.set("limit", "10000");

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
      Accept: "application/json",
    },
    // Always bypass Next cache for market data.
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Alpaca bars error ${res.status}: ${text.slice(0, 500)}`);
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Alpaca bars non-JSON response: ${text.slice(0, 200)}`);
  }

  const barsRaw = Array.isArray(data?.bars) ? (data.bars as any[]) : [];

  const bars: AlpacaBar[] = barsRaw
    .map((b) => {
      const tIso = normalizeBarTimeToIso(b?.t);
      if (!tIso) return null;

      return {
        t: tIso,
        o: Number(b?.o),
        h: Number(b?.h),
        l: Number(b?.l),
        c: Number(b?.c),
        v: Number(b?.v),
        n: typeof b?.n === "number" ? b.n : undefined,
        vw: typeof b?.vw === "number" ? b.vw : undefined,
      } as AlpacaBar;
    })
    .filter((b): b is AlpacaBar => {
      if (!b) return false;
      return (
        Number.isFinite(b.o) &&
        Number.isFinite(b.h) &&
        Number.isFinite(b.l) &&
        Number.isFinite(b.c) &&
        Number.isFinite(b.v)
      );
    });

  return bars;
}

export async function GET(req: NextRequest) {
  try {
    const authz = requireSchedulerAuth(req);
    if (!authz.ok) {
      return jsonError(401, authz.error);
    }
    const url = new URL(req.url);

    const target = parseTarget(url.searchParams.get("target"));

    const timeframe = parseTimeframeFromParams(url.searchParams);

    const symbol = target === "SYMBOL" ? normalizeSymbol(url.searchParams.get("symbol")) : null;
    if (target === "SYMBOL" && !symbol) {
      return jsonError(400, "BAD_SYMBOL", "Query param 'symbol' is required.");
    }

    const watchlistKeyRaw = target === "WATCHLIST_COMPOSITE" ? url.searchParams.get("watchlistKey") : null;
    const ownerUserIdRaw = target === "WATCHLIST_COMPOSITE" ? url.searchParams.get("ownerUserId") : null;

    const watchlistKey = target === "WATCHLIST_COMPOSITE" ? normalizeWatchlistKey(watchlistKeyRaw ?? "") : "";
    const ownerUserId = (ownerUserIdRaw ?? "").trim();

    if (target === "WATCHLIST_COMPOSITE" && (!watchlistKey || !ownerUserId)) {
      return jsonError(400, "BAD_COMPOSITE_PARAMS", "watchlistKey and ownerUserId are required for WATCHLIST_COMPOSITE.");
    }

    const startRaw = url.searchParams.get("start");
    const endRaw = url.searchParams.get("end");

    let startIso: string;
    let endIso: string;
    let session: string;

    if (startRaw && endRaw) {
      const start = new Date(startRaw);
      const end = new Date(endRaw);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return jsonError(400, "BAD_TIME_RANGE", "start/end must be valid ISO datetimes.");
      }
      if (end <= start) {
        return jsonError(400, "BAD_TIME_RANGE", "end must be > start.");
      }
      startIso = start.toISOString();
      endIso = end.toISOString();
      session = "custom";
    } else {
      const rangeParam = (url.searchParams.get("range") ?? "").trim().toUpperCase();
      const sessionParam = (url.searchParams.get("session") ?? "").trim().toLowerCase();

      const wantsRegular = sessionParam === "regular";
      const wantsAfter = sessionParam === "after_hours" || sessionParam === "after-hours";
      const wantsPre = sessionParam === "pre_market" || sessionParam === "pre-market";

      let w: { start: string; end: string; session: string };

      // Canon: 1D hydration should begin at the start of the trading day pre-market (04:00 ET)
      // unless the caller explicitly requests a specific session.
      const wantsFullDay = (rangeParam === "" || rangeParam === "1D") && sessionParam === "";

      if (wantsFullDay) {
        w = fullExtendedDayWindowUtc(new Date());
      } else if (wantsRegular) {
        w = regularSessionWindowUtc(new Date());
      } else {
        // Explicit pre/after (or any non-empty/unknown sessionParam) falls back to the most relevant extended-hours window.
        w = defaultExtendedHoursWindowUtc(new Date());
        // Preserve explicit session label where possible.
        if (wantsAfter) w.session = "after_hours";
        if (wantsPre) w.session = "pre_market";
      }

      startIso = w.start;
      endIso = w.end;
      session = w.session;
    }

    // Default to SIP to match your realtime plane.
    const feed = (url.searchParams.get("feed") ?? "sip").trim();

    if (target === "SYMBOL") {
      const bars = await fetchAlpacaBars({ symbol: symbol as string, timeframe, start: startIso, end: endIso, feed });

      const candles = bars
        .map((b) => {
          const time = Date.parse(b.t);
          if (!Number.isFinite(time)) return null;
          return {
            time,
            open: b.o,
            high: b.h,
            low: b.l,
            close: b.c,
            volume: b.v,
          };
        })
        .filter(Boolean);

      return NextResponse.json({
        ok: true,
        source: "alpaca_rest",
        target: "SYMBOL",
        symbol,
        timeframe,
        session,
        range: { start: startIso, end: endIso },
        candles,
      });
    }

    // WATCHLIST_COMPOSITE
    const supabase = getAdmin();

    const { data: wlData, error: wlError } = await supabase
      .from("watchlists")
      .select("id")
      .eq("owner_user_id", ownerUserId)
      .eq("key", watchlistKey)
      .limit(1);

    if (wlError) return jsonError(500, "WATCHLIST_LOOKUP_FAILED", wlError.message);

    const watchlistId = (wlData as any[] | null)?.[0]?.id as string | undefined;
    if (!watchlistId) {
      return NextResponse.json({
        ok: true,
        source: "alpaca_rest",
        target: "WATCHLIST_COMPOSITE",
        watchlistKey,
        ownerUserId,
        timeframe,
        session,
        range: { start: startIso, end: endIso },
        candles: [],
        meta: { constituents: {} },
      });
    }

    const { data: symData, error: symError } = await supabase
      .from("watchlist_symbols")
      .select("symbol, sort_order, is_active")
      .eq("watchlist_id", watchlistId)
      .eq("is_active", true)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("symbol", { ascending: true });

    if (symError) return jsonError(500, "WATCHLIST_SYMBOLS_FAILED", symError.message);

    const symbols = (symData as any[] | null)?.map((r) => String(r.symbol ?? "").trim().toUpperCase()).filter(Boolean) ?? [];
    const uniq = Array.from(new Set(symbols));

    if (uniq.length === 0) {
      return NextResponse.json({
        ok: true,
        source: "alpaca_rest",
        target: "WATCHLIST_COMPOSITE",
        watchlistKey,
        ownerUserId,
        timeframe,
        session,
        range: { start: startIso, end: endIso },
        candles: [],
        meta: { constituents: {} },
      });
    }

    const barsBySymbolEntries = await Promise.all(
      uniq.map(async (sym) => {
        try {
          const bars = await fetchAlpacaBars({ symbol: sym, timeframe, start: startIso, end: endIso, feed });
          return [sym, bars] as const;
        } catch {
          return [sym, [] as AlpacaBar[]] as const;
        }
      })
    );

    const barsBySymbol: Record<string, AlpacaBar[]> = {};
    const constituents: Record<string, ConstituentMeta> = {};

    for (const [sym, bars] of barsBySymbolEntries) {
      barsBySymbol[sym] = bars;
      const m = deriveConstituentMeta(bars, session);
      if (m) constituents[sym] = m;
    }

    const composite = buildCompositeCandlesFromBars({ barsBySymbol });

    const candles = composite.candles
      .map((b) => {
        const time = Date.parse(b.t);
        if (!Number.isFinite(time)) return null;
        return {
          time,
          open: b.o,
          high: b.h,
          low: b.l,
          close: b.c,
          volume: b.v,
        };
      })
      .filter(Boolean);

    return NextResponse.json({
      ok: true,
      source: "alpaca_rest",
      target: "WATCHLIST_COMPOSITE",
      watchlistKey,
      ownerUserId,
      timeframe,
      session,
      range: { start: startIso, end: endIso },
      candles,
      meta: { constituents },
    });
  } catch (e: any) {
    return jsonError(500, "INTERNAL_ERROR", e?.message ?? String(e));
  }
}