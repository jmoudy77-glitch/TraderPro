"use client";

import { useEffect, useMemo, useState } from "react";
import { realtimeWsAdapter, ProviderStatus } from "@/lib/realtime/wsClientAdapter";

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

if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as any).realtimeWsAdapter = realtimeWsAdapter;
}

export default function RealtimeTestPage() {
  const defaultSyms = useMemo(() => parseSymbolsFromQuery(), []);
  const symbols = defaultSyms.length ? defaultSyms : ["SPY", "QQQ", "AAPL"];

  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const unsub = realtimeWsAdapter.subscribeState((s) => {
      setConnected(s.connectionState === "connected");
      setProvider(s.providerStatus);
    });

    // Ensure connection and subscription (idempotent).
    realtimeWsAdapter.connect();
    realtimeWsAdapter.setTrackedSymbols(symbols);

    return () => {
      unsub();
      // Do NOT disconnect here; adapter is global single owner.
      // Page unmount should not tear down the shared socket.
    };
  }, [symbols.join(",")]);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const retryInSec = provider?.nextRetryAt ? Math.max(0, Math.floor((provider.nextRetryAt - nowMs) / 1000)) : null;

  return (
    <div style={{ padding: 16, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Realtime WS Test</h1>

      <div style={{ marginBottom: 16 }}>
        <div>
          <strong>WS:</strong> wss://traderpro-realtime-ws.fly.dev/ws
        </div>
        <div>
          <strong>Symbols:</strong> {symbols.join(", ")}
        </div>
        <div>
          <strong>Connected:</strong> {connected ? "yes" : "no"}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, maxWidth: 900 }}>
        <section style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Provider status (raw)</h2>
          {!provider ? (
            <div>—</div>
          ) : (
            <div style={{ display: "grid", gap: 4 }}>
              <div>
                <strong>state:</strong> {provider.state}
              </div>
              <div>
                <strong>since:</strong> {provider.since}
              </div>
              <div>
                <strong>lastEventAt:</strong> {provider.lastEventAt ?? "—"}
              </div>
              <div>
                <strong>lastError:</strong> {provider.lastError ?? "—"}
              </div>
              <div>
                <strong>isStale:</strong> {String(provider.isStale)}
              </div>
              <div>
                <strong>reconnectAttempt:</strong> {provider.reconnectAttempt ?? "—"}
              </div>
              <div>
                <strong>nextRetryAt:</strong> {provider.nextRetryAt ? new Date(provider.nextRetryAt).toISOString() : "—"}{" "}
                {retryInSec != null ? `(${retryInSec}s)` : ""}
              </div>
              <div>
                <strong>lastDisconnectAt:</strong> {provider.lastDisconnectAt ? new Date(provider.lastDisconnectAt).toISOString() : "—"}
              </div>
            </div>
          )}
        </section>

        <section style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Symbol freshness (raw)</h2>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            {JSON.stringify(realtimeWsAdapter.getState().symbolStatus, null, 2)}
          </pre>
        </section>

        <section style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Adapter state (raw)</h2>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            {JSON.stringify(realtimeWsAdapter.getState(), null, 2)}
          </pre>
        </section>
      </div>
    </div>
  );
}