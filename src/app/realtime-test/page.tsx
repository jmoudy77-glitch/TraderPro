"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { RealtimeWsClient, ProviderStatus, SymbolStatusPayload, MarketDataPayload } from "@/lib/realtime/wsClient";

const WS_URL = "wss://traderpro-realtime-ws.fly.dev/ws";

function parseSymbolsFromQuery(): string[] {
  if (typeof window === "undefined") return [];
  const params = new URLSearchParams(window.location.search);
  const raw = (params.get("symbols") ?? "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export default function RealtimeTestPage() {
  const defaultSyms = useMemo(() => parseSymbolsFromQuery(), []);
  const symbols = defaultSyms.length ? defaultSyms : ["SPY", "QQQ", "AAPL"];

  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [symbolStatus, setSymbolStatus] = useState<SymbolStatusPayload | null>(null);
  const [latestBySymbol, setLatestBySymbol] = useState<Record<string, any>>({});
  const [connected, setConnected] = useState(false);

  const clientRef = useRef<RealtimeWsClient | null>(null);

  useEffect(() => {
    const client = new RealtimeWsClient(WS_URL, {
      onOpen: () => {
        setConnected(true);
        client.subscribe(symbols);
        client.getLatest(symbols);
      },
      onClose: () => setConnected(false),
      onProviderStatus: (s) => setProvider(s),
      onSymbolStatus: (p) => setSymbolStatus(p),
      onMarketData: (p: MarketDataPayload) => {
        const sym = String(p.event?.symbol ?? "").toUpperCase();
        if (!sym) return;
        setLatestBySymbol((prev) => ({ ...prev, [sym]: p.event }));
      },
    });

    clientRef.current = client;
    client.connect();

    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [symbols.join(",")]);

  const nowMs = Date.now();

  return (
    <div style={{ padding: 16, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Realtime WS Test</h1>

      <div style={{ marginBottom: 16 }}>
        <div><strong>WS:</strong> {WS_URL}</div>
        <div><strong>Symbols:</strong> {symbols.join(", ")}</div>
        <div><strong>Connected:</strong> {connected ? "yes" : "no"}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, maxWidth: 900 }}>
        <section style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Provider status</h2>
          {!provider ? (
            <div>—</div>
          ) : (
            <div style={{ display: "grid", gap: 4 }}>
              <div><strong>state:</strong> {provider.state}</div>
              <div><strong>since:</strong> {provider.since}</div>
              <div><strong>lastEventAt:</strong> {provider.lastEventAt ?? "—"}</div>
              <div><strong>lastError:</strong> {provider.lastError ?? "—"}</div>
              <div><strong>isStale:</strong> {String(provider.isStale)}</div>
            </div>
          )}
        </section>

        <section style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Symbol freshness</h2>
          {!symbolStatus ? (
            <div>—</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: "6px 0" }}>Symbol</th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: "6px 0" }}>Age (s)</th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: "6px 0" }}>Stale</th>
                </tr>
              </thead>
              <tbody>
                {symbols.map((sym) => {
                  const last = symbolStatus.lastSeenAtBySymbol[sym] ?? null;
                  const ageS = last ? Math.max(0, Math.round((nowMs - last) / 1000)) : null;
                  const stale = symbolStatus.isStaleBySymbol[sym] ?? true;
                  return (
                    <tr key={sym}>
                      <td style={{ padding: "6px 0" }}>{sym}</td>
                      <td style={{ padding: "6px 0" }}>{ageS == null ? "—" : ageS}</td>
                      <td style={{ padding: "6px 0" }}>{String(stale)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Latest tick (raw)</h2>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(latestBySymbol, null, 2)}</pre>
        </section>
      </div>
    </div>
  );
}