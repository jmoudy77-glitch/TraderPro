// src/lib/realtime/wsClientAdapter.ts
//
// Phase 6-3 (Locked): Single WS Client Adapter
// - One socket. One owner.
// - Truth-preserving: store WS payloads verbatim; no inference.
// - Reconnect w/ deterministic exponential backoff (250ms -> max 10s).
// - Idempotent connect/disconnect.
// - Subscribe/unsubscribe w/ internal dedup.
// - Unknown message types ignored safely (optional dev log).

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export type ProviderStatus = {
  enabled: boolean;
  feed: "sip" | "iex" | "" | string | null;
  state: "disabled" | "connecting" | "subscribed" | "reconnecting" | "" | string;
  since: string;
  lastEventAt: string | null;
  lastError: string | null;
  isStale: boolean;
  reconnectAttempt: number;
  nextRetryAt: number | null;
  lastDisconnectAt: number | null;
};

export type SymbolStatusState = {
  staleAfterMs: number | null;
  lastSeenAtBySymbol: Record<string, number | null>;
  isStaleBySymbol: Record<string, boolean>;
};

export type LastError = { code: string; message: string; at: number } | null;

type HelloMsg = { type: "hello"; now: string };
type ProviderStatusMsg = { type: "provider_status"; provider_status: ProviderStatus };
type SymbolStatusMsg = {
  type: "symbol_status";
  now: string;
  staleAfterMs: number;
  lastSeenAtBySymbol: Record<string, number | null>;
  isStaleBySymbol: Record<string, boolean>;
  provider_status: ProviderStatus;
};
type MdMsg =
  | ({ type: "md"; symbol: string; ts: number } & Record<string, any>)
  | ({ type: "latest"; symbol: string; ts: number } & Record<string, any>);
type Ticks1sMsg = {
  type: "ticks_1s";
  ts: number;
  ticks: Record<string, { p: number; t: number }>;
  provider_status?: ProviderStatus;
};
type ErrorMsg = { type: "error"; code: string; message: string };

type IncomingMsg = HelloMsg | ProviderStatusMsg | SymbolStatusMsg | Ticks1sMsg | MdMsg | ErrorMsg | { type: string; [k: string]: any };

type AdapterState = {
  connectionState: ConnectionState;
  lastMessageAt: number | null;
  providerStatus: ProviderStatus | null;
  symbolStatus: SymbolStatusState;
  // Truth-preserving: raw md/latest payloads keyed by symbol
  lastTickBySymbol: Record<string, any>;
  lastError: LastError;
};

type Listener = (state: AdapterState) => void;

const WS_URL = "wss://traderpro-realtime-ws.fly.dev/ws";

// Backoff (deterministic)
const INITIAL_DELAY_MS = 250;
const MAX_DELAY_MS = 10_000;
// Optional tiny jitter to avoid thundering herd; bounded and never exceeds max.
const JITTER_MS = 100;

export class RealtimeWsClientAdapter {
  private ws: WebSocket | null = null;

  private intentionallyDisconnected = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = INITIAL_DELAY_MS;
  private reconnectAttemptLocal = 0;

  private tracked = new Set<string>();

  private listeners = new Set<Listener>();

  private state: AdapterState = {
    connectionState: "disconnected",
    lastMessageAt: null,
    providerStatus: null,
    symbolStatus: {
      staleAfterMs: null,
      lastSeenAtBySymbol: {},
      isStaleBySymbol: {},
    },
    lastTickBySymbol: {},
    lastError: null,
  };

  // ---- Public: state (read-only) ----
  get connectionState() {
    return this.state.connectionState;
  }
  get lastMessageAt() {
    return this.state.lastMessageAt;
  }
  get providerStatus() {
    return this.state.providerStatus;
  }
  get symbolStatus() {
    return this.state.symbolStatus;
  }
  get lastTickBySymbol() {
    return this.state.lastTickBySymbol;
  }
  get lastError() {
    return this.state.lastError;
  }

