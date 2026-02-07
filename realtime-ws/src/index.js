console.log("REALTIME-WS ENTRYPOINT REACHED");

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";

const STALE_AFTER_MS = Number(process.env.STALE_AFTER_MS ?? 15000);
// Keep this small but never absurdly tight (protects CPU + avoids spam on reconnect loops).

const SYMBOL_STATUS_BROADCAST_MS = Math.max(250, Number(process.env.SYMBOL_STATUS_BROADCAST_MS ?? 1000));

// --- Phase 5-2: deterministic resolution config + bucketing (market TZ) ---
// Note: Intraday cache is session-bounded and deterministic; bucketing must be a pure function.
const MARKET_TZ = process.env.MARKET_TZ ?? "America/New_York";

/** @type {Record<string, number>} */
const RES_MINUTES = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
};

function parseGmtOffsetToMinutes(gmtOffsetText) {
  // Examples: "GMT-5", "GMT-05:00", "GMT+1", "GMT+01:30"
  const s = String(gmtOffsetText ?? "").trim();
  if (!s.startsWith("GMT")) return 0;
  const rest = s.slice(3); // "+01:00" or "-5"
  if (!rest) return 0;

  const sign = rest.startsWith("-") ? -1 : 1;
  const num = rest.replace(/^[-+]/, "");

  let hh = 0;
  let mm = 0;

  if (num.includes(":")) {
    const [hStr, mStr] = num.split(":");
    hh = Number(hStr);
    mm = Number(mStr);
  } else {
    hh = Number(num);
    mm = 0;
  }

  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 0;
  return sign * (hh * 60 + mm);
}

// Memoized Intl formatters (constructing these per call is expensive and can starve the event loop).
const DTF_MARKET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

// Uses shortOffset so we get a stable numeric offset like GMT-05:00.
const DTF_MARKET_OFFSET = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TZ,
  timeZoneName: "shortOffset",
});

function getMarketParts(ms) {
  const parts = DTF_MARKET_PARTS.formatToParts(new Date(ms));
  /** @type {Record<string, string>} */
  const out = {};
  for (const p of parts) out[p.type] = p.value;

  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

function getMarketOffsetMinutes(ms) {
  const parts = DTF_MARKET_OFFSET.formatToParts(new Date(ms));
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  return parseGmtOffsetToMinutes(tzName);
}

/**
 * Pure function: bucket start timestamp (ms epoch UTC) for an event timestamp and resolution.
 * Candle ts is the start of the bucket in market TZ.
 */
function bucketStartTsMs(eventTsMs, res) {
  const stepMin = RES_MINUTES[String(res)] ?? null;
  if (!stepMin) throw new Error(`bad_resolution:${res}`);

  const p = getMarketParts(eventTsMs);

  // Floor to bucket start.
  const bucketMinute = Math.floor(p.minute / stepMin) * stepMin;

  // Construct a "local-as-UTC" timestamp, then adjust by the market offset at event time.
  const localAsUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, bucketMinute, 0, 0);
  const offsetMin = getMarketOffsetMinutes(eventTsMs);
  const bucketUtcMs = localAsUtcMs - offsetMin * 60_000;

  return bucketUtcMs;
}

/** @type {Map<string, any>} */
const latestBySymbol = new Map();
/** @type {Map<string, number>} */
const lastSeenAtBySymbol = new Map();
/** @type {Map<import("ws").WebSocket, Set<string>>} */
const subsByClient = new Map();

