// src/lib/realtime/realtimeState.ts
//
// Phase 6-4: Centralized Realtime State (truth-preserving).
// - No background polling.
// - No inference/smoothing.
// - Stores raw HTTP + WS payloads, renders verbatim in UI.

import { realtimeWsAdapter } from "@/lib/realtime/wsClientAdapter";

export type IntradayResolution = "1m" | "5m" | "30m";

export type HealthPayload =
  | {
      ok: true;
      [k: string]: any; // truth-preserving: store verbatim
    }
  | {
      ok: false;
      error: { code: string; message: string; upstream: "fly"; status: number | null };
    };

export type CandlesPayload =
  | {
      candles: any[];
      meta: Record<string, any>;
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

  // HTTP snapshots (verbatim)
  lastHealth: HealthPayload | null;

  // HTTP candles keyed by symbol|res
  intradayByKey: Record<
    string,
    {
      key: string; // `${SYMBOL}|${res}`
      symbol: string;
      res: IntradayResolution;
      payload: CandlesPayload;
      fetchedAt: number;
    }
  >;
};

type Listener = () => void;

function normalizeSymbols(symbols: string[]): string[] {
  return (symbols ?? [])
    .map((s) => String(s ?? "").trim().toUpperCase())
    .filter(Boolean);
}

function keyFor(symbol: string, res: IntradayResolution) {
  return `${symbol}|${res}`;
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

  intradayByKey: {},
};

const listeners = new Set<Listener>();

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
    intradayByKey: { ...state.intradayByKey },
    lastHealth: state.lastHealth
      ? typeof state.lastHealth === "object"
        ? { ...(state.lastHealth as any) }
        : state.lastHealth
      : null,
  };
}

// Cached snapshot that is stable between emits
let snapshot: RealtimeState = buildSnapshot();

function emit() {
  snapshot = buildSnapshot();
  for (const l of listeners) l();
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

  async fetchIntradayCandles(
    symbol: string,
    res: IntradayResolution,
    limit?: number
  ): Promise<CandlesPayload> {
    const sym = String(symbol ?? "").trim().toUpperCase();

    const params = new URLSearchParams();
    params.set("symbol", sym);
    params.set("res", res);
    if (limit != null) params.set("limit", String(limit));

    const url = `/api/realtime/candles/intraday?${params.toString()}`;
    const httpRes = await fetch(url, { method: "GET", cache: "no-store" });
    const text = await httpRes.text();

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

    const k = keyFor(sym, res);
    state.intradayByKey[k] = {
      key: k,
      symbol: sym,
      res,
      payload: json as CandlesPayload,
      fetchedAt: Date.now(),
    };
    emit();

    return state.intradayByKey[k].payload;
  },
};