  // Useful for Phase 6-4 centralization
  getState(): AdapterState {
    // return a shallow copy so consumers can't mutate internal state
    return {
      ...this.state,
      symbolStatus: {
        staleAfterMs: this.state.symbolStatus.staleAfterMs,
        lastSeenAtBySymbol: { ...this.state.symbolStatus.lastSeenAtBySymbol },
        isStaleBySymbol: { ...this.state.symbolStatus.isStaleBySymbol },
      },
      lastTickBySymbol: { ...this.state.lastTickBySymbol },
    };
  }

  subscribeState(listener: Listener): () => void {
    this.listeners.add(listener);
    // immediately emit current state
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  // ---- Public: commands ----
  connect(): void {
    if (typeof window === "undefined") return; // never connect on server
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this.intentionallyDisconnected = false;
    this.clearReconnectTimer();

    this.setConnectionState(this.state.connectionState === "connected" ? "connected" : "connecting");

    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectDelayMs = INITIAL_DELAY_MS;
      this.reconnectAttemptLocal = 0;

      this.setConnectionState("connected");

      // Resubscribe tracked symbols immediately on connect.
      const syms = this.getTrackedSymbols();
      if (syms.length) this.send({ type: "subscribe", symbols: syms });
    });

    ws.addEventListener("message", (ev) => {
      const raw = String(ev.data ?? "");
      let msg: IncomingMsg | null = null;

      try {
        msg = JSON.parse(raw);
      } catch {
        // Ignore malformed messages safely.
        return;
      }

      if (!msg || typeof msg !== "object" || typeof (msg as any).type !== "string") return;

      this.state.lastMessageAt = Date.now();

      switch ((msg as any).type) {
        case "hello": {
          // no additional state beyond lastMessageAt
          this.emit();
          return;
        }

        case "provider_status": {
          const p = (msg as ProviderStatusMsg).provider_status;
          this.state.providerStatus = p;
          this.emit();
          return;
        }

        case "symbol_status": {
          const p = msg as SymbolStatusMsg;
          this.state.symbolStatus = {
            staleAfterMs: p.staleAfterMs ?? null,
            lastSeenAtBySymbol: p.lastSeenAtBySymbol ?? {},
            isStaleBySymbol: p.isStaleBySymbol ?? {},
          };
          // Also update providerStatus from the payload (truth-preserving).
          this.state.providerStatus = p.provider_status ?? this.state.providerStatus;
          this.emit();
          return;
        }

        case "ticks_1s": {
          const m = msg as Ticks1sMsg;
          const ticks = m.ticks;

          if (ticks && typeof ticks === "object") {
            for (const [symRaw, v] of Object.entries(ticks as Record<string, { p: number; t: number }>)) {
              const sym = String(symRaw ?? "").trim().toUpperCase();
              if (!sym || !v) continue;

              this.state.lastTickBySymbol[sym] = {
                p: v.p,
                t: v.t,
              };
            }
          }

          if (m.provider_status) {
            this.state.providerStatus = m.provider_status;
          }

          this.emit();
          return;
        }

        case "md": {
          const anyMsg = msg as any;

          // realtime-ws shape: { type:"md", event:{symbol, ts, price, ...}, provider_status:{...} }
          const ev = (anyMsg?.event ?? null) as any;
          const symbol = String(ev?.symbol ?? "").trim().toUpperCase();

          if (symbol) {
            this.state.lastTickBySymbol[symbol] = {
              ...(ev ?? {}),
              provider_status: anyMsg?.provider_status ?? null,
            };
          }

          // Keep provider status truth-preserving when present.
          if (anyMsg?.provider_status) {
            this.state.providerStatus = anyMsg.provider_status;
          }

          this.emit();
          return;
        }

        case "latest": {
          const anyMsg = msg as any;

          // realtime-ws shape: { type:"latest", latest:{ [SYM]: event } }
          const latest = anyMsg?.latest;
          if (latest && typeof latest === "object") {
            for (const [k, v] of Object.entries(latest)) {
              const sym = String(k ?? "").trim().toUpperCase();
              if (!sym) continue;
              this.state.lastTickBySymbol[sym] = v as any;
            }
          }

          this.emit();
          return;
        }

        case "error": {
          const e = msg as ErrorMsg;
          this.state.lastError = { code: e.code ?? "ERROR", message: e.message ?? "", at: Date.now() };
          this.emit();
          return;
        }

        default: {
          // Unknown message types must not crash. Dev-log is optional.
          if (process.env.NODE_ENV !== "production") {
             
            console.debug("[ws-adapter] unknown message type:", (msg as any).type);
          }
          this.emit();
          return;
        }
      }
    });

