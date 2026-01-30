"use client";

import { useMemo } from "react";
import { useRealtimeState } from "@/lib/realtime/useRealtimeState";

function fmtLastSeen(ms: number | null | undefined) {
  if (ms == null) return "null";
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return String(ms);
  }
}

export default function SymbolFreshnessBadge({ symbol }: { symbol: string }) {
  const sym = String(symbol ?? "").trim().toUpperCase();

  const snap = useRealtimeState((s) => ({
    staleAfterMs: s.symbolStatus.staleAfterMs,
    lastSeenAtBySymbol: s.symbolStatus.lastSeenAtBySymbol,
    isStaleBySymbol: s.symbolStatus.isStaleBySymbol,
  }));

  const view = useMemo(() => {
    const lastSeen = snap.lastSeenAtBySymbol?.[sym] ?? null;

    const staleRaw = snap.isStaleBySymbol?.[sym];
    const stale =
      typeof staleRaw === "boolean"
        ? staleRaw
        : null; // unknown if missing

    const staleAfterMs =
      typeof snap.staleAfterMs === "number" ? snap.staleAfterMs : null;

    return { sym, lastSeen, stale, staleAfterMs };
  }, [sym, snap.lastSeenAtBySymbol, snap.isStaleBySymbol, snap.staleAfterMs]);

  const staleLabel =
    view.stale === null ? "stale:unknown" : view.stale ? "stale:true" : "stale:false";

  return (
    <div
      className="inline-flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950/60 px-2 py-1 text-[11px] text-neutral-200"
      title={`Phase 6 truth for ${view.sym}`}
    >
      <span className="text-neutral-400">{view.sym}</span>
      <span className="text-neutral-600">|</span>
      <span>{staleLabel}</span>
      <span className="text-neutral-600">|</span>
      <span className="text-neutral-400">lastSeen:</span>
      <span className="font-medium">{fmtLastSeen(view.lastSeen)}</span>

      {view.staleAfterMs != null ? (
        <>
          <span className="text-neutral-600">|</span>
          <span className="text-neutral-400">staleAfterMs:</span>
          <span className="font-medium">{String(view.staleAfterMs)}</span>
        </>
      ) : null}
    </div>
  );
}