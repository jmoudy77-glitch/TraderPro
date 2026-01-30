"use client";

import { useMemo } from "react";
import { useRealtimeState } from "@/lib/realtime/useRealtimeState";

function fmtIso(iso: string | null | undefined) {
  if (!iso) return "null";
  return iso;
}

export default function ProviderStatusIndicator() {
  const s = useRealtimeState((st) => ({
    connectionState: st.connectionState,
    providerStatus: st.providerStatus,
    lastMessageAt: st.lastMessageAt,
  }));

  const view = useMemo(() => {
    const ps = s.providerStatus as any | null;

    const conn = s.connectionState;
    const rawState = ps?.state ?? "unknown";
    const isStale = typeof ps?.isStale === "boolean" ? ps.isStale : null;

    const feed = ps?.feed ?? "";
    const lastEventAt = ps?.lastEventAt ?? null;
    const lastError = ps?.lastError ?? null;

    return { conn, rawState, isStale, feed, lastEventAt, lastError };
  }, [s.connectionState, s.providerStatus]);

  // Rendering rules (non-inference):
  // - conn drives disconnected/reconnecting labels
  // - providerStatus.state and isStale displayed verbatim when present
  // - do not treat stale as error

  const connLabel =
    view.conn === "connected"
      ? "connected"
      : view.conn === "connecting"
        ? "connecting"
        : view.conn === "reconnecting"
          ? "reconnecting"
          : "disconnected";

  const staleLabel =
    view.isStale === null ? "stale:unknown" : view.isStale ? "stale:true" : "stale:false";

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 10px",
        borderRadius: 10,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(255,255,255,0.04)",
        fontSize: 12,
        lineHeight: "16px",
        whiteSpace: "nowrap",
      }}
      title="Phase 6 truth: WS connectionState + providerStatus verbatim"
    >
      <span style={{ opacity: 0.9 }}>realtime</span>

      <span style={{ opacity: 0.8 }}>|</span>

      <span>
        <strong>{connLabel}</strong>
      </span>

      <span style={{ opacity: 0.8 }}>|</span>

      <span>
        state:<strong>{String(view.rawState)}</strong>
      </span>

      <span style={{ opacity: 0.8 }}>|</span>

      <span>{staleLabel}</span>

      {view.feed ? (
        <>
          <span style={{ opacity: 0.8 }}>|</span>
          <span>feed:{String(view.feed)}</span>
        </>
      ) : null}

      <>
        <span style={{ opacity: 0.8 }}>|</span>
        <span>lastEventAt:{fmtIso(view.lastEventAt)}</span>
      </>

      {view.lastError ? (
        <>
          <span style={{ opacity: 0.8 }}>|</span>
          <span>lastError:{String(view.lastError)}</span>
        </>
      ) : null}
    </div>
  );
}