// --- Phase 5-3: in-memory intraday candle store (single node) ---
// Session boundary + trimming is introduced in Phase 5-5; keep explicit nullable fields for now.
const intradaySession = {
  /** @type {string|null} */
  sessionKey: null,
  /** @type {number|null} */
  sessionStartTsMs: null,
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function computeMarketSessionKey(ms) {
  const p = getMarketParts(ms);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function marketLocalTimeUtcMs(year, month, day, targetHour, targetMinute) {
  // Find the UTC instant that corresponds to targetHour:targetMinute:00 in MARKET_TZ for the given Y-M-D.
  // Uses a small fixed-point iteration to converge.
  let guess = Date.UTC(year, month - 1, day, targetHour, targetMinute, 0, 0);

  const desiredMinuteOfDay = targetHour * 60 + targetMinute;

  for (let i = 0; i < 4; i++) {
    const p = getMarketParts(guess);

    // Compute current market-local minute-of-day.
    let minuteOfDay = p.hour * 60 + p.minute;

    // If the market-local date is not the target day, adjust minuteOfDay by whole-day offsets.
    // (This can happen because `guess` is in UTC and the market TZ may be behind/ahead.)
    if (p.year !== year || p.month !== month || p.day !== day) {
      const ord = (yy, mm, dd) => yy * 10000 + mm * 100 + dd;
      const targetOrd = ord(year, month, day);
      const gotOrd = ord(p.year, p.month, p.day);

      if (gotOrd < targetOrd) minuteOfDay -= 24 * 60;
      if (gotOrd > targetOrd) minuteOfDay += 24 * 60;
    }

    // Move the guess backward by the observed local minutes-from-desired.
    const diffMin = minuteOfDay - desiredMinuteOfDay;
    guess -= diffMin * 60_000;
  }

  return guess;
}

function resetIntradaySession(nowMs, newKey) {
  intradaySession.sessionKey = newKey;

  const p = getMarketParts(nowMs);
  // Set session start to premarket open 04:00 in MARKET_TZ.
  intradaySession.sessionStartTsMs = marketLocalTimeUtcMs(p.year, p.month, p.day, 4, 0);

  // Clear all intraday candle stores (Phase 5-5).
  for (const bySymbol of candlesByResThenSymbol.values()) {
    bySymbol.clear();
  }
}

function ensureIntradaySession(nowMs) {
  const key = computeMarketSessionKey(nowMs);
  if (intradaySession.sessionKey !== key) {
    resetIntradaySession(nowMs, key);
  }
}

/**
 * candlesByResThenSymbol.get(res).get(symbol) -> { candles: [], lastUpdateTsMs }
 *
 * @type {Map<string, Map<string, { candles: Array<{ ts: number, o: number, h: number, l: number, c: number, v: number }>, lastUpdateTsMs: number|null }>>}
 */
const candlesByResThenSymbol = new Map([
  ["1m", new Map()],
  ["5m", new Map()],
  ["15m", new Map()],
  ["30m", new Map()],
]);

function getOrInitCandleStore(res, symbol) {
  const resKey = String(res);
  const symKey = String(symbol).trim().toUpperCase();

  const bySymbol = candlesByResThenSymbol.get(resKey);
  if (!bySymbol) throw new Error(`bad_resolution_store:${resKey}`);

  let store = bySymbol.get(symKey);
  if (!store) {
    store = { candles: [], lastUpdateTsMs: null };
    bySymbol.set(symKey, store);
  }

  return store;
}

// --- Intraday bars backfill (REST) ---
// Purpose: make realtime-ws a durable intraday candle provider on cold cache.
// This does NOT create any additional Alpaca WS connections.

const BARS_TIMEFRAME_BY_RES = {
  "1m": "1Min",
  "5m": "5Min",
  "15m": "15Min",
  "30m": "30Min",
};

/** @type {Map<string, Promise<{ ok: boolean, filled: boolean, error: string|null }>>} */
const inFlightBarsFill = new Map();

function clampInt(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

function toBarTsMs(t) {
  // Alpaca bars timestamps are typically RFC3339 strings.
  if (t == null) return null;
  if (typeof t === "string") {
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof t === "number") {
    if (!Number.isFinite(t)) return null;
    if (t >= 1e15) return Math.floor(t / 1e6); // ns -> ms
    if (t >= 1e12) return Math.floor(t); // ms
    if (t >= 1e9) return Math.floor(t * 1000); // s -> ms
  }
  return null;
}

async function fetchAlpacaBars(symbol, res, startMs, endMs, limit) {
  const sym = String(symbol ?? "").trim().toUpperCase();
  const tf = BARS_TIMEFRAME_BY_RES[String(res)] ?? null;
  if (!sym) return { bars: [], error: "bad_symbol" };
  if (!tf) return { bars: [], error: "bad_res" };

  if (!ALPACA_REST_BASE_URL || !ALPACA_KEY || !ALPACA_SECRET) {
    return { bars: [], error: "missing_rest_env" };
  }

  const startIso = isoFromMs(startMs);
  const endIso = isoFromMs(endMs);

  const collected = [];
  const target = clampInt(limit, 1, 5000, 500);

  // Alpaca bars endpoint paginates via next_page_token.
  // We page until we reach `target` or no next_page_token remains.
  let pageToken = null;
  let safetyPages = 0;

  while (collected.length < target) {
    safetyPages += 1;
    if (safetyPages > 20) break; // hard safety to avoid loops

    const remaining = target - collected.length;

    const url = new URL(`${ALPACA_REST_BASE_URL}/v2/stocks/${encodeURIComponent(sym)}/bars`);
    url.searchParams.set("timeframe", tf);
    url.searchParams.set("start", startIso);
    url.searchParams.set("end", endIso);
    url.searchParams.set("limit", String(Math.max(1, Math.min(10000, remaining))));
    url.searchParams.set("sort", "asc");

    if (providerStatus.feed) url.searchParams.set("feed", String(providerStatus.feed));
    if (pageToken) url.searchParams.set("page_token", pageToken);

    try {
      const resp = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "APCA-API-KEY-ID": ALPACA_KEY,
          "APCA-API-SECRET-KEY": ALPACA_SECRET,
        },
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { bars: [], error: `http_${resp.status}${text ? ":" + text.slice(0, 160) : ""}` };
      }

      const data = await resp.json();
      const bars = Array.isArray(data?.bars) ? data.bars : [];
      for (const b of bars) {
        collected.push(b);
        if (collected.length >= target) break;
      }

      const next = typeof data?.next_page_token === "string" ? data.next_page_token : null;
      pageToken = next && next.length > 0 ? next : null;

      // No more pages, stop.
      if (!pageToken) break;

      // If the API returned no bars, stop to avoid spinning.
      if (bars.length === 0) break;
    } catch (e) {
      return { bars: [], error: String(e?.message ?? e ?? "fetch_error") };
    }
  }

  return { bars: collected, error: null };
}

function mapAlpacaBarToCandle(b) {
  const ts = toBarTsMs(b?.t);
  if (typeof ts !== "number") return null;
  const o = Number(b?.o);
  const h = Number(b?.h);
  const l = Number(b?.l);
  const c = Number(b?.c);
  const v = Number(b?.v ?? 0);
  if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) return null;
  return { ts, o, h, l, c, v: Number.isFinite(v) ? v : 0 };
}

function alignToBucketStart(ms, res) {
  try {
    return bucketStartTsMs(ms, res);
  } catch {
    return ms;
  }
}

function computeExpectedBarsForWindow({ windowStartMs, nowMs, res }) {
  const stepMin = RES_MINUTES[String(res)] ?? null;
  if (!stepMin) return null;

  const stepMs = stepMin * 60_000;

  const startAligned = alignToBucketStart(windowStartMs, res);
  const endAligned = alignToBucketStart(nowMs, res);

  const span = endAligned - startAligned;
  if (!Number.isFinite(span) || span < 0) return null;

  // Inclusive endpoints: start bucket .. end bucket
  return Math.max(0, Math.floor(span / stepMs) + 1);
}

