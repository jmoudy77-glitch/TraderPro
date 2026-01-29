console.log("REALTIME-WS ENTRYPOINT REACHED");

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";

const STALE_AFTER_MS = Number(process.env.STALE_AFTER_MS ?? 15000);
// Keep this small but never absurdly tight (protects CPU + avoids spam on reconnect loops).
const SYMBOL_STATUS_BROADCAST_MS = Math.max(250, Number(process.env.SYMBOL_STATUS_BROADCAST_MS ?? 1000));

/** @type {Map<string, any>} */
const latestBySymbol = new Map();
/** @type {Map<string, number>} */
const lastSeenAtBySymbol = new Map();
/** @type {Map<import("ws").WebSocket, Set<string>>} */
const subsByClient = new Map();

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    const nowMs = Date.now();
    updateProviderStaleFlag(nowMs);
    const { lastSeenAtBySymbolObj, isStaleBySymbolObj } = computeSymbolFreshness(nowMs);
    const tracked = Object.keys(lastSeenAtBySymbolObj);
    const staleCount = Object.values(isStaleBySymbolObj).filter(Boolean).length;

    return json(res, 200, {
      ok: true,
      service: "realtime-ws",
      now: new Date(nowMs).toISOString(),
      clients: subsByClient.size,
      symbolsTracked: latestBySymbol.size,
      providerStatus,
      staleAfterMs: STALE_AFTER_MS,
      symbols: {
        tracked,
        staleCount,
        lastSeenAtBySymbol: lastSeenAtBySymbolObj,
      },
    });
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

function normalizeAlpacaEvent(ev) {
  const sym = String(ev?.S ?? "").trim().toUpperCase();
  if (!sym) return null;

  if (ev?.T === "t") {
    return { type: "trade", symbol: sym, ts: ev?.t ?? null, price: ev?.p ?? null, size: ev?.s ?? null, source: "alpaca" };
  }
  if (ev?.T === "q") {
    return {
      type: "quote",
      symbol: sym,
      ts: ev?.t ?? null,
      bid: ev?.bp ?? null,
      ask: ev?.ap ?? null,
      bidSize: ev?.bs ?? null,
      askSize: ev?.as ?? null,
      source: "alpaca",
    };
  }
  if (ev?.T === "b") {
    return { type: "bar", symbol: sym, ts: ev?.t ?? null, o: ev?.o ?? null, h: ev?.h ?? null, l: ev?.l ?? null, c: ev?.c ?? null, v: ev?.v ?? null, source: "alpaca" };
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
  if (providerStatus.state !== "subscribed") return;

  providerStatus.lastEventAt = new Date().toISOString();
  lastSeenAtBySymbol.set(canonical.symbol, Date.now()); // arrival-time freshness
  latestBySymbol.set(canonical.symbol, { ts: providerStatus.lastEventAt, event: canonical });

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