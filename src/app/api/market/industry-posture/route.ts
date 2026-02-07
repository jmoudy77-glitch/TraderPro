// src/app/api/market/industry-posture/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { LOCAL_WATCHLISTS } from "@/lib/watchlists/local-watchlists";

type RelToIndex = "OUTPERFORM" | "INLINE" | "UNDERPERFORM";
type Trend5d = "UP" | "FLAT" | "DOWN";

type IndustryPostureItem = {
  industryCode: string;
  industryAbbrev: string;

  // Existing summary signals (kept for now)
  dayChangePct: number;
  volRel: number; // 0..1, midpoint at 0.5
  trend5d: Trend5d;
  relToIndex: RelToIndex;

  // New posture card contract
  // Header summary (5 trading sessions cumulative, close-to-close)
  pct5d?: number;

  // Body daily rotation memory (last 10 trading sessions)
  // One entry per day: raw daily % change (NOT relative-to-index)
  rotation10d?: number[];

  // Daily volumes aligned to rotation10d (one entry per day)
  volumes10d?: number[];

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



function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  if (!serviceKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

// Parse DB ts field to ms reliably, normalizing common Postgres output.
function parseDbTsToMs(tRaw: any): number {
  if (tRaw == null) return NaN;
  if (typeof tRaw === "number") return tRaw;

  let s = String(tRaw).trim();
  if (!s) return NaN;

  // Common Postgres text output: "YYYY-MM-DD HH:MM:SS+00" (not ISO).
  // Normalize to ISO 8601 so Date.parse is reliable.
  if (s.includes(" ") && !s.includes("T")) s = s.replace(" ", "T");

  // Normalize timezone offsets like "+00" -> "+00:00"
  if (/\+[0-9]{2}$/.test(s)) s = `${s}:00`;

  // If it ends with "+00:00" we can also safely normalize to "Z".
  if (s.endsWith("+00:00")) s = s.slice(0, -6) + "Z";

  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : NaN;
}

// Helper to fetch daily candle series from the DB, using flexible column projections.
async function fetchDbDailySeries(params: {
  supabase: any;
  symbols: string[];
  startIso: string;
}): Promise<Record<string, { time: number; close: number; volume?: number; dayKey?: string }[]>> {
  const symbols = Array.from(new Set((params.symbols ?? []).map(normalizeSymbol).filter(Boolean)));
  if (symbols.length === 0) return {};

  // Use canonical projections matching candle-row shape elsewhere in the repo.
  const projections = [
    "symbol, ts, ny_trade_day, c, v",
    "symbol, ts, ny_trade_day, close, volume",
    "symbol, ts, ny_trade_day, c, volume",
    "symbol, ts, ny_trade_day, close, v",
    "symbol, ts, ny_trade_day, c",
    "symbol, ts, ny_trade_day, close",
    "symbol, ts, ny_trade_day, c, v, o, h, l",
    "symbol, ts, ny_trade_day, open, high, low, close, volume",
  ];

  let rows: any[] | null = null;
  let lastErr: any = null;

  for (const sel of projections) {
    const startDayKey = String(params.startIso ?? "").slice(0, 10);

    let q = params.supabase
      .from("candles_daily")
      .select(sel)
      .in("symbol", symbols);

    // Prefer ny_trade_day filtering when available; it is stable and indexable.
    if (startDayKey && startDayKey.length === 10) {
      q = q.gte("ny_trade_day", startDayKey);
    }

    // Deterministic ordering: first by NY trading day, then by timestamp.
    q = q.order("ny_trade_day", { ascending: true }).order("ts", { ascending: true });

    const { data, error } = await q;
    if (!error) {
      rows = (data ?? []) as any[];
      lastErr = null;
      break;
    }
    lastErr = error;
  }

  if (lastErr) throw new Error(lastErr.message ?? String(lastErr));
  if (!rows) return {};

  const startMs = Date.parse(params.startIso);

  const out: Record<string, { time: number; close: number; volume?: number; dayKey?: string }[]> = {};

  // Daily vendor feeds can sometimes emit duplicate “next-day” bars (e.g., holiday-labeled rows)
  // that repeat the same close/volume as the subsequent real session. Guard by dropping near-duplicates
  // on consecutive rows per symbol.
  const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;
  const lastBySym = new Map<string, { close: number; volume: number; time: number; dayKey?: string }>();

  for (const r of rows) {
    const sym = normalizeSymbol(r.symbol);
    if (!sym) continue;

    let dayKey = coerceDayKey(r.ny_trade_day);

    const timeFromTs = parseDbTsToMs(r.ts ?? null);

    // If ny_trade_day is missing/unusable, derive the session key from the timestamp in NY.
    if (!dayKey && Number.isFinite(timeFromTs)) {
      dayKey = dayKeyNyFromMs(timeFromTs);
    }

    // If ts is not reliably parseable, anchor the candle time to the NY trading day.
    // Use a midday UTC anchor so it is stable across DST and safe for ordering.
    const time = Number.isFinite(timeFromTs)
      ? timeFromTs
      : dayKey
      ? Date.parse(`${dayKey}T12:00:00Z`)
      : NaN;

    const cRaw = r.close ?? r.c ?? null;
    const close = Number(cRaw);

    const vRaw = r.volume ?? r.v ?? null;
    const volumeNum = Number(vRaw);
    const volume = Number.isFinite(volumeNum) ? volumeNum : undefined;

    if (!Number.isFinite(time) || !Number.isFinite(close)) continue;
    if (Number.isFinite(startMs) && Number.isFinite(time) && time < startMs) continue;

    // Drop consecutive near-duplicate daily rows for the same symbol.
    // Empirically, these show up as holiday-labeled bars that repeat the next session’s close/volume.
    if (volume != null && volume > 0) {
      const prev = lastBySym.get(sym);
      if (
        prev &&
        Number.isFinite(prev.close) &&
        Number.isFinite(prev.volume) &&
        Number.isFinite(prev.time) &&
        time > prev.time &&
        near(close, prev.close, 0.001) &&
        near(volume, prev.volume, 2000)
      ) {
        // Skip this duplicate row (keep the first occurrence).
        continue;
      }
    }

    lastBySym.set(sym, { close, volume: volume ?? NaN, time, dayKey });
    (out[sym] ||= []).push({ time, close, volume, dayKey });
  }

  for (const sym of Object.keys(out)) {
    out[sym].sort((a, b) => a.time - b.time);
  }

  return out;
}


function normalizeSymbol(s: string): string {
  return String(s ?? "")
    .trim()
    .toUpperCase();
}

function coerceDayKey(v: any): string | undefined {
  if (v == null) return undefined;

  // If it's already a string (date or timestamp), take YYYY-MM-DD.
  if (typeof v === "string") {
    const s = v.trim();
    return s.length >= 10 ? s.slice(0, 10) : undefined;
  }

  // If it's a Date object, normalize.
  if (v instanceof Date) return v.toISOString().slice(0, 10);

  // Best-effort stringify for other shapes (some clients return date-ish objects)
  const s = String(v).trim();
  return s.length >= 10 ? s.slice(0, 10) : undefined;
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


function dayKeyNyFromMs(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function dayKeyUtcFromMs(ms: number): string {
  // Use UTC date to avoid accidental day-shift when ts is stored at 00:00Z.
  // This is only a fallback when ny_trade_day is missing.
  if (!Number.isFinite(ms)) return "0000-00-00";
  return new Date(ms).toISOString().slice(0, 10);
}


function isWeekdayNyFromMs(ms: number): boolean {
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(new Date(ms));
  return wd !== "Sat" && wd !== "Sun";
}

function isWeekdayNyDayKey(dayKey: string): boolean {
  // Interpret the YYYY-MM-DD key as a New York calendar day.
  // Use a midday UTC anchor so NY weekday formatting is stable across DST.
  const ms = Date.parse(`${dayKey}T12:00:00Z`);
  if (!Number.isFinite(ms)) return true;
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(new Date(ms));
  return wd !== "Sat" && wd !== "Sun";
}

// --- NYSE trading calendar helpers (holiday exclusion) ---

function parseDayKey(dayKey: string): { y: number; m: number; d: number } | null {
  if (!dayKey || dayKey.length < 10) return null;
  const y = Number(dayKey.slice(0, 4));
  const m = Number(dayKey.slice(5, 7));
  const d = Number(dayKey.slice(8, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dayKeyFromYmd(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function dowNyForYmd(y: number, m: number, d: number): number {
  // 0=Sun..6=Sat in NY context. Use midday UTC anchor for DST stability.
  const ms = Date.parse(`${y}-${pad2(m)}-${pad2(d)}T12:00:00Z`);
  if (!Number.isFinite(ms)) return 0;
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(new Date(ms));
  if (wd === "Sun") return 0;
  if (wd === "Mon") return 1;
  if (wd === "Tue") return 2;
  if (wd === "Wed") return 3;
  if (wd === "Thu") return 4;
  if (wd === "Fri") return 5;
  return 6;
}

function isWeekendNyDayKey(dayKey: string): boolean {
  const p = parseDayKey(dayKey);
  if (!p) return false;
  const dow = dowNyForYmd(p.y, p.m, p.d);
  return dow === 0 || dow === 6;
}

function nthWeekdayOfMonth(y: number, m: number, dow: number, nth: number): number {
  // dow: 0=Sun..6=Sat, nth: 1..5
  let count = 0;
  for (let d = 1; d <= 31; d++) {
    const ms = Date.parse(`${y}-${pad2(m)}-${pad2(d)}T12:00:00Z`);
    if (!Number.isFinite(ms)) break;
    const dt = new Date(ms);
    // Stop if month rolled
    const mm = Number(dt.toISOString().slice(5, 7));
    if (mm !== m) break;

    const wd = dowNyForYmd(y, m, d);
    if (wd === dow) {
      count += 1;
      if (count === nth) return d;
    }
  }
  return 0;
}

function lastWeekdayOfMonth(y: number, m: number, dow: number): number {
  let last = 0;
  for (let d = 1; d <= 31; d++) {
    const ms = Date.parse(`${y}-${pad2(m)}-${pad2(d)}T12:00:00Z`);
    if (!Number.isFinite(ms)) break;
    const dt = new Date(ms);
    const mm = Number(dt.toISOString().slice(5, 7));
    if (mm !== m) break;

    const wd = dowNyForYmd(y, m, d);
    if (wd === dow) last = d;
  }
  return last;
}

function easterSundayYmd(year: number): { y: number; m: number; d: number } {
  // Anonymous Gregorian algorithm (Meeus/Jones/Butcher)
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { y: year, m: month, d: day };
}

function addDaysYmd(y: number, m: number, d: number, delta: number): { y: number; m: number; d: number } {
  const ms = Date.parse(`${y}-${pad2(m)}-${pad2(d)}T12:00:00Z`);
  const out = new Date(ms + delta * 24 * 60 * 60 * 1000);
  return {
    y: Number(out.toISOString().slice(0, 4)),
    m: Number(out.toISOString().slice(5, 7)),
    d: Number(out.toISOString().slice(8, 10)),
  };
}

function observedFixedHolidayYmd(y: number, m: number, d: number): { y: number; m: number; d: number } {
  // If holiday falls on Sat -> observed Fri; Sun -> observed Mon.
  const dow = dowNyForYmd(y, m, d);
  if (dow === 6) return addDaysYmd(y, m, d, -1);
  if (dow === 0) return addDaysYmd(y, m, d, 1);
  return { y, m, d };
}

function isNyseHolidayDayKey(dayKey: string): boolean {
  const p = parseDayKey(dayKey);
  if (!p) return false;
  const { y, m, d } = p;
  if (isWeekendNyDayKey(dayKey)) return true;

  const candidates = new Set<string>();

  // New Year's Day (Jan 1)
  {
    const ob = observedFixedHolidayYmd(y, 1, 1);
    candidates.add(dayKeyFromYmd(ob.y, ob.m, ob.d));
  }

  // Martin Luther King Jr. Day (3rd Monday in Jan)
  {
    const dd = nthWeekdayOfMonth(y, 1, 1, 3);
    if (dd) candidates.add(dayKeyFromYmd(y, 1, dd));
  }

  // Washington's Birthday / Presidents Day (3rd Monday in Feb)
  {
    const dd = nthWeekdayOfMonth(y, 2, 1, 3);
    if (dd) candidates.add(dayKeyFromYmd(y, 2, dd));
  }

  // Good Friday (2 days before Easter Sunday)
  {
    const easter = easterSundayYmd(y);
    const gf = addDaysYmd(easter.y, easter.m, easter.d, -2);
    candidates.add(dayKeyFromYmd(gf.y, gf.m, gf.d));
  }

  // Memorial Day (last Monday in May)
  {
    const dd = lastWeekdayOfMonth(y, 5, 1);
    if (dd) candidates.add(dayKeyFromYmd(y, 5, dd));
  }

  // Juneteenth (June 19) - NYSE holiday since 2022
  {
    const ob = observedFixedHolidayYmd(y, 6, 19);
    candidates.add(dayKeyFromYmd(ob.y, ob.m, ob.d));
  }

  // Independence Day (July 4)
  {
    const ob = observedFixedHolidayYmd(y, 7, 4);
    candidates.add(dayKeyFromYmd(ob.y, ob.m, ob.d));
  }

  // Labor Day (1st Monday in Sep)
  {
    const dd = nthWeekdayOfMonth(y, 9, 1, 1);
    if (dd) candidates.add(dayKeyFromYmd(y, 9, dd));
  }

  // Thanksgiving Day (4th Thursday in Nov)
  {
    const dd = nthWeekdayOfMonth(y, 11, 4, 4);
    if (dd) candidates.add(dayKeyFromYmd(y, 11, dd));
  }

  // Christmas Day (Dec 25)
  {
    const ob = observedFixedHolidayYmd(y, 12, 25);
    candidates.add(dayKeyFromYmd(ob.y, ob.m, ob.d));
  }

  return candidates.has(dayKey);
}

function buildLastNQqqSessionKeys(
  qqqSeries: { time: number; dayKey?: string }[],
  n: number
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();

  for (let i = qqqSeries.length - 1; i >= 0; i--) {
    const row = qqqSeries[i];
    const k =
      coerceDayKey((row as any)?.dayKey) ??
      (Number.isFinite((row as any)?.time) ? dayKeyNyFromMs((row as any).time) : null);

    if (!k || seen.has(k) || !isWeekdayNyDayKey(k) || isNyseHolidayDayKey(k)) continue;
    seen.add(k);
    keys.push(k);
    if (keys.length >= n) break;
  }

  return keys.reverse();
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

function computeRotation10dFromCloses(closes11: number[]): number[] | null {
  if (!Array.isArray(closes11) || closes11.length < 11) return null;
  const out: number[] = [];
  for (let i = 1; i < 11; i++) {
    const prev = closes11[i - 1];
    const cur = closes11[i];
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev === 0) return null;
    out.push(((cur - prev) / prev) * 100);
  }
  return out.slice(-10);
}

function computePct5dFromCloses(closes: number[]): number | null {
  // Need at least 6 closes: t vs t-5
  if (!Array.isArray(closes) || closes.length < 6) return null;
  const last = closes[closes.length - 1];
  const prev5 = closes[closes.length - 6];
  if (!Number.isFinite(last) || !Number.isFinite(prev5) || prev5 === 0) return null;
  return ((last - prev5) / prev5) * 100;
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

    const ownerUserId =
      searchParams.get("ownerUserId") ||
      process.env.TRADERPRO_DEV_OWNER_USER_ID ||
      null;
    const watchlistKey = searchParams.get("watchlistKey"); // optional narrowing
    const scheduler = qpBool(searchParams.get("scheduler"));
    const cacheOnly = qpBool(searchParams.get("cacheOnly"));
    const debug = qpBool(searchParams.get("debug"));

    if (!ownerUserId) {
      return NextResponse.json({ ok: false, error: "MISSING_OWNER_USER_ID" }, { status: 400 });
    }

    const ttlMs = Number(process.env.INDUSTRY_POSTURE_TTL_MS ?? "60000");
    // NOTE: cache key must include request-affecting flags; otherwise cacheOnly/scheduler calls can replay non-stub results.
    const cacheKey = `industry-posture:v2:${todayKeyNy()}:${ownerUserId}:${watchlistKey ?? "ALL"}:cacheOnly=${cacheOnly ? "1" : "0"}:scheduler=${scheduler ? "1" : "0"}:debug=${debug ? "1" : "0"}`;

    const cached = cacheGet<any>(cacheKey);
    if (cached) return NextResponse.json(cached);

    const inflight = INFLIGHT.get(cacheKey);
    if (inflight) return NextResponse.json(await inflight);


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
      // 3) Daily series fetch (DB truth)
      // -----------------------------
      const indexSymbol = "QQQ";
      const symbolsForProvider = Array.from(
        new Set([indexSymbol, ...Array.from(byIndustry.values()).flatMap((v) => v.symbols)])
      );

      // If cacheOnly: return classification-only posture stubs
      if (cacheOnly) {
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

        return {
          ok: true,
          items,
          ...(debug
            ? {
                debug: {
                  mode: "cacheOnly",
                  byIndustry: Object.fromEntries(
                    Array.from(byIndustry.entries()).map(([code, v]) => [
                      code,
                      {
                        symbolsTotal: v.symbols.length,
                      },
                    ])
                  ),
                },
              }
            : {}),
        };
      }

      let seriesBySymbol: Record<string, any[]> = {};
      try {
        // DB lookback window ~60 calendar days to ensure enough sessions.
        const end = new Date();
        const start = new Date(end.getTime() - 60 * 24 * 60 * 60 * 1000);

        seriesBySymbol = await fetchDbDailySeries({
          supabase,
          symbols: symbolsForProvider,
          startIso: start.toISOString(),
        });
      } catch (e: any) {
        const msg = String(e?.message ?? "DB candles_daily fetch error");

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

      const qqqSeries = (seriesBySymbol[indexSymbol] ?? [])
        .slice()
        .sort((a, b) => a.time - b.time);
      const indexDayPct = computeDayChangePct(qqqSeries) ?? 0;

      // -----------------------------
      // 4) Aggregate posture per industry (equal-weight dayChangePct)
      // -----------------------------
      const items: IndustryPostureItem[] = [];
      const debugByIndustry: Record<string, any> = {};
      for (const [industryCode, v] of byIndustry.entries()) {
        const symbols = v.symbols.slice();
        const dbg = {
          industryAbbrev: v.abbrev,
          symbolsTotal: symbols.length,
          symbolsWithSeriesGE2: 0,
          symbolsWithSeriesGE6: 0,
          symbolsWithSeriesGE11: 0,
          qqqSeriesLen: qqqSeries.length,
          qqqKeys11Len: 0,
          finitePairsLen: 0,
          tailClosesLen: 0,
          rotationComputed: false,
          volumesComputed: false,
          missingSessionKeys: [] as string[],
          missingRotationPairs: [] as string[],
        };

        // Use QQQ as the session calendar anchor.
        // We derive the last 11 trading-session keys from durable DB candles.
        const qqqKeys11 = buildLastNQqqSessionKeys(qqqSeries, 11);
        dbg.qqqKeys11Len = qqqKeys11.length;

        const perSymbolDayPct: number[] = [];
        const perSymbolTrend: Trend5d[] = [];

        // Build per-symbol maps keyed by NY trading day.
        const bySymDay = new Map<string, Map<string, { time: number; close: number; volume: number }>>();

        for (const s of symbols) {
          const series = (seriesBySymbol[s] ?? []).slice().sort((a, b) => a.time - b.time);
          // coverage stats
          if (series.length >= 2) dbg.symbolsWithSeriesGE2 += 1;
          if (series.length >= 6) dbg.symbolsWithSeriesGE6 += 1;
          if (series.length >= 11) dbg.symbolsWithSeriesGE11 += 1;
          if (series.length < 2) continue;

          const dayPct = computeDayChangePct(series);
          if (dayPct != null) perSymbolDayPct.push(dayPct);

          perSymbolTrend.push(computeTrend5d(series));

          const m = new Map<string, { time: number; close: number; volume: number }>();
          for (const c of series) {
            const t = Number(c.time);
            const k = coerceDayKey((c as any).dayKey) ?? dayKeyNyFromMs(t);
            const close = Number(c.close);
            const vol = Number.isFinite(Number(c.volume)) ? Number(c.volume) : 0;
            if (!k || !Number.isFinite(t) || !Number.isFinite(close)) continue;

            const prev = m.get(k);
            // Keep the latest ts for that NY day
            if (!prev || t > prev.time) {
              m.set(k, { time: t, close, volume: vol });
            }
          }
          bySymDay.set(s, m);
        }

        if (perSymbolDayPct.length === 0) continue;

        // Compute daily % rotation and daily volumes aligned to the QQQ session calendar.
        // IMPORTANT: Do NOT compute rotation from averaged raw closes.
        // That breaks equal-weight behavior when constituents have different price scales.
        // Instead, compute per-symbol daily % changes and then equal-weight average them per day.

        // Gather closes+volumes per session for the industry.
        // For each session key, we keep the latest close for that day (already enforced in bySymDay maps).
        const closesByKey: Record<string, number[]> = {};
        const volsByKey: Record<string, number> = {};

        for (const k of qqqKeys11) {
          const closes: number[] = [];
          let volSum = 0;

          for (const s of symbols) {
            const m = bySymDay.get(s);
            const row = m?.get(k);
            if (!row) continue;
            if (Number.isFinite(row.close)) closes.push(row.close);
            if (Number.isFinite(row.volume)) volSum += row.volume;
          }

          closesByKey[k] = closes;
          volsByKey[k] = volSum;
        }

        // Compute 10 daily rotation values from 11 session keys.
        // For day i (1..10), compute each symbol's pct change vs prior day if both closes exist,
        // then equal-weight avg across the valid symbols.
        const rotation10dArr: number[] = [];
        const volumes10dArr: number[] = [];

        // Compute debug.missingSessionKeys once per industry, after qqqKeys11 and bySymDay are built.
        if (debug) {
          const missing: string[] = [];
          for (const k of qqqKeys11) {
            let hasAny = false;
            for (const s of symbols) {
              const m = bySymDay.get(s);
              if (m?.has(k)) {
                hasAny = true;
                break;
              }
            }
            if (!hasAny) missing.push(k);
          }
          dbg.missingSessionKeys = missing;
        }

        for (let i = 1; i < qqqKeys11.length; i++) {
          const kPrev = qqqKeys11[i - 1];
          const kCur = qqqKeys11[i];
          // Build per-symbol maps for this pair.
          const dayPcts: number[] = [];
          let volSum = 0;

          for (const s of symbols) {
            const m = bySymDay.get(s);
            const prev = m?.get(kPrev);
            const cur = m?.get(kCur);
            if (!prev || !cur) continue;

            const prevClose = Number(prev.close);
            const curClose = Number(cur.close);
            if (!Number.isFinite(prevClose) || !Number.isFinite(curClose) || prevClose === 0) continue;

            dayPcts.push(((curClose - prevClose) / prevClose) * 100);

            const v = Number(cur.volume);
            if (Number.isFinite(v)) volSum += v;
          }

          if (dayPcts.length === 0) {
            // No valid rotation for this day; keep alignment but mark as NaN.
            rotation10dArr.push(NaN);
            volumes10dArr.push(volSum);
            if (debug) {
              dbg.missingRotationPairs.push(`${kPrev}->${kCur}`);
            }
          } else {
            rotation10dArr.push(avg(dayPcts));
            volumes10dArr.push(volSum);
          }
        }

        // Keep only the last 10 values (should already be 10 if qqqKeys11 has 11 keys).
        const rotation10d = rotation10dArr
          .slice(-10)
          .map((v) => (Number.isFinite(v) ? v : NaN));

        const volumes10d = volumes10dArr.slice(-10);

        // pct5d is a 5-trading-session cumulative close-to-close summary.
        // Derive from the last 5 daily rotation values (compounded).
        let pct5d: number | null = null;
        const last5 = rotation10d.filter((v) => Number.isFinite(v)).slice(-5);
        if (last5.length === 5) {
          let mult = 1;
          for (const p of last5) mult *= 1 + p / 100;
          pct5d = (mult - 1) * 100;
        }

        // Debug coverage: how many of the 10 rotation days are finite.
        const finiteRotationDays = rotation10d.filter((v) => Number.isFinite(v)).length;
        dbg.finitePairsLen = finiteRotationDays;
        dbg.tailClosesLen = qqqKeys11.length;

        dbg.rotationComputed = finiteRotationDays === 10;
        dbg.volumesComputed = Array.isArray(volumes10d) && volumes10d.length === 10;

        // Summary signals remain as before, but prefer composite-derived values when available.
        const lastFiniteRotation = [...(rotation10d ?? [])].reverse().find((v) => Number.isFinite(v)) as number | undefined;
        const dayChangePct = Number.isFinite(lastFiniteRotation as any) ? (lastFiniteRotation as number) : avg(perSymbolDayPct);

        // Trend = majority vote (UP vs DOWN), else FLAT
        const up = perSymbolTrend.filter((t) => t === "UP").length;
        const down = perSymbolTrend.filter((t) => t === "DOWN").length;
        const trend5d: Trend5d =
          up > down && up > 0 ? "UP" : down > up && down > 0 ? "DOWN" : "FLAT";

        // Volume ratio: today vs avg of prior up to 5 sessions (excluding today), derived from aligned daily volumes.
        const todayVol = Number.isFinite(volumes10d[volumes10d.length - 1]) ? volumes10d[volumes10d.length - 1] : 0;
        const priorVols = volumes10d.slice(0, -1).slice(-5).filter((v) => Number.isFinite(v) && v > 0);
        const baselineVol = avg(priorVols);
        const volRatio = baselineVol > 0 ? todayVol / baselineVol : 1;
        const volRel = volRelFromRatio(volRatio);

        const relToIndex = relToIndexFromDelta(dayChangePct - indexDayPct);

        if (debug) {
          debugByIndustry[industryCode] = dbg;
        }
        items.push({
          industryCode,
          industryAbbrev: v.abbrev,
          dayChangePct,
          volRel,
          trend5d,
          relToIndex,
          pct5d: Number.isFinite(pct5d as any) ? (pct5d as number) : undefined,
          rotation10d: rotation10d ?? undefined,
          volumes10d: volumes10d ? volumes10d : undefined,
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

      return {
        ok: true,
        items,
        ...(debug
          ? {
              debug: {
                mode: "computed",
                asOf: new Date().toISOString(),
                indexSymbol: "QQQ",
                qqqSeriesLen: qqqSeries.length,
                byIndustry: debugByIndustry,
              },
            }
          : {}),
      };
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