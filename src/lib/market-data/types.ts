export type Candle = {
  time: number;        // epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type CandleResponse = {
  target: string;
  range: string;
  resolution: string;
  candles: Candle[];
  source: "stub";
};