function mergeCandlesPreferWsLatest({ existing, rest, nowMs, res }) {
  // Merge by ts; for CLOSED buckets prefer REST (more complete),
  // for the CURRENT forming bucket prefer existing WS candle.
  const formingBucketTs = alignToBucketStart(nowMs, res);

  /** @type {Map<number, { ts:number, o:number, h:number, l:number, c:number, v:number }>} */
  const byTs = new Map();

  for (const c of Array.isArray(existing) ? existing : []) {
    if (c && typeof c.ts === "number") byTs.set(c.ts, c);
  }

  for (const c of Array.isArray(rest) ? rest : []) {
    if (!c || typeof c.ts !== "number") continue;

    // If this bucket is the currently forming bucket, keep WS.
    if (c.ts === formingBucketTs && byTs.has(c.ts)) continue;

    // Otherwise prefer REST (fills gaps / normalizes closed candles).
    byTs.set(c.ts, c);
  }

  const merged = Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
  return merged;
}

/**
 * Ensures intraday bars exist for the current session window.
 * - On cold cache: fills.
 * - On undersupply (partial cache): backfills and merges.
 * This is REST-only and does not create additional Alpaca WS connections.
 */
async function ensureIntradayBarsFilled({ symbol, res, windowStartMs, nowMs, limit }) {
  const key = `${intradaySession.sessionKey ?? ""}:${String(res)}:${String(symbol).trim().toUpperCase()}`;

  if (inFlightBarsFill.has(key)) return inFlightBarsFill.get(key);

  const p = (async () => {
    try {
      const store = getOrInitCandleStore(res, symbol);

      const hardLimitRequested = clampInt(limit, 1, 5000, 500);
      const startMs = typeof windowStartMs === "number" ? windowStartMs : nowMs - 24 * 60 * 60 * 1000;
      const endMs = typeof nowMs === "number" ? nowMs : Date.now();

      const expected =
        typeof windowStartMs === "number" ? computeExpectedBarsForWindow({ windowStartMs, nowMs: endMs, res }) : null;

      const have = store.candles.length;
      const undersupplied = typeof expected === "number" && expected > 0 ? have < expected * 0.9 : false;

      // If we already have enough, do nothing.
      if (have > 0 && !undersupplied) return { ok: true, filled: false, error: null };

      // Fetch enough bars to cover the expected window (bounded).
      const hardLimit =
        typeof expected === "number" && expected > 0 ? clampInt(Math.max(hardLimitRequested, expected), 1, 5000, 500) : hardLimitRequested;

      const { bars, error } = await fetchAlpacaBars(symbol, res, startMs, endMs, hardLimit);
      if (error) return { ok: false, filled: false, error };

      const restCandles = [];
      for (const b of bars) {
        const c = mapAlpacaBarToCandle(b);
        if (!c) continue;
        if (typeof windowStartMs === "number" && c.ts < windowStartMs) continue;
        restCandles.push(c);
      }

      // Merge with existing WS candles to preserve the forming candle built from ticks.
      const merged = mergeCandlesPreferWsLatest({ existing: store.candles, rest: restCandles, nowMs: endMs, res });

      // Replace cache view for the session window.
      store.candles = merged;
      store.lastUpdateTsMs = Date.now();

      return { ok: true, filled: merged.length > 0, error: null };
    } finally {
      inFlightBarsFill.delete(key);
    }
  })();

  inFlightBarsFill.set(key, p);
  return p;
}

/** @type {Set<string>} */
const currentUpstreamSymbols = new Set();
let upstreamApplyTimer = null;

// Assigned once Alpaca ws exists and we're authorized.
let applyUpstreamSubscription = null;

function hashSymbols(symbols) {
  const s = Array.from(symbols).sort().join(",");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function computeDesiredUpstreamSymbols() {
  const out = new Set();

  // Seed from env stays in the union.
  for (const s of parseSymbols(process.env.ALPACA_SYMBOLS ?? "")) out.add(s);

  // Union of all client subscriptions.
  for (const subs of subsByClient.values()) {
    for (const s of subs) out.add(s);
  }

  return out;
}

/** @type {{ enabled: boolean, feed: string|null, state: string, since: string, lastEventAt: string|null, lastError: string|null, isStale: boolean, reconnectAttempt: number, nextRetryAt: number|null, lastDisconnectAt: number|null }} */
const providerStatus = {
  enabled: false,
  feed: null,
  state: "disabled", // disabled|connecting|connected|authorized|subscribed|reconnecting|error
  since: new Date().toISOString(),
  lastEventAt: null,
  lastError: null,
  isStale: false,

  // Phase 4B: explicit reconnect truth (UI must never infer continuity)
  reconnectAttempt: 0,
  nextRetryAt: null, // ms epoch
  lastDisconnectAt: null, // ms epoch
};

function getTrackedSymbols() {
  return computeDesiredUpstreamSymbols();
}

function computeSymbolFreshness(nowMs) {
  /** @type {Record<string, number|null>} */
  const lastSeenAtBySymbolObj = {};
  /** @type {Record<string, boolean>} */
  const isStaleBySymbolObj = {};

  const tracked = getTrackedSymbols();
  for (const sym of tracked) {
    const last = lastSeenAtBySymbol.get(sym) ?? null;
    lastSeenAtBySymbolObj[sym] = last;
    isStaleBySymbolObj[sym] = !last || nowMs - last > STALE_AFTER_MS;
  }

  return { lastSeenAtBySymbolObj, isStaleBySymbolObj, trackedCount: tracked.size };
}

function updateProviderStaleFlag(nowMs) {
  // Phase 4B gating truth: if we're not subscribed, data is not trustworthy.
  if (providerStatus.state !== "subscribed") {
    providerStatus.isStale = true;
    return;
  }

  const { isStaleBySymbolObj, trackedCount } = computeSymbolFreshness(nowMs);
  const syms = Object.keys(isStaleBySymbolObj);

  // "Subscribed but not receiving" = stale. If nothing is tracked yet, treat as stale.
  const allStale = trackedCount === 0 ? true : syms.every((s) => isStaleBySymbolObj[s] === true);
  providerStatus.isStale = allStale;
}

function broadcastSymbolStatus() {
  const nowMs = Date.now();
  updateProviderStaleFlag(nowMs);
  const { lastSeenAtBySymbolObj, isStaleBySymbolObj } = computeSymbolFreshness(nowMs);

  const payload = {
    type: "symbol_status",
    now: new Date(nowMs).toISOString(),
    staleAfterMs: STALE_AFTER_MS,
    lastSeenAtBySymbol: lastSeenAtBySymbolObj,
    isStaleBySymbol: isStaleBySymbolObj,
    provider_status: providerStatus,
  };

  for (const ws of subsByClient.keys()) {
    safeSend(ws, payload);
  }
}

function safeSend(ws, msg) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  } catch {}
}

