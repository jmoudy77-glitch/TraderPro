export type ProviderStatus = {
  enabled: boolean;
  feed: string | null;
  state: string;
  since: string;
  lastEventAt: string | null;
  lastError: string | null;
  isStale: boolean;

  reconnectAttempt?: number;
  nextRetryAt?: number | null;
  lastDisconnectAt?: number | null;
};

export type SymbolStatusPayload = {
  type: "symbol_status";
  now: string;
  staleAfterMs: number;
  lastSeenAtBySymbol: Record<string, number | null>;
  isStaleBySymbol: Record<string, boolean>;
  provider_status: ProviderStatus;
};

export type ProviderStatusPayload = {
  type: "provider_status";
  provider_status: ProviderStatus;
};

export type MarketDataPayload = {
  type: "md";
  event: any;
  provider_status: ProviderStatus;
};

export type HelloPayload = { type: "hello"; now: string };
export type ErrorPayload = { type: "error"; error: string };
export type SubscribedPayload = { type: "subscribed"; symbols: string[] };

export type IncomingMessage =
  | HelloPayload
  | ProviderStatusPayload
  | SymbolStatusPayload
  | MarketDataPayload
  | SubscribedPayload
  | ErrorPayload
  | { type: string; [k: string]: any };

type Handlers = {
  onProviderStatus?: (s: ProviderStatus) => void;
  onSymbolStatus?: (p: SymbolStatusPayload) => void;
  onMarketData?: (p: MarketDataPayload) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (e: Event) => void;
};

export class RealtimeWsClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly handlers: Handlers;

  constructor(url: string, handlers: Handlers = {}) {
    this.url = url;
    this.handlers = handlers;
  }

  connect() {
    if (this.ws) return;

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => this.handlers.onOpen?.());
    ws.addEventListener("close", () => {
      this.ws = null;
      this.handlers.onClose?.();
    });
    ws.addEventListener("error", (e) => this.handlers.onError?.(e));

    ws.addEventListener("message", (ev) => {
      let msg: IncomingMessage | null = null;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }

      if (!msg || typeof msg !== "object") return;

      if (msg.type === "provider_status") {
        this.handlers.onProviderStatus?.((msg as ProviderStatusPayload).provider_status);
        return;
      }

      if (msg.type === "symbol_status") {
        this.handlers.onSymbolStatus?.(msg as SymbolStatusPayload);
        // also surface provider status from the same payload
        this.handlers.onProviderStatus?.((msg as SymbolStatusPayload).provider_status);
        return;
      }

      if (msg.type === "md") {
        this.handlers.onMarketData?.(msg as MarketDataPayload);
        this.handlers.onProviderStatus?.((msg as MarketDataPayload).provider_status);
        return;
      }
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // noop
    } finally {
      this.ws = null;
    }
  }

  subscribe(symbols: string[]) {
    this.send({ type: "subscribe", symbols });
  }

  unsubscribe(symbols: string[]) {
    this.send({ type: "unsubscribe", symbols });
  }

  getLatest(symbols: string[]) {
    this.send({ type: "get_latest", symbols });
  }

  private send(msg: any) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }
}