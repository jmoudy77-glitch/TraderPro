import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Contract: 30 trading days of 1D close->close % change (ratio) for each symbol + industry median.

type RotationSparklinePoint = { d: string; pct: number | null };

type OkResponse = {
  ok: true;
  meta: {
    industryCode: string;
    symbols: string[];
    days: number;
    calendar: "trading_days";
    metric: "daily_pct_change";
    unit: "ratio";
    timezone: "America/New_York";
    asOfDay: string;
  };
  axis: { days: string[] };
  industry: { method: "median"; points: RotationSparklinePoint[] };
  seriesBySymbol: Record<string, { points: RotationSparklinePoint[]; coverage: number }>;
  scale?: { yMin: number; yMax: number; method: "p05_p95" };
};

function json(body: any, status = 200) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function uniqUpper(list: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    const sym = String(s || "").trim().toUpperCase();
    if (!sym) continue;
    if (seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  return out;
}

function median(nums: number[]) {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 === 0 ? (a[mid - 1] + a[mid]) / 2 : a[mid];
}

function pctChange(prev: number, cur: number) {
  if (!Number.isFinite(prev) || prev === 0) return null;
  if (!Number.isFinite(cur)) return null;
  return (cur - prev) / prev;
}

function percentile(sortedAsc: number[], p: number) {
  if (!sortedAsc.length) return null;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const w = idx - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`MISSING_ENV_${name}`);
  return v;
}

async function loadDailyClosesFromDb(_ownerUserId: string, symbols: string[]) {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const perSymbol = 40;
  const fetchLimit = 50; // buffer beyond 30 trading days

  // IMPORTANT: PostgREST applies `.limit()` to the whole result set, not per-symbol.
  // Fetch per symbol to guarantee coverage when multiple symbols are requested.
  const data: Array<{ symbol: string; ts: string; c: number }> = [];

  for (const sym of symbols) {
    const { data: rows, error } = await supabase
      .from("symbol_eod")
      .select("trade_date, close")
      .eq("symbol", sym)
      .order("trade_date", { ascending: false })
      .limit(fetchLimit);

    if (error) throw new Error(`SUPABASE_${error.code || "QUERY_ERROR"}_${error.message}`);

    for (const r of (rows ?? []) as any[]) {
      const d = String((r as any).trade_date);
      const rawClose = (r as any).close;

      const c =
        typeof rawClose === "number"
          ? rawClose
          : typeof rawClose === "string"
            ? parseFloat(rawClose)
            : parseFloat(String(rawClose));

      if (!d) continue;
      if (!Number.isFinite(c)) continue;

      // `symbol_eod.trade_date` is session-based (no weekends/holidays)
      data.push({ symbol: sym, ts: d, c });
    }
  }

  const out: Record<string, Array<{ d: string; c: number }>> = {};
  for (const sym of symbols) out[sym] = [];

  // Group and keep only latest perSymbol rows, then normalize to NY day and dedupe by day.
  const seenDayBySymbol = new Map<string, Set<string>>();
  for (const sym of symbols) seenDayBySymbol.set(sym, new Set());

  const counts = new Map<string, number>();

  for (const row of data ?? []) {
    const sym = String((row as any).symbol ?? "").toUpperCase();
    if (!out[sym]) continue;

    const ts = (row as any).ts as string;
    const c = (row as any).c as number;

    if (typeof ts !== "string") continue;
    if (typeof c !== "number" || !Number.isFinite(c)) continue;

    const n = counts.get(sym) ?? 0;
    if (n >= perSymbol) continue;

    const d = ts;
    const seen = seenDayBySymbol.get(sym)!;
    if (seen.has(d)) continue; // ensure one close per day

    seen.add(d);
    out[sym].push({ d, c });
    counts.set(sym, n + 1);
  }

  // Each symbol series must be ascending by day for downstream logic.
  for (const sym of Object.keys(out)) {
    out[sym].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  }

  return out;
}

