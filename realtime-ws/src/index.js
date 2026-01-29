console.log("REALTIME-WS ENTRYPOINT REACHED");

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";

// --- In-memory WS truth (v1) ---
/** @type {Map<string, any>} */
const latestBySymbol = new Map();
/** @type {Map<import("ws").WebSocket, Set<string>>} */
const subsByClient = new Map();

// --- Provider truth surface (v1) ---
// Invariant: service truthfully reports upstream state, and never emits md unless subscribed.
/** @type {{ enabled: boolean, feed: string|null, state: string, since: string, lastEventAt: string|null, lastError: string|null }} */
const providerStatus = {
  enabled: false,
  feed: null,
  state: "disabled", // disabled|connecting|connected|authorized|subscribed|reconnecting|error
  since: new Date().toISOString(),
  lastEventAt: null,
  lastError: null,
};

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
    return json(res, 200, {
      ok: true,
      service: "realtime-ws",
      now: new Date().toISOString(),
      clients: subsByClient.size,
      symbolsTracked: latestBySymbol.size,
      providerStatus,
    });
  }

  return json(res, 404, { ok: false, error: "NOT_FOUND" });
});

const wss = new WebSocketServer({ noServer: true });

// Upgrade only /ws
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

  // ping/pong keepalive
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  safeSend(ws, { type: "hello", now: new Date().toISOString() });
  safeSend(ws, { type: "provider_status", provider_status: providerStatus });

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
      return;
    }

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

// --- Alpaca ingress (Step 1) ---
// Invariant: must reach connecting->connected->authorized->subscribed with ALPACA_ENABLED=1
// and must not emit market data unless subscribed.
const ALPACA_ENABLED = process.env.ALPACA_ENABLED === "1";
const ALPACA_KEY = process.env.ALPACA_KEY ?? "";
const ALPACA_SECRET = process.env.ALPACA_SECRET ?? "";
const ALPACA_WS_URL = process.env.ALPACA_WS_URL ?? ""; // e.g. wss://stream.data.alpaca.markets/v2/sip
const ALPACA_SYMBOLS_RAW = process.env.ALPACA_SYMBOLS ?? "";
const ALPACA_SUB_TRADES = process.env.ALPACA_SUB_TRADES !== "0";
const ALPACA_SUB_QUOTES = process.env.ALPACA_SUB_QUOTES !== "0";
const ALPACA_SUB_BARS = process.env.ALPACA_SUB_BARS === "1";
const ALPACA_RECONNECT_MIN_MS = Number(process.env.ALPACA_RECONNECT_MIN_MS ?? "1000");
const ALPACA_RECONNECT_MAX_MS = Number(process.env.ALPACA_RECONNECT_MAX_MS ?? "10000");

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
  // +/- 20%
  const r = Math.random() * 0.4 - 0.2;
  return Math.round(ms * (1 + r));
}

function normalizeAlpacaEvent(ev) {
  // Alpaca v2 stock stream uses "T" for event type, "S" for symbol.
  const sym = String(ev?.S ?? "").trim().toUpperCase();
  if (!sym) return null;

  // Trade
  if (ev?.T === "t") {
    return {
      type: "trade",
      symbol: sym,
      ts: ev?.t ?? null,
      price: ev?.p ?? null,
      size: ev?.s ?? null,
      source: "alpaca",
    };
  }

  // Quote
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

  // Bar
  if (ev?.T === "b") {
    return {
      type: "bar",
      symbol: sym,
      ts: ev?.t ?? null,
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

function broadcastMarketEvent(canonical) {
  // Hard gate: never emit market data unless subscribed
  if (providerStatus.state !== "subscribed") return;

  providerStatus.lastEventAt = new Date().toISOString();

  // latest-per-symbol map (truth derived from canonical event)
  latestBySymbol.set(canonical.symbol, { ts: providerStatus.lastEventAt, event: canonical });

  for (const [client, subs] of subsByClient.entries()) {
    if (!subs.has(canonical.symbol)) continue;
    safeSend(client, { type: "md", event: canonical, provider_status: providerStatus });
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

  const symbols = parseSymbols(ALPACA_SYMBOLS_RAW);
  if (!symbols.length) {
    console.error("[alpaca] ALPACA_SYMBOLS is empty; refusing to connect without a static subscribe set (Step 1 invariant).");
    setProviderState("error", { lastError: "missing_symbols" });
    return;
  }

  const { WebSocket } = await import("ws");

  let attempt = 0;
  let stopped = false;

  const connectOnce = () => {
    if (stopped) return;
    attempt += 1;

    setProviderState(attempt === 1 ? "connecting" : "reconnecting", { lastError: null });

    const ws = new WebSocket(ALPACA_WS_URL);

    let authed = false;
    let subscribed = false;

    const scheduleReconnect = (why) => {
      if (stopped) return;
      setProviderState("reconnecting", { lastError: why ?? "disconnected" });
      const backoff = clamp(
        ALPACA_RECONNECT_MIN_MS * 2 ** Math.min(attempt - 1, 4),
        ALPACA_RECONNECT_MIN_MS,
        ALPACA_RECONNECT_MAX_MS
      );
      setTimeout(connectOnce, jitter(backoff));
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
        // Control messages
        if (ev?.T === "success") {
          const msg = String(ev?.msg ?? ev?.message ?? "").toLowerCase();

          if (!authed && msg.includes("authenticated")) {
            authed = true;
            setProviderState("authorized");

            // Subscribe immediately after auth
            const sub = { action: "subscribe" };
            if (ALPACA_SUB_TRADES) sub.trades = symbols;
            if (ALPACA_SUB_QUOTES) sub.quotes = symbols;
            if (ALPACA_SUB_BARS) sub.bars = symbols;
            ws.send(JSON.stringify(sub));
            continue;
          }

          if (msg.includes("subscribed")) {
            subscribed = true;
            setProviderState("subscribed");
            continue;
          }
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

        // Market data events — only process after subscribed (hard gate)
        if (!subscribed || providerStatus.state !== "subscribed") continue;

        const canonical = normalizeAlpacaEvent(ev);
        if (!canonical) continue;

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

server.on("error", (err) => {
  console.error("[realtime-ws] server error", err);
});