// src/lib/market-data/indicators.ts

import type { UTCTimestamp } from "lightweight-charts";
import type { Candle } from "@/lib/market-data/types";

export type LinePoint = {
  time: UTCTimestamp;
  value: number;
};

export type MacdSeries = {
  macd: LinePoint[];
  signal: LinePoint[];
  histogram: LinePoint[];
};


export function toUTCTimestamp(t: number): UTCTimestamp {
  // If t looks like milliseconds since epoch, convert to seconds.
  // Otherwise assume it's already seconds.
  const seconds = t > 20_000_000_000 ? Math.floor(t / 1000) : Math.floor(t);
  return seconds as UTCTimestamp;
}

export function normalizeCandles(candles: Candle[]): Candle[] {
  // Sort ascending by normalized timestamp and de-dupe (keep last candle per timestamp).
  const sorted = [...candles].sort(
    (a, b) => toUTCTimestamp(a.time) - toUTCTimestamp(b.time)
  );

  const out: Candle[] = [];
  for (const c of sorted) {
    const t = toUTCTimestamp(c.time);
    const last = out[out.length - 1];
    if (!last) {
      out.push(c);
      continue;
    }

    const lastT = toUTCTimestamp(last.time);
    if (t === lastT) {
      out[out.length - 1] = c; // keep last
    } else if (t > lastT) {
      out.push(c);
    }
  }

  return out;
}

/**
 * RSI (Wilder's smoothing), standard implementation.
 * - Computes RSI over `period` using close prices.
 * - Returns points starting at the first RSI value (index = period).
 */
export function computeRsi(candlesInput: Candle[], period = 14): LinePoint[] {
  const candles = normalizeCandles(candlesInput);
  if (candles.length < period + 1) return [];

  const closes = candles.map((c) => c.close);

  // Initial average gain/loss across the first `period` deltas.
  let gainSum = 0;
  let lossSum = 0;

  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gainSum += delta;
    else lossSum += -delta;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  const out: LinePoint[] = [];

  // First RSI point corresponds to candle index = period
  out.push({
    time: toUTCTimestamp(candles[period].time),
    value: rsiFromAverages(avgGain, avgLoss),
  });

  // Wilder smoothing for the rest
  for (let i = period + 1; i < candles.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    out.push({
      time: toUTCTimestamp(candles[i].time),
      value: rsiFromAverages(avgGain, avgLoss),
    });
  }

  return out;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function constantLineFromCandles(
  candlesInput: Candle[],
  value: number
): LinePoint[] {
  const candles = normalizeCandles(candlesInput);
  return candles.map((c) => ({
    time: toUTCTimestamp(c.time),
    value,
  }));
}

/**
 * MACD (Moving Average Convergence Divergence)
 * - Standard default: fast=12, slow=26, signal=9
 * - Returns 3 series aligned by timestamp:
 *   - macd = emaFast - emaSlow
 *   - signal = ema(macd, signalPeriod)
 *   - histogram = macd - signal
 */
export function computeMacd(
  candlesInput: Candle[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): MacdSeries {
  const candles = normalizeCandles(candlesInput);
  const n = candles.length;

  // Need enough data to compute slow EMA and then a signal EMA on top.
  if (n < slowPeriod + signalPeriod) {
    return { macd: [], signal: [], histogram: [] };
  }

  const closes = candles.map((c) => c.close);
  const emaFast = ema(closes, fastPeriod);
  const emaSlow = ema(closes, slowPeriod);

  const macdRaw: number[] = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalRaw = ema(macdRaw, signalPeriod);

  const macd: LinePoint[] = [];
  const signal: LinePoint[] = [];
  const histogram: LinePoint[] = [];

  const start = Math.max(slowPeriod - 1, signalPeriod - 1);

  for (let i = start; i < n; i++) {
    const t = toUTCTimestamp(candles[i].time);
    const m = macdRaw[i];
    const s = signalRaw[i];
    macd.push({ time: t, value: m });
    signal.push({ time: t, value: s });
    histogram.push({ time: t, value: m - s });
  }

  return { macd, signal, histogram };
}

function ema(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length);
  if (values.length === 0) return [];

  const k = 2 / (period + 1);

  // Seed with the first value (analysis-grade stable)
  out[0] = values[0];

  for (let i = 1; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }

  return out;
}