export async function GET(req: Request) {
  const url = new URL(req.url);

  const industryCode = String(url.searchParams.get("industryCode") || "").trim().toUpperCase();
  if (!industryCode) {
    return json({ ok: false, error: { code: "MISSING_INDUSTRY_CODE" } }, 200);
  }

  const rawSymbols = String(url.searchParams.get("symbols") || "");
  const symbols = uniqUpper(
    rawSymbols
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  if (!symbols.length) {
    return json({ ok: false, error: { code: "MISSING_SYMBOLS" } }, 200);
  }

  // Align with your dev auth pattern (same as industry-posture route now).
  const ownerUserId =
    url.searchParams.get("ownerUserId") ||
    process.env.TRADERPRO_DEV_OWNER_USER_ID ||
    null;

  if (!ownerUserId) {
    return json({ ok: false, error: { code: "MISSING_OWNER_USER_ID" } }, 200);
  }

  const DAYS = 30;

  let closesBySymbol: Record<string, Array<{ d: string; c: number }>>;
  try {
    closesBySymbol = await loadDailyClosesFromDb(ownerUserId, symbols);
  } catch (e: any) {
    return json(
      {
        ok: false,
        error: {
          code: "DAILY_CLOSES_UNAVAILABLE",
          message: String(e?.message || e || "unknown"),
        },
      },
      200
    );
  }

  // Build shared axis: union of all days, take last <=30 days, ascending.
  const daySet = new Set<string>();
  for (const sym of symbols) {
    const rows = Array.isArray(closesBySymbol?.[sym]) ? closesBySymbol[sym] : [];
    for (const r of rows) daySet.add(r.d);
  }
  const axisDays = Array.from(daySet).sort(); // YYYY-MM-DD lex sort ok
  const axis = axisDays.slice(-DAYS);

  const seriesBySymbol: OkResponse["seriesBySymbol"] = {};

  // Collect all pct values for optional scale band.
  const allPct: number[] = [];

  // Build each symbol series aligned to axis.
  for (const sym of symbols) {
    const rows = Array.isArray(closesBySymbol?.[sym]) ? closesBySymbol[sym] : [];
    const closeByDay = new Map<string, number>();
    for (const r of rows) {
      if (typeof r?.d === "string" && typeof r?.c === "number" && Number.isFinite(r.c)) {
        closeByDay.set(r.d, r.c);
      }
    }

    const points: RotationSparklinePoint[] = [];
    let nonNull = 0;

    // pctChange is based on the symbol's own previous close, not axis position
    let prevClose: number | null = null;
    for (let i = 0; i < axis.length; i++) {
      const d = axis[i];
      const c = closeByDay.get(d);

      if (c == null) {
        points.push({ d, pct: null });
        continue;
      }

      const pct = prevClose == null ? null : pctChange(prevClose, c);
      points.push({ d, pct });

      if (pct != null) {
        nonNull++;
        allPct.push(pct);
      }

      // IMPORTANT: only advance prevClose when this symbol has data for the day
      prevClose = c;
    }

    seriesBySymbol[sym] = {
      points,
      coverage: axis.length ? nonNull / axis.length : 0,
    };
  }

  // Industry aggregate: median across symbols per day index.
  const industryPoints: RotationSparklinePoint[] = axis.map((d, idx) => {
    const vals: number[] = [];
    for (const sym of symbols) {
      const p = seriesBySymbol[sym]?.points?.[idx]?.pct;
      if (typeof p === "number" && Number.isFinite(p)) vals.push(p);
    }
    const m = median(vals);
    return { d, pct: m == null ? null : m };
  });

  const asOfDay = axis.length ? axis[axis.length - 1] : "";

  // Optional robust scale band (p05–p95 across all non-null pct points).
  let scale: OkResponse["scale"] | undefined = undefined;
  if (allPct.length >= 10) {
    const sorted = [...allPct].sort((a, b) => a - b);
    const p05 = percentile(sorted, 0.05);
    const p95 = percentile(sorted, 0.95);
    if (p05 != null && p95 != null && p05 !== p95) {
      scale = { yMin: p05, yMax: p95, method: "p05_p95" };
    }
  }

  const out: OkResponse = {
    ok: true,
    meta: {
      industryCode,
      symbols,
      days: DAYS,
      calendar: "trading_days",
      metric: "daily_pct_change",
      unit: "ratio",
      timezone: "America/New_York",
      asOfDay,
    },
    axis: { days: axis },
    industry: { method: "median", points: industryPoints },
    seriesBySymbol,
    ...(scale ? { scale } : {}),
  };

  return json(out, 200);
}