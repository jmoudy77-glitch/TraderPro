import { NextResponse } from "next/server";

const TIMEOUT_MS = 6500;

function jsonResponse(body: unknown, status = 200) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

type CandleLike = {
  t?: number | string;
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

function candleClose(c: CandleLike): number | null {
  const v = c.c ?? c.close ?? null;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function candleVol(c: CandleLike): number | null {
  const v = c.v ?? c.volume ?? null;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pct(a: number, b: number): number {
  if (!Number.isFinite(a) || a === 0) return 0;
  return (b - a) / a;
}

async function fetchSymbolBars(req: Request, symbol: string, res: "5m" | "15m", limit: number) {
  const params = new URLSearchParams();
  params.set("target", "SYMBOL");
  params.set("symbol", symbol);
  params.set("range", "1D");
  params.set("res", res);
  // Industry pressure is intended for regular-session monitoring.
  params.set("session", "regular");

  const url = new URL(req.url);
  const origin = url.origin;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(`${origin}/api/market/candles/window?${params.toString()}`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });

    const text = await r.text();
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

type IndustryReq = { industryCode: string; symbols: string[] };

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: { code: "BAD_JSON", message: "Invalid JSON body" } }, 200);
  }

  const resRaw = String(body?.res ?? "5m").toLowerCase();
  const res: "5m" | "15m" = resRaw === "15m" ? "15m" : "5m";

  const industries: IndustryReq[] = Array.isArray(body?.industries) ? body.industries : [];
  if (!industries.length) {
    return jsonResponse({ ok: false, error: { code: "MISSING_INDUSTRIES", message: "No industries provided" } }, 200);
  }

  const baselineWindows = 20;
  // Need last bar (now) + prior bar (return) + baseline windows for volume baseline
  const limit = baselineWindows + 2;

  // Sensible thresholds (tunable later)
  const eps = res === "15m" ? 0.00035 : 0.00025; // deadband
  const theta = res === "15m" ? 0.0075 : 0.006;  // strength normalization

  const byIndustry: Record<
    string,
    { dir: "UP" | "DOWN" | "FLAT"; mag: number; symbolsOk: number; symbolsTotal: number }
  > = {};

  const errors: Array<{ industryCode: string; symbol?: string; code: string; message?: string }> = [];

  // De-dupe industries by code (last one wins)
  const uniqIndustries = new Map<string, IndustryReq>();
  for (const it of industries) {
    const code = String(it?.industryCode ?? "").trim().toUpperCase();
    const symbols = Array.isArray(it?.symbols)
      ? it.symbols.map((s: any) => String(s).trim().toUpperCase()).filter(Boolean)
      : [];
    if (!code) continue;
    uniqIndustries.set(code, { industryCode: code, symbols });
  }

  // Collect all unique symbols across industries (cap to keep bounded)
  const allSymbols = Array.from(
    new Set(
      Array.from(uniqIndustries.values())
        .flatMap((x) => x.symbols)
        .filter(Boolean)
    )
  ).slice(0, 400);

  // Fetch once per symbol
  const symToBars = new Map<string, CandleLike[]>();
  await Promise.all(
    allSymbols.map(async (sym) => {
      const payload = await fetchSymbolBars(req, sym, res, limit);

      if (payload?.ok === false) {
        errors.push({ industryCode: "*", symbol: sym, code: payload?.error?.code ?? "UPSTREAM_ERROR", message: payload?.error?.message });
        symToBars.set(sym, []);
        return;
      }

      const candles: CandleLike[] = Array.isArray(payload?.candles) ? payload.candles : [];
      const normalized = candles
        .map((c) => ({ c, t: candleTsMs(c) }))
        .filter((x) => x.t != null)
        .sort((a, b) => (a.t! - b.t!))
        .map((x) => x.c);

      symToBars.set(sym, normalized);
    })
  );

  // Compute pressure per industry
  for (const [industryCode, it] of uniqIndustries.entries()) {
    const symbols = Array.from(new Set(it.symbols)).slice(0, 120);
    const symbolsTotal = symbols.length;

    const pVals: number[] = [];
    let symbolsOk = 0;

    for (const sym of symbols) {
      const bars = symToBars.get(sym) ?? [];
      if (bars.length < 2) {
        continue;
      }

      // Use the last two closes for window return
      const last = bars[bars.length - 1];
      const prev = bars[bars.length - 2];
      const lastClose = candleClose(last);
      const prevClose = candleClose(prev);

      if (lastClose == null || prevClose == null) continue;

      const r = pct(prevClose, lastClose);

      const lastV = candleVol(last);
      const vols = bars
        .slice(Math.max(0, bars.length - (baselineWindows + 1)), bars.length - 1)
        .map((b) => candleVol(b))
        .filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0);

      let rvol = 1;
      const base = vols.length ? median(vols) : null;
      if (base != null && base > 0 && lastV != null && lastV >= 0) {
        rvol = lastV / base;
      }
      rvol = clamp(rvol, 0.25, 4.0);

      // Contribution: r * ln(1 + rvol)
      const p = r * Math.log(1 + rvol);

      if (Number.isFinite(p)) {
        pVals.push(p);
        symbolsOk += 1;
      }
    }

    const P = pVals.length ? median(pVals) : 0;

    let dir: "UP" | "DOWN" | "FLAT" = "FLAT";
    if (Math.abs(P) >= eps) dir = P > 0 ? "UP" : "DOWN";

    const mag = dir === "FLAT" ? 0 : clamp(Math.abs(P) / theta, 0, 1);

    byIndustry[industryCode] = { dir, mag, symbolsOk, symbolsTotal };

    if (symbolsTotal === 0) {
      errors.push({ industryCode, code: "NO_SYMBOLS", message: "No symbols for industry" });
    }
  }

  return jsonResponse({
    ok: true,
    meta: {
      res,
      asOfTs: new Date().toISOString(),
      baselineWindows,
      symbolsRequested: allSymbols.length,
    },
    byIndustry,
    errors,
  });
}