function broadcastProviderStatus() {
  for (const ws of subsByClient.keys()) {
    safeSend(ws, { type: "provider_status", provider_status: providerStatus });
  }
}

function setProviderState(state, patch = {}) {
  providerStatus.state = state;
  providerStatus.since = new Date().toISOString();

  if (Object.prototype.hasOwnProperty.call(patch, "lastError")) providerStatus.lastError = patch.lastError;
  if (Object.prototype.hasOwnProperty.call(patch, "feed")) providerStatus.feed = patch.feed;
  if (Object.prototype.hasOwnProperty.call(patch, "enabled")) providerStatus.enabled = patch.enabled;

  broadcastProviderStatus();
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    const nowMs = Date.now();
    ensureIntradaySession(nowMs);
    updateProviderStaleFlag(nowMs);
    const { lastSeenAtBySymbolObj, isStaleBySymbolObj } = computeSymbolFreshness(nowMs);
    const tracked = Object.keys(lastSeenAtBySymbolObj);
    const staleCount = Object.values(isStaleBySymbolObj).filter(Boolean).length;

    return json(res, 200, {
      ok: true,
      service: "realtime-ws",
      now: new Date(nowMs).toISOString(),
      clients: subsByClient.size,
      symbolsTracked: tracked.length,
      providerStatus,
      staleAfterMs: STALE_AFTER_MS,
      symbols: {
        tracked,
        staleCount,
        lastSeenAtBySymbol: lastSeenAtBySymbolObj,
      },
    });
  }

  // --- Phase 5-8: Stale read truth ---
  // If upstream is stale or disconnected:
  //   • return last known candles (if any)
  //   • meta.is_stale = true
  //   • meta.last_update_ts does NOT advance
  //   • no candle mutation occurs
  // The UI must never infer freshness.
  if (url.pathname === "/candles/intraday") {
    const symbolRaw = url.searchParams.get("symbol") ?? "";
    const resRaw = (url.searchParams.get("res") ?? "").toLowerCase();

    const symbol = symbolRaw.trim().toUpperCase();
    const allowedRes = new Set(["1m", "5m", "15m", "30m"]);

    if (!symbol) {
      return json(res, 400, { ok: false, error: "BAD_REQUEST", detail: "missing_symbol" });
    }

    if (!allowedRes.has(resRaw)) {
      return json(res, 400, { ok: false, error: "BAD_REQUEST", detail: "bad_res" });
    }

    const nowMs = Date.now();
    ensureIntradaySession(nowMs);
    const nowIso = new Date(nowMs).toISOString();

    // Optional: bound payload size so callers can safely inspect first/last candles.
    const limitRaw = url.searchParams.get("limit");
    let limit = Number(limitRaw ?? "");
    if (!Number.isFinite(limit) || limit <= 0) limit = 500;
    limit = Math.floor(limit);
    // Hard clamp to protect memory/latency even if the caller requests something huge.
    limit = Math.max(1, Math.min(5000, limit));

    // --- Phase 5-3: wire endpoint to the store; still safe on empty ---
    const store = getOrInitCandleStore(resRaw, symbol);

    // Backfill-on-miss: if cache is cold/empty, fetch bars from Alpaca REST and seed the in-memory store.
    // This preserves the single intraday truth surface while allowing WS to be the primary candle provider.
    // NOTE: This is a REST call only; it does not create any additional WS connections.
    const windowStartForRead = intradaySession.sessionStartTsMs;

    // Backfill-on-miss OR backfill-on-undersupply: if cache is cold/partial, fetch bars from Alpaca REST
    // and merge into the in-memory store to cover the session window.
    // NOTE: REST-only; does not create any additional WS connections.
    await ensureIntradayBarsFilled({
      symbol,
      res: resRaw,
      windowStartMs: windowStartForRead,
      nowMs,
      limit,
    }).catch(() => null);

    let cacheStatus = "MISS";
    if (store.lastUpdateTsMs != null) {
      cacheStatus = store.candles.length > 0 ? "HIT" : "EMPTY";
    }

    const meta = {
      symbol,
      resolution: resRaw,
      window: {
        session_key: intradaySession.sessionKey,
        // Intraday window starts at premarket open (04:00 MARKET_TZ).
        session_start_ts: intradaySession.sessionStartTsMs != null ? new Date(intradaySession.sessionStartTsMs).toISOString() : null,
      },
      last_update_ts: store.lastUpdateTsMs != null ? new Date(store.lastUpdateTsMs).toISOString() : null,
      as_of_ts: nowIso,
      source: "cache",
      is_stale: providerStatus.state !== "subscribed" || Boolean(providerStatus.isStale),
      cache_status: cacheStatus,
    };

    // Enforce session-bounded window (Phase 5-5).
    const windowStart = intradaySession.sessionStartTsMs;

    const all = windowStart != null ? store.candles.filter((c) => c.ts >= windowStart) : store.candles;
    // Phase 5-8: if provider is stale, freeze the view (no mutation, no inference)
    // We still return existing candles truthfully, but meta.is_stale=true and
    // last_update_ts must not advance beyond last known store update.
    if (providerStatus.state !== "subscribed" || providerStatus.isStale) {
      // No-op by design: candle data is returned as-is, freshness is expressed via meta
    }

    const totalCount = all.length;
    const candles = totalCount > limit ? all.slice(totalCount - limit) : all;

    meta.limit = limit;
    meta.returned_count = candles.length;
    meta.total_count = totalCount;

    return json(res, 200, { candles, meta });
  }

  return json(res, 404, { ok: false, error: "NOT_FOUND" });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  subsByClient.set(ws, new Set());

  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  safeSend(ws, { type: "hello", now: new Date().toISOString() });
  safeSend(ws, { type: "provider_status", provider_status: providerStatus });
  broadcastSymbolStatus();

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      safeSend(ws, { type: "error", error: "INVALID_JSON" });
      return;
    }

    if (msg?.type === "subscribe") {
      const set = subsByClient.get(ws);
      if (!set) return;

      const symbols = Array.isArray(msg.symbols) ? msg.symbols : [];
      for (const s of symbols) {
        const sym = String(s).trim().toUpperCase();
        if (sym) set.add(sym);
      }

      safeSend(ws, { type: "subscribed", symbols: Array.from(set) });
      broadcastSymbolStatus();
      scheduleUpstreamApply("client_change");
      return;
    }

    if (msg?.type === "unsubscribe") {
      const set = subsByClient.get(ws);
      if (!set) return;

      const symbols = Array.isArray(msg.symbols) ? msg.symbols : [];
      for (const s of symbols) {
        const sym = String(s).trim().toUpperCase();
        if (sym) set.delete(sym);
      }

      safeSend(ws, { type: "subscribed", symbols: Array.from(set) });
      broadcastSymbolStatus();
      scheduleUpstreamApply("client_change");
      return;
    }

    broadcastSymbolStatus();

    if (msg?.type === "get_latest") {
      const symbols = Array.isArray(msg.symbols) ? msg.symbols : [];
      const out = {};
      for (const s of symbols) {
        const sym = String(s).trim().toUpperCase();
        if (!sym) continue;
        const v = latestBySymbol.get(sym);
        if (v) out[sym] = v;
      }
      safeSend(ws, { type: "latest", latest: out });
      return;
    }

    safeSend(ws, { type: "error", error: "UNKNOWN_MESSAGE_TYPE" });
  });

  ws.on("close", () => {
    subsByClient.delete(ws);
    broadcastSymbolStatus();
    scheduleUpstreamApply("client_change");
  });
});