    ws.addEventListener("close", () => {
      this.ws = null;

      if (this.intentionallyDisconnected) {
        this.setConnectionState("disconnected");
        return;
      }

      this.setConnectionState("reconnecting");
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // Let close handler drive reconnect if the socket dies.
      // If it doesn't close, we do not force disconnect here (truth law).
    });
  }

  disconnect(): void {
    this.intentionallyDisconnected = true;
    this.clearReconnectTimer();

    try {
      this.ws?.close();
    } catch {
      // noop
    } finally {
      this.ws = null;
      this.setConnectionState("disconnected");
    }
  }

  subscribe(symbols: string[]): void {
    const next = this.normalizeSymbols(symbols);
    if (!next.length) return;

    let changed = false;
    for (const s of next) {
      if (!this.tracked.has(s)) {
        this.tracked.add(s);
        changed = true;
      }
    }

    if (!changed) return;
    this.send({ type: "subscribe", symbols: next });
  }

  unsubscribe(symbols: string[]): void {
    const next = this.normalizeSymbols(symbols);
    if (!next.length) return;

    let changed = false;
    for (const s of next) {
      if (this.tracked.delete(s)) changed = true;
    }

    if (!changed) return;
    this.send({ type: "unsubscribe", symbols: next });
  }

  getTrackedSymbols(): string[] {
    return Array.from(this.tracked.values());
  }

  setTrackedSymbols(symbols: string[]): void {
    const nextSet = new Set(this.normalizeSymbols(symbols));
    const curSet = this.tracked;

    const toSub: string[] = [];
    const toUnsub: string[] = [];

    for (const s of nextSet) if (!curSet.has(s)) toSub.push(s);
    for (const s of curSet) if (!nextSet.has(s)) toUnsub.push(s);

    // Apply changes locally first (truth-safe; just tracked intent).
    this.tracked = nextSet;

    if (toUnsub.length) this.send({ type: "unsubscribe", symbols: toUnsub });
    if (toSub.length) this.send({ type: "subscribe", symbols: toSub });
  }

  // ---- Internal ----
  private normalizeSymbols(symbols: string[]): string[] {
    return (symbols ?? [])
      .map((s) => String(s ?? "").trim().toUpperCase())
      .filter(Boolean);
  }

  private send(msg: any): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // noop
    }
  }

  private emitScheduled = false;

private emit(): void {
  if (this.emitScheduled) return;
  this.emitScheduled = true;

  queueMicrotask(() => {
    this.emitScheduled = false;
    const snapshot = this.getState();
    for (const l of this.listeners) l(snapshot);
  });
}

  private setConnectionState(next: ConnectionState): void {
    if (this.state.connectionState === next) return;
    this.state.connectionState = next;
    this.emit();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const base = Math.min(this.reconnectDelayMs, MAX_DELAY_MS);
    const jitter = Math.min(JITTER_MS, Math.floor(base * 0.1));
    const delay = Math.min(MAX_DELAY_MS, base + (jitter ? Math.floor(Math.random() * jitter) : 0));

    this.reconnectAttemptLocal += 1;
    this.reconnectDelayMs = Math.min(MAX_DELAY_MS, base * 2);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionallyDisconnected) return;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

// Single owner instance (authoritative)
export const realtimeWsAdapter = new RealtimeWsClientAdapter();