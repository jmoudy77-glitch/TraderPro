// src/lib/realtime/realtimeState.ts
//
// Phase 6-4: Centralized Realtime State (truth-preserving).
// TICKS-ONLY CONTRACT (Single Endpoint Transition):
// - This module must NEVER fetch or cache historical candle arrays.
// - Historical hydration is exclusively served by `/api/market/candles/window` via useCandles.
// - This store only reflects WS tick ingestion + provider/subscription state.
// - No background polling.
// - No inference/smoothing.
// - Stores raw HTTP + WS payloads, renders verbatim in UI.

import { realtimeWsAdapter } from "@/lib/realtime/wsClientAdapter";

export type HealthPayload =
  | {
      ok: true;
      [k: string]: any; // truth-preserving: store verbatim
    }
  | {
      ok: false;
      error: { code: string; message: string; upstream: "fly"; status: number | null };
    };

export type RealtimeState = {
  // primary: WS-driven
  connectionState: "disconnected" | "connecting" | "connected" | "reconnecting";
  lastMessageAt: number | null;

  providerStatus: any | null; // verbatim provider_status.provider_status
  symbolStatus: {
    staleAfterMs: number | null;
    lastSeenAtBySymbol: Record<string, number | null>;
    isStaleBySymbol: Record<string, boolean>;
  };

  // tracked intent (UI-controlled)
  trackedSymbols: string[];

  // WS ticks (verbatim md/latest payloads)
  lastTickBySymbol: Record<string, any>;

  // HTTP snapshots (verbatim) — health only; no historical candle hydration
  lastHealth: HealthPayload | null;
};

type Listener = () => void;

function normalizeSymbols(symbols: string[]): string[] {
  return (symbols ?? [])
    .map((s) => String(s ?? "").trim().toUpperCase())
    .filter(Boolean);
}

const state: RealtimeState = {
  connectionState: "disconnected",
  lastMessageAt: null,

  providerStatus: null,
  symbolStatus: {
    staleAfterMs: null,
    lastSeenAtBySymbol: {},
    isStaleBySymbol: {},
  },

  trackedSymbols: [],

  lastTickBySymbol: {},

  lastHealth: null,
};


const listeners = new Set<Listener>();

const viewSymbolsById = new Map<string, string[]>();

function arraysEqual(a: string[], b: string[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function recomputeTrackedFromViews() {
  const union = new Set<string>();
  for (const syms of viewSymbolsById.values()) {
    for (const s of syms) union.add(s);
  }
  const next = Array.from(union).sort();

  // prevent churn
  if (arraysEqual(next, state.trackedSymbols)) return;

  state.trackedSymbols = next;
  realtimeWsAdapter.setTrackedSymbols(next);
  emit();
}

function buildSnapshot(): RealtimeState {
  return {
    ...state,
    symbolStatus: {
      staleAfterMs: state.symbolStatus.staleAfterMs,
      lastSeenAtBySymbol: { ...state.symbolStatus.lastSeenAtBySymbol },
      isStaleBySymbol: { ...state.symbolStatus.isStaleBySymbol },
    },
    trackedSymbols: [...state.trackedSymbols],
    lastTickBySymbol: { ...state.lastTickBySymbol },
    lastHealth: state.lastHealth
      ? typeof state.lastHealth === "object"
        ? { ...(state.lastHealth as any) }
        : state.lastHealth
      : null,
  };
}

// Cached snapshot that is stable between emits
let snapshot: RealtimeState = buildSnapshot();

let emitScheduled = false;

function emit() {
  if (emitScheduled) return;
  emitScheduled = true;

  queueMicrotask(() => {
    emitScheduled = false;
    snapshot = buildSnapshot();
    for (const l of listeners) l();
  });
}

export const realtimeState = {
  // ---- subscription ----
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  // IMPORTANT: returns a stable object until the next emit()
  getState(): RealtimeState {
    return snapshot;
  },

  // ---- lifecycle ----
  start() {
    if ((realtimeState as any)._started) return;
    (realtimeState as any)._started = true;

    const snap = realtimeWsAdapter.getState();
    state.connectionState = snap.connectionState;
    state.lastMessageAt = snap.lastMessageAt;
    state.providerStatus = snap.providerStatus;
    state.symbolStatus = snap.symbolStatus;
    state.lastTickBySymbol = snap.lastTickBySymbol ?? {};
    emit();

    realtimeWsAdapter.subscribeState((s) => {
      state.connectionState = s.connectionState;
      state.lastMessageAt = s.lastMessageAt;
      state.providerStatus = s.providerStatus;
      state.symbolStatus = s.symbolStatus;
      state.lastTickBySymbol = s.lastTickBySymbol ?? {};
      emit();
    });

    realtimeWsAdapter.connect();

    if (state.trackedSymbols.length) {
      realtimeWsAdapter.setTrackedSymbols(state.trackedSymbols);
    }
  },

  stop() {
    // explicit stop: disconnect socket and stop updates
    realtimeWsAdapter.disconnect();
    state.connectionState = "disconnected";
    emit();
  },

  setTrackedSymbols(symbols: string[]) {
    const next = normalizeSymbols(symbols);
    state.trackedSymbols = next;
    realtimeWsAdapter.setTrackedSymbols(next);
    emit();
  },

  setViewSymbols(viewId: string, symbols: string[]) {
    const id = String(viewId ?? "").trim();
    if (!id) return;

    const next = normalizeSymbols(symbols).sort();
    const prev = viewSymbolsById.get(id) ?? [];

    if (arraysEqual(prev, next)) return;

    viewSymbolsById.set(id, next);
    recomputeTrackedFromViews();
  },

  clearViewSymbols(viewId: string) {
    const id = String(viewId ?? "").trim();
    if (!id) return;

    if (!viewSymbolsById.has(id)) return;

    viewSymbolsById.delete(id);
    recomputeTrackedFromViews();
  },

  async refreshHealth(): Promise<HealthPayload> {
    const res = await fetch("/api/realtime/health", { method: "GET", cache: "no-store" });
    const text = await res.text();

    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = {
        ok: false,
        error: {
          code: "BAD_JSON",
          message: "Non-JSON response",
          upstream: "fly",
          status: null,
        },
      };
    }

    state.lastHealth = json as HealthPayload;
    emit();
    return state.lastHealth;
  },
};