// src/lib/market-data/candles/types.ts

export type TargetKind = "SYMBOL" | "WATCHLIST_COMPOSITE";
export type Session = "regular" | "extended" | "auto";

export type CanonicalCandle = {
  time: number; // epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

// Back-compat alias during transition
export type Candle = CanonicalCandle;

// Keep meta flexible during transition; lock the important fields.
export type CanonicalMeta = Record<string, any> & {
  expectedBars?: number;
  receivedBars?: number;
  source?: string;
  session?: Session;
  res?: string;
  range?: string;
  window?: { start?: string; end?: string };
  fallbackUsed?: boolean;
  fallbackReason?: string;
  wsError?: any;
};

// -----------------------------------------------------------------------------
// Canonical candles/window contract (Phase 6)
// -----------------------------------------------------------------------------

export type CandleRange = "1D" | "5D" | "1M" | "3M" | "6M" | "1Y";

export type CandleResolution = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

export type CandleSession = "regular" | "extended";

export type CandlesWindowTarget =
  | { kind: "SYMBOL"; symbol: string }
  | { kind: "WATCHLIST_COMPOSITE"; watchlistKey: string; ownerUserId: string };

export type CandlesWindowMeta = {
  // Echo / normalization
  range?: string;
  res?: string;
  session?: CandleSession;
  normalizedFrom?: { range: string; res: string };

  // Window diagnostics
  expectedBars?: number;
  receivedBars?: number;
  window?: { start: string; end: string };

  // Source and fallback semantics
  source?: string;
  fallbackUsed?: boolean;
  fallbackReason?: "WS_ERROR" | "WS_EMPTY" | "WS_UNDERSUPPLIED" | "REST_FALLBACK_FAILED";

  // Cache semantics (when sourced from cache)
  cache_status?: "HIT" | "MISS" | "SOFT_MISS" | "BYPASS" | string;
  is_stale?: boolean;
  last_update_ts?: string | null;

  // Optional ws error surface
  wsError?: any;
};

export type CandlesWindowError = {
  code: string;
  message: string;
  upstream: string;
  status: number | null;
  body?: string | null;
};

export type CandlesWindowOkResponse = {
  ok: true;
  candles: CanonicalCandle[];
  meta: CandlesWindowMeta;
};

export type CandlesWindowErrorResponse = {
  ok: false;
  error: CandlesWindowError;
};

export type CandlesWindowResponse = CandlesWindowOkResponse | CandlesWindowErrorResponse;