setInterval(() => {
  for (const ws of subsByClient.keys()) {
    if (ws.isAlive === false) {
      subsByClient.delete(ws);
      try {
        ws.terminate();
      } catch {}
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 30_000);

// --- Alpaca ingress ---
const ALPACA_ENABLED = process.env.ALPACA_ENABLED === "1";
const ALPACA_KEY = process.env.ALPACA_KEY ?? "";
const ALPACA_SECRET = process.env.ALPACA_SECRET ?? "";
const ALPACA_WS_URL = process.env.ALPACA_WS_URL ?? ""; // wss://stream.data.alpaca.markets/v2/sip
const ALPACA_SYMBOLS_RAW = process.env.ALPACA_SYMBOLS ?? "";
const ALPACA_SUB_TRADES = process.env.ALPACA_SUB_TRADES !== "0";
const ALPACA_SUB_QUOTES = process.env.ALPACA_SUB_QUOTES !== "0";
const ALPACA_SUB_BARS = process.env.ALPACA_SUB_BARS === "1";
const ALPACA_RECONNECT_MIN_MS = Number(process.env.ALPACA_RECONNECT_MIN_MS ?? "1000");
const ALPACA_RECONNECT_MAX_MS = Number(process.env.ALPACA_RECONNECT_MAX_MS ?? "10000");
const SIMULATE_PROVIDER_DOWN = process.env.SIMULATE_PROVIDER_DOWN === "1";

// Phase 4C-2: REST backfill / reconciliation (gap repair)
const ALPACA_REST_BASE_URL = process.env.ALPACA_REST_BASE_URL ?? "https://data.alpaca.markets";
const ALPACA_BACKFILL_MAX_MS = Number(process.env.ALPACA_BACKFILL_MAX_MS ?? "10000");
const ALPACA_BACKFILL_MAX_TRADES = Math.max(1, Number(process.env.ALPACA_BACKFILL_MAX_TRADES ?? "500"));

function parseSymbols(raw) {
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function inferFeed(wsUrl) {
  try {
    const u = new URL(wsUrl);
    const path = u.pathname.toLowerCase();
    if (path.includes("/delayed_sip")) return "delayed_sip";
    if (path.includes("/sip")) return "sip";
    if (path.includes("/iex")) return "iex";
    return null;
  } catch {
    return null;
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function jitter(ms) {
  const r = Math.random() * 0.4 - 0.2; // +/- 20%
  return Math.round(ms * (1 + r));
}

function toEventTsMs(t) {
  // Alpaca WS timestamps may be RFC3339 strings or numeric (ms / ns). Normalize to epoch ms.
  if (t == null) return null;

  if (typeof t === "string") {
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : null;
  }

  if (typeof t === "number") {
    if (!Number.isFinite(t)) return null;

    // Heuristics:
    // - ns epoch ~ 1e18
    // - ms epoch ~ 1e12
    // - s epoch  ~ 1e9
    if (t >= 1e15) return Math.floor(t / 1e6); // ns -> ms
    if (t >= 1e12) return Math.floor(t); // ms
    if (t >= 1e9) return Math.floor(t * 1000); // seconds -> ms
    return null;
  }

  return null;
}

function normalizeAlpacaEvent(ev) {
  const sym = String(ev?.S ?? "").trim().toUpperCase();
  if (!sym) return null;

  const tsMs = toEventTsMs(ev?.t);

  if (ev?.T === "t") {
    return {
      type: "trade",
      symbol: sym,
      ts: tsMs,
      price: ev?.p ?? null,
      size: ev?.s ?? null,
      source: "alpaca",
    };
  }

  if (ev?.T === "q") {
    return {
      type: "quote",
      symbol: sym,
      ts: tsMs,
      bid: ev?.bp ?? null,
      ask: ev?.ap ?? null,
      bidSize: ev?.bs ?? null,
      askSize: ev?.as ?? null,
      source: "alpaca",
    };
  }

  if (ev?.T === "b") {
    return {
      type: "bar",
      symbol: sym,
      ts: tsMs,
      o: ev?.o ?? null,
      h: ev?.h ?? null,
      l: ev?.l ?? null,
      c: ev?.c ?? null,
      v: ev?.v ?? null,
      source: "alpaca",
    };
  }

  return null;
}

function isoFromMs(ms) {
  return new Date(ms).toISOString();
}

function mapRestTradeToCanonical(symbol, t) {
  const sym = String(symbol ?? "").trim().toUpperCase();
  if (!sym) return null;
  // Alpaca REST trades typically return { t, p, s, ... }
  return {
    type: "trade",
    symbol: sym,
    ts: t?.t ?? null,
    price: t?.p ?? null,
    size: t?.s ?? null,
    source: "alpaca",
  };
}

async function fetchBackfillTrades(symbol, startMs, endMs) {
  const sym = String(symbol).trim().toUpperCase();
  if (!sym) return { trades: [], error: "bad_symbol" };

  const startIso = isoFromMs(startMs);
  const endIso = isoFromMs(endMs);

  const url = new URL(`${ALPACA_REST_BASE_URL}/v2/stocks/${encodeURIComponent(sym)}/trades`);
  url.searchParams.set("start", startIso);
  url.searchParams.set("end", endIso);
  url.searchParams.set("limit", String(ALPACA_BACKFILL_MAX_TRADES));
  url.searchParams.set("sort", "asc");

  // Use the same feed inference as WS when available (sip/iex/delayed_sip)
  if (providerStatus.feed) url.searchParams.set("feed", String(providerStatus.feed));

  try {
    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "APCA-API-KEY-ID": ALPACA_KEY,
        "APCA-API-SECRET-KEY": ALPACA_SECRET,
      },
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { trades: [], error: `http_${resp.status}${text ? ":" + text.slice(0, 160) : ""}` };
    }

    const data = await resp.json();
    const trades = Array.isArray(data?.trades) ? data.trades : [];
    return { trades, error: null };
  } catch (e) {
    return { trades: [], error: String(e?.message ?? e ?? "fetch_error") };
  }
}

let backfillRunId = 0;
async function runReconnectBackfill({ disconnectAtMs, reconnectedAtMs }) {
  const runId = ++backfillRunId;

  const desired = computeDesiredUpstreamSymbols();
  if (desired.size === 0) {
    console.log("[alpaca] backfill_summary", {
      runId,
      skipped: true,
      skipped_reason: "empty_union",
      disconnectAtMs,
      reconnectedAtMs,
    });
    return;
  }

  const windowEnd = reconnectedAtMs;
  const maxWindowMs = Math.max(0, ALPACA_BACKFILL_MAX_MS);

  let totalFetched = 0;
  let totalEmitted = 0;
  let totalSkipped = 0;

  for (const sym of desired) {
    const lastSeen = lastSeenAtBySymbol.get(sym) ?? 0;
    const fromMs = Math.max(lastSeen, disconnectAtMs ?? 0);
    const toMs = windowEnd;

    if (!fromMs || toMs - fromMs <= 0) {
      totalSkipped += 1;
      console.log("[alpaca] backfill_symbol", {
        runId,
        symbol: sym,
        gap_from: fromMs ? isoFromMs(fromMs) : null,
        gap_to: isoFromMs(toMs),
        rest_count: 0,
        emitted_count: 0,
        skipped_reason: "no_gap",
      });
      continue;
    }

    const clampedFromMs = Math.max(toMs - maxWindowMs, fromMs);
    if (toMs - clampedFromMs <= 0) {
      totalSkipped += 1;
      console.log("[alpaca] backfill_symbol", {
        runId,
        symbol: sym,
        gap_from: isoFromMs(fromMs),
        gap_to: isoFromMs(toMs),
        rest_count: 0,
        emitted_count: 0,
        skipped_reason: "clamped_empty",
      });
      continue;
    }

    const { trades, error } = await fetchBackfillTrades(sym, clampedFromMs, toMs);
    const restCount = trades.length;
    totalFetched += restCount;

    if (error) {
      totalSkipped += 1;
      console.log("[alpaca] backfill_symbol", {
        runId,
        symbol: sym,
        gap_from: isoFromMs(clampedFromMs),
        gap_to: isoFromMs(toMs),
        rest_count: restCount,
        emitted_count: 0,
        skipped_reason: error,
      });
      continue;
    }

    let emitted = 0;
    const meta = {
      backfill: true,
      windowFrom: isoFromMs(clampedFromMs),
      windowTo: isoFromMs(toMs),
      runId,
    };

    for (const t of trades) {
      const canonical = mapRestTradeToCanonical(sym, t);
      if (!canonical) continue;
      broadcastMarketEvent(canonical, meta);
      emitted += 1;
    }

    totalEmitted += emitted;

    console.log("[alpaca] backfill_symbol", {
      runId,
      symbol: sym,
      gap_from: isoFromMs(clampedFromMs),
      gap_to: isoFromMs(toMs),
      rest_count: restCount,
      emitted_count: emitted,
      skipped_reason: null,
    });
  }

  console.log("[alpaca] backfill_summary", {
    runId,
    disconnectAtMs,
    reconnectedAtMs,
    desiredCount: desired.size,
    totalFetched,
    totalEmitted,
    totalSkipped,
    maxWindowMs: maxWindowMs,
    maxTradesPerSymbol: ALPACA_BACKFILL_MAX_TRADES,
  });
}

function scheduleUpstreamApply(reason) {
  if (upstreamApplyTimer) clearTimeout(upstreamApplyTimer);
  upstreamApplyTimer = setTimeout(() => {
    upstreamApplyTimer = null;
    if (typeof applyUpstreamSubscription === "function") {
      applyUpstreamSubscription(reason);
    }
  }, 350);
}

function broadcastMarketEvent(canonical, meta = null) {
  if (providerStatus.state !== "subscribed" || providerStatus.isStale) return;
  ensureIntradaySession(Date.now());

  providerStatus.lastEventAt = new Date().toISOString();
  lastSeenAtBySymbol.set(canonical.symbol, Date.now()); // arrival-time freshness
  latestBySymbol.set(canonical.symbol, { ts: providerStatus.lastEventAt, event: canonical });

  // --- Phase 5-4: candle builder (trade-first) ---
  if (canonical.type === "trade" && typeof canonical.ts === "number" && typeof canonical.price === "number") {
    const eventTsMs = canonical.ts;
    // Enforce session boundary on writes: ignore events outside current session window.
    if (intradaySession.sessionStartTsMs != null && eventTsMs < intradaySession.sessionStartTsMs) {
      return;
    }
    const price = canonical.price;
    const size = Number(canonical.size ?? 0);

    for (const resKey of Object.keys(RES_MINUTES)) {
      const store = getOrInitCandleStore(resKey, canonical.symbol);
      const bucketTsMs = bucketStartTsMs(eventTsMs, resKey);

      let candle = store.candles.length > 0 ? store.candles[store.candles.length - 1] : null;

      if (!candle || candle.ts !== bucketTsMs) {
        candle = {
          ts: bucketTsMs,
          o: price,
          h: price,
          l: price,
          c: price,
          v: size,
        };
        store.candles.push(candle);
      } else {
        candle.h = Math.max(candle.h, price);
        candle.l = Math.min(candle.l, price);
        candle.c = price;
        candle.v += size;
      }

      store.lastUpdateTsMs = Date.now();
    }
  }

  for (const [client, subs] of subsByClient.entries()) {
    if (!subs.has(canonical.symbol)) continue;
    const payload = { type: "md", event: canonical, provider_status: providerStatus };
    if (meta) payload.meta = meta;
    safeSend(client, payload);
  }
}

async function startAlpaca() {
  providerStatus.enabled = ALPACA_ENABLED;
  providerStatus.feed = inferFeed(ALPACA_WS_URL);
  broadcastProviderStatus();

  if (!ALPACA_ENABLED) return;

  if (!ALPACA_WS_URL || !ALPACA_KEY || !ALPACA_SECRET) {
    console.error("[alpaca] missing env (ALPACA_WS_URL, ALPACA_KEY, ALPACA_SECRET)");
    setProviderState("error", { lastError: "missing_env" });
    return;
  }

  if (SIMULATE_PROVIDER_DOWN) {
    console.warn("[alpaca] SIMULATE_PROVIDER_DOWN=1; forcing reconnect loop without upstream connection");

    let attempt = 0;
    let stopped = false;

    const connectOnceSimulated = () => {
      if (stopped) return;
      attempt += 1;

      // Phase 4B truth: reflect attempt immediately on each reconnect
      providerStatus.reconnectAttempt = attempt;
      providerStatus.nextRetryAt = null;

      currentUpstreamSymbols.clear();
      applyUpstreamSubscription = null;

      // Simulated: never reach connected/authorized/subscribed
      setProviderState("reconnecting", { lastError: "simulated_down" });

      const nowMs = Date.now();
      providerStatus.lastDisconnectAt = nowMs;

      const backoff = clamp(
        ALPACA_RECONNECT_MIN_MS * 2 ** Math.min(attempt - 1, 4),
        ALPACA_RECONNECT_MIN_MS,
        ALPACA_RECONNECT_MAX_MS
      );
      const delayMs = jitter(backoff);

      providerStatus.nextRetryAt = nowMs + delayMs;
      broadcastProviderStatus();

      setTimeout(connectOnceSimulated, delayMs);
    };

    connectOnceSimulated();
    return;
  }

  const { WebSocket } = await import("ws");

  let attempt = 0;
  let stopped = false;

  const connectOnce = () => {
    if (stopped) return;
    attempt += 1;

    // Phase 4B truth: reflect attempt immediately on each connect/reconnect
    providerStatus.reconnectAttempt = attempt;
    providerStatus.nextRetryAt = null;

    setProviderState(attempt === 1 ? "connecting" : "reconnecting", { lastError: null });

    const ws = new WebSocket(ALPACA_WS_URL);

    let authed = false;
    let subscribed = false;

    const markSubscribed = () => {
      if (subscribed) return;
      subscribed = true;

      const reconnectDisconnectAtMs = providerStatus.lastDisconnectAt;

      // Phase 4B truth: reset reconnect bookkeeping on successful subscription
      attempt = 0;
      providerStatus.reconnectAttempt = 0;
      providerStatus.nextRetryAt = null;
      providerStatus.lastDisconnectAt = null;

      const reconnectedAtMs = Date.now();
      setProviderState("subscribed");

      // Phase 4C-2: gap repair via REST trades when we are recovering from a disconnect.
      if (reconnectDisconnectAtMs != null) {
        void runReconnectBackfill({ disconnectAtMs: reconnectDisconnectAtMs, reconnectedAtMs });
      }
    };

    const scheduleReconnect = (why) => {
      if (stopped) return;

      const nowMs = Date.now();
      providerStatus.lastDisconnectAt = nowMs;
      currentUpstreamSymbols.clear();
      applyUpstreamSubscription = null;

      // Existing backoff policy (min/max + exponential) — compute the actual scheduled delay.
      const backoff = clamp(
        ALPACA_RECONNECT_MIN_MS * 2 ** Math.min(attempt - 1, 4),
        ALPACA_RECONNECT_MIN_MS,
        ALPACA_RECONNECT_MAX_MS
      );
      const delayMs = jitter(backoff);

      providerStatus.nextRetryAt = nowMs + delayMs;

      setProviderState("reconnecting", { lastError: why ?? "disconnected" });
      setTimeout(connectOnce, delayMs);
    };

    ws.on("open", () => {
      setProviderState("connected");
      ws.send(JSON.stringify({ action: "auth", key: ALPACA_KEY, secret: ALPACA_SECRET }));
    });

    ws.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return;
      }

      const events = Array.isArray(data) ? data : [data];
      for (const ev of events) {
        if (ev?.T === "success") {
          const msg = String(ev?.msg ?? ev?.message ?? "").toLowerCase();
          if (!authed && msg.includes("authenticated")) {
            authed = true;
            setProviderState("authorized");

            // Enable debounced upstream updates as soon as we're authorized.
            applyUpstreamSubscription = (reason) => {
              const next = computeDesiredUpstreamSymbols();

              // Dynamic-only allowed: if union is empty, do not subscribe.
              if (next.size === 0) {
                currentUpstreamSymbols.clear();
                console.log("[alpaca] upstream_sub_update", {
                  reason: reason ?? "client_change",
                  attempt,
                  desiredCount: 0,
                  desiredHash: hashSymbols(next),
                  sample: [],
                });
                return;
              }

              let changed = false;
              if (next.size !== currentUpstreamSymbols.size) {
                changed = true;
              } else {
                for (const s of next) {
                  if (!currentUpstreamSymbols.has(s)) {
                    changed = true;
                    break;
                  }
                }
              }
              if (!changed) return;

              const arr = Array.from(next);
              const msg = { action: "subscribe" };
              if (ALPACA_SUB_TRADES) msg.trades = arr;
              if (ALPACA_SUB_QUOTES) msg.quotes = arr;
              if (ALPACA_SUB_BARS) msg.bars = arr;

              try {
                ws.send(JSON.stringify(msg));
              } catch {
                return;
              }

              currentUpstreamSymbols.clear();
              for (const s of next) currentUpstreamSymbols.add(s);

              console.log("[alpaca] upstream_sub_update", {
                reason: reason ?? "client_change",
                attempt,
                desiredCount: next.size,
                desiredHash: hashSymbols(next),
                sample: arr.slice(0, 5),
              });
            };

            // Apply immediately on connect/reconnect (may be empty; that's allowed).
            applyUpstreamSubscription(attempt === 1 ? "connect" : "reconnect");
            continue;
          }
        }

        // SUBSCRIPTION ACK: SIP responds with T:"subscription"
        if (ev?.T === "subscription") {
          markSubscribed();
          continue;
        }

        if (ev?.T === "error") {
          const err = String(ev?.msg ?? ev?.message ?? "alpaca_error");
          console.error("[alpaca] error message", err);
          setProviderState("error", { lastError: err });
          try {
            ws.close();
          } catch {}
          continue;
        }

        // Market data events: also implies subscribed (belt + suspenders)
        const canonical = normalizeAlpacaEvent(ev);
        if (!canonical) continue;

        if (!subscribed) {
          markSubscribed();
        }

        broadcastMarketEvent(canonical);
      }
    });

    ws.on("close", () => scheduleReconnect("closed"));
    ws.on("error", (e) => {
      console.error("[alpaca] socket error", e);
      scheduleReconnect("socket_error");
    });
  };

  connectOnce();
}

server.listen(PORT, HOST, async () => {
  console.log(`[realtime-ws] listening on ${HOST}:${PORT}`);
  await startAlpaca();
});

setInterval(() => {
  // Independent truth surface: freshness/staleness must keep updating even when upstream is quiet/disconnected.
  if (subsByClient.size === 0) return;
  broadcastSymbolStatus();
}, SYMBOL_STATUS_BROADCAST_MS);

server.on("error", (err) => {
  console.error("[realtime-ws] server error", err);
});