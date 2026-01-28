export type ChartTimeRange = "1D" | "5D" | "1M" | "3M" | "6M" | "1Y";
export type ChartResolution = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export type ChartTarget =
  | { type: "EMPTY" }
  | { type: "IXIC" }
  | { type: "SYMBOL"; symbol: string }
  | { type: "WATCHLIST_COMPOSITE"; watchlistKey: "LAUNCH_LEADERS" | "HIGH_VELOCITY_MULTIPLIERS" | "SLOW_BURNERS" };

export type Indicators = {
  rsi: boolean;
  macd: boolean;
  sma50: boolean;
  sma200: boolean;
};

export type ChartInstanceState = {
  key: string;
  target: ChartTarget;
  range: ChartTimeRange;
  resolution: ChartResolution;
  indicators: Indicators;
};

export const DEFAULT_INDICATORS: Indicators = {
  rsi: true,
  macd: true,
  sma50: true,
  sma200: true,
};

export const DEFAULT_RANGE: ChartTimeRange = "1D";
export const DEFAULT_RESOLUTION: ChartResolution = "5m";