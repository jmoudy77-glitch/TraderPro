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
      symbolsTracked: latestBySymbol.size
    });
  }

  // Keep non-WS traffic minimal.
  return json(res, 404, { ok: false, error: "NOT_FOUND" });
});

const wss = new WebSocketServer({ noServer: true });

// Upgrade only /ws
server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } catch {
    socket.destroy();
  }
});

function safeSend(ws, msg) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(msg));
}

wss.on("connection", (ws) => {
  subsByClient.set(ws, new Set());

  // basic ping/pong so intermediaries keep it alive
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  safeSend(ws, { type: "hello", now: new Date().toISOString() });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      safeSend(ws, { type: "error", error: "INVALID_JSON" });
      return;
    }

    // Message schema (v1):
    // { type: "subscribe", symbols: ["AAPL","NVDA"] }
    // { type: "unsubscribe", symbols: [...] }
    // { type: "get_latest", symbols?: [...] }
    if (msg?.type === "subscribe") {
      const set = subsByClient.get(ws);
      for (const s of msg.symbols ?? []) {
        const sym = String(s).trim().toUpperCase();
        if (sym) set.add(sym);
      }
      safeSend(ws, { type: "subscribed", symbols: Array.from(set) });
      return;
    }

    if (msg?.type === "unsubscribe") {
      const set = subsByClient.get(ws);
      for (const s of msg.symbols ?? []) {
        const sym = String(s).trim().toUpperCase();
        if (sym) set.delete(sym);
      }
      safeSend(ws, { type: "subscribed", symbols: Array.from(set) });
      return;
    }

    if (msg?.type === "get_latest") {
      const ask = (msg.symbols ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
      const out = {};
      const keys = ask.length ? ask : Array.from(latestBySymbol.keys());
      for (const k of keys) out[k] = latestBySymbol.get(k) ?? null;
      safeSend(ws, { type: "latest", data: out });
      return;
    }

    safeSend(ws, { type: "error", error: "UNKNOWN_MESSAGE_TYPE" });
  });

  ws.on("close", () => {
    subsByClient.delete(ws);
  });
});

// heartbeat
setInterval(() => {
  for (const ws of subsByClient.keys()) {
    if (ws.isAlive === false) {
      ws.terminate();
      subsByClient.delete(ws);
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

// --- Alpaca ingress scaffold (off by default) ---
// When enabled, this service becomes the producer of WS truth for "now".
// Alpaca WebSocket auth is an "auth" message with key/secret payload.  [oai_citation:2‡Alpaca API Docs](https://docs.alpaca.markets/docs/websocket-streaming?utm_source=chatgpt.com)
const ALPACA_ENABLED = process.env.ALPACA_ENABLED === "1";
// (You will set these in Fly secrets later)
const ALPACA_KEY = process.env.ALPACA_KEY ?? "";
const ALPACA_SECRET = process.env.ALPACA_SECRET ?? "";
const ALPACA_WS_URL = process.env.ALPACA_WS_URL ?? ""; // e.g. wss://stream.data.alpaca.markets/v2/iex

async function startAlpaca() {
  if (!ALPACA_ENABLED) return;
  if (!ALPACA_WS_URL || !ALPACA_KEY || !ALPACA_SECRET) {
    console.error("[alpaca] missing env (ALPACA_WS_URL, ALPACA_KEY, ALPACA_SECRET)");
    return;
  }

  const { WebSocket } = await import("ws");
  const ws = new WebSocket(ALPACA_WS_URL);

  ws.on("open", () => {
    ws.send(JSON.stringify({ action: "auth", key: ALPACA_KEY, secret: ALPACA_SECRET }));
    // subscriptions come next (we’ll implement symbol set later)
    console.log("[alpaca] connected");
  });

  ws.on("message", (raw) => {
    // v1: treat raw Alpaca payload as “event”; normalize later.
    let data;
    try { data = JSON.parse(String(raw)); } catch { return; }

    // You’ll normalize to your own event schema later.
    // For now, just stash “latest per symbol” if symbol present.
    const events = Array.isArray(data) ? data : [data];
    for (const ev of events) {
      const sym = (ev?.S ?? ev?.symbol ?? "").toString().trim().toUpperCase();
      if (!sym) continue;

      latestBySymbol.set(sym, { ts: new Date().toISOString(), raw: ev });

      // fanout to subscribed clients only
      for (const [client, subs] of subsByClient.entries()) {
        if (!subs.has(sym)) continue;
        safeSend(client, { type: "event", symbol: sym, event: ev });
      }
    }
  });

  ws.on("close", () => console.error("[alpaca] closed"));
  ws.on("error", (e) => console.error("[alpaca] error", e));
}

server.listen(PORT, HOST, async () => {
  console.log(`[realtime-ws] listening on ${HOST}:${PORT}`);
  await startAlpaca();
});

server.on("error", (err) => {
  console.error("[realtime-ws] server error", err);
});