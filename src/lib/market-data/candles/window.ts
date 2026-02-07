// src/lib/market-data/candles/window.ts

export function normalizeRes(resRaw: string | null): string | null {
  if (!resRaw) return null;
  const v = resRaw.trim().toLowerCase();
  if (v === "1min") return "1m";
  if (v === "5min") return "5m";
  if (v === "15min") return "15m";
  if (v === "30min") return "30m";
  if (v === "60min") return "1h";
  if (v === "1hour") return "1h";
  if (v === "4hour") return "4h";
  if (v === "1day") return "1d";
  return v;
}

export function normalizeRange(rangeRaw: string | null): string | null {
  if (!rangeRaw) return null;
  const v = rangeRaw.trim().toUpperCase();
  if (v === "1D") return "1D";
  if (v === "5D") return "5D";
  if (v === "1M") return "1M";
  if (v === "3M") return "3M";
  if (v === "6M") return "6M";
  if (v === "1Y") return "1Y";
  return v;
}

export function isDurableRes(res: string): boolean {
  return res === "1h" || res === "4h" || res === "1d";
}

export function bumpRangeForRes(range: string, res: string): string {
  const r = range.toUpperCase();
  const isIntraday = res.endsWith("m");

  if (r === "1D") {
    if (res === "4h") return "5D";
    if (res === "1d") return "1M";
    return "1D";
  }

  if (r === "5D") {
    if (res === "1d") return "1M";
    if (isIntraday) return "1D";
    return "5D";
  }

  if (r === "1M") {
    if (isIntraday) return "1D";
    if (res === "1h") return "5D";
    return "1M";
  }

  if (r === "3M" || r === "6M" || r === "1Y") {
    if (res === "1d") return r;
    if (res === "4h") return "1M";
    return "1D";
  }

  return r;
}

export function normalizeRangeResPair(range: string, res: string): {
  range: string;
  res: string;
  normalizedFrom?: { range: string; res: string };
} {
  const from = { range, res };

  let r = bumpRangeForRes(range, res);

  const isIntraday = res.endsWith("m");
  const isHour = res === "1h" || res === "4h";
  const isDay = res === "1d";

  const R = r.toUpperCase();
  const ok =
    (R === "1D" && (isIntraday || res === "1h")) ||
    (R === "5D" && isHour) ||
    (R === "1M" && (res === "4h" || isDay)) ||
    ((R === "3M" || R === "6M" || R === "1Y") && isDay);

  if (!ok) {
    if (isDay) r = R === "1D" || R === "5D" ? "1M" : R;
    else if (res === "4h") r = "1M";
    else if (res === "1h") r = "5D";
    else if (isIntraday) r = "1D";
  }

  const changed = r !== from.range;
  return { range: r, res, normalizedFrom: changed ? from : undefined };
}

export function resToMs(res: string): number | null {
  const m = /^(\d+)(m|h|d)$/.exec(res);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit === "m") return n * 60_000;
  if (unit === "h") return n * 3_600_000;
  if (unit === "d") return n * 86_400_000;
  return null;
}

export function rangeToApproxMs(rangeRaw: string): number | null {
  const r = rangeRaw.toUpperCase().trim();
  if (r === "1D") return 24 * 60 * 60_000;
  if (r === "2D") return 2 * 24 * 60 * 60_000;
  if (r === "5D") return 5 * 24 * 60 * 60_000;
  if (r === "1W") return 7 * 24 * 60 * 60_000;
  if (r === "2W") return 14 * 24 * 60 * 60_000;
  if (r === "1M") return 30 * 24 * 60 * 60_000;
  if (r === "3M") return 90 * 24 * 60 * 60_000;
  if (r === "6M") return 180 * 24 * 60 * 60_000;
  if (r === "1Y") return 365 * 24 * 60 * 60_000;
  return null;
}

export function computeExpectedBars(range: string, res: string): number | null {
  const resMs = resToMs(res);
  const rngMs = rangeToApproxMs(range);
  if (!resMs || !rngMs) return null;
  const raw = Math.ceil(rngMs / resMs);
  const capped = Math.min(raw, 50_000);
  return Math.max(0, capped);
}

// --- Canonical window computation ---

export type ComputeWindowInput = {
  range: string;           // normalized range (e.g. 1D, 5D, 1M)
  res: string;             // normalized resolution (e.g. 1m, 5m, 1h)
  session: "regular" | "extended";
  now?: Date;              // defaults to new Date()
  exchangeTz?: string;     // defaults to America/New_York
};

export type ComputedWindow = {
  startISO: string;
  endISO: string;
  expectedBars: number | null;
};

