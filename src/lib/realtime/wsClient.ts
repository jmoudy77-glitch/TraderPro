// Deprecated in Phase 6-3.
// This module must not own a WebSocket connection.
// Use `src/lib/realtime/wsClientAdapter.ts` (the single socket owner) instead.

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

function deprecated(): never {
  throw new Error(
    "RealtimeWsClient is deprecated in Phase 6-3. Use realtimeWsAdapter from src/lib/realtime/wsClientAdapter.ts (single socket owner)."
  );
}

// Kept only to avoid breaking legacy imports.
// It intentionally does NOT create/own a WebSocket.
export class RealtimeWsClient {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_url: string, _handlers: Handlers = {}) {
    // no-op
  }

  connect() {
    deprecated();
  }

  close() {
    // no-op (legacy safe)
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  subscribe(_symbols: string[]) {
    deprecated();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  unsubscribe(_symbols: string[]) {
    deprecated();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getLatest(_symbols: string[]) {
    deprecated();
  }
}