// NOTE:
// - This function is PURE and deterministic.
// - It encodes the canonical session semantics used by candles/window.
// - No fetching, no side effects.
export function computeWindow(input: ComputeWindowInput): ComputedWindow {
  const {
    range,
    res,
    session,
    now = new Date(),
    exchangeTz = "America/New_York",
  } = input;

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: exchangeTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const partsToObj = (d: Date) => {
    const parts = dtf.formatToParts(d);
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    const year = Number(get("year"));
    const month = Number(get("month"));
    const day = Number(get("day"));
    const hour = Number(get("hour"));
    const minute = Number(get("minute"));
    const second = Number(get("second"));
    return { year, month, day, hour, minute, second };
  };

  // Convert an exchange-local wall clock time to a UTC epoch ms.
  // This avoids local-machine timezone parsing and correctly accounts for DST.
  const zonedLocalToUtcMs = (y: number, m: number, d: number, hh: number, mm: number, ss = 0) => {
    // Initial guess: interpret the wall time as if it were UTC.
    const utcGuess = Date.UTC(y, m - 1, d, hh, mm, ss, 0);
    // See what wall time the guess corresponds to in the target timezone.
    const seen = partsToObj(new Date(utcGuess));
    const asIfUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second, 0);
    const offset = asIfUtc - utcGuess;
    return utcGuess - offset;
  };

  const nowMs = now.getTime();
  let endMs = nowMs;

  // Compute start/end based on range + session (UTC instants).
  let startMs: number;

  if (range === "1D") {
    const localNow = partsToObj(now);

    // If we're before premarket open (04:00) in the exchange timezone,
    // anchor the 1D window to the previous trading day.
    // We compute "previous day" using a noon anchor to avoid DST edge cases.
    const isBeforePremarket = localNow.hour < 4;

    let y = localNow.year;
    let mo = localNow.month;
    let da = localNow.day;

    if (isBeforePremarket) {
      const noonUtc = zonedLocalToUtcMs(localNow.year, localNow.month, localNow.day, 12, 0, 0);
      const prevNoonUtc = noonUtc - 24 * 60 * 60 * 1000;
      const prev = partsToObj(new Date(prevNoonUtc));
      y = prev.year;
      mo = prev.month;
      da = prev.day;
    }

    if (session === "extended") {
      // Canon: extended 1D begins at premarket open 04:00 ET.
      startMs = zonedLocalToUtcMs(y, mo, da, 4, 0, 0);
      const sessionEndMs = zonedLocalToUtcMs(y, mo, da, 20, 0, 0);

      if (isBeforePremarket) {
        // Between 20:00 -> 04:00 exchange time: return the most recent full extended window.
        endMs = sessionEndMs;
      } else {
        if (endMs > sessionEndMs) endMs = sessionEndMs;
      }
    } else {
      // Canon: regular 1D begins at 09:30 ET.
      startMs = zonedLocalToUtcMs(y, mo, da, 9, 30, 0);
      const sessionEndMs = zonedLocalToUtcMs(y, mo, da, 16, 0, 0);

      if (isBeforePremarket) {
        // Before 04:00 exchange time: return the most recent full regular window.
        endMs = sessionEndMs;
      } else {
        if (endMs > sessionEndMs) endMs = sessionEndMs;
      }
    }

    // Never allow end before start.
    if (endMs < startMs) endMs = startMs;
  } else {
    const approx = rangeToApproxMs(range);
    startMs = approx ? endMs - approx : endMs;
  }

  let expectedBars: number | null = null;

  if (range === "1D") {
    const ms = resToMs(res);
    if (ms && ms > 0) {
      // Canonical counting for intraday buckets:
      // - start is inclusive
      // - end is exclusive
      // - end is aligned down to the res boundary to avoid partial-bucket inflation
      // This makes expectedBars match the timestamp grid a chart will render.
      const endAlignedMs = Math.floor(endMs / ms) * ms;
      if (endAlignedMs < startMs) {
        expectedBars = 0;
      } else {
        expectedBars = Math.max(0, Math.floor((endAlignedMs - startMs) / ms));
      }
    }
  }

  if (expectedBars == null) {
    expectedBars = computeExpectedBars(range, res);
  }

  const msForEndAlign = range === "1D" ? resToMs(res) : null;
  const endForIsoMs = msForEndAlign && msForEndAlign > 0 ? Math.floor(endMs / msForEndAlign) * msForEndAlign : endMs;

  return {
    startISO: new Date(startMs).toISOString(),
    endISO: new Date(endForIsoMs).toISOString(),
    expectedBars,
  };
}