"use client";

import React, { useEffect, useMemo, useRef } from "react";
import {
  createChart,
  type IChartApi,
  CrosshairMode,
  type ISeriesApi,
  type UTCTimestamp,
  CandlestickSeries,
  LineSeries,
} from "lightweight-charts";

import type { Candle } from "@/lib/market-data/types";

function toUTCTimestamp(t: number): UTCTimestamp {
  // If t looks like milliseconds since epoch, convert to seconds.
  // Otherwise assume it's already seconds.
  const seconds = t > 20_000_000_000 ? Math.floor(t / 1000) : Math.floor(t);
  return seconds as UTCTimestamp;
}

type Props = {
  candles: Candle[];
  visibleCount?: number;
  variant?: "primary" | "mini";
  priceIn?: number | null;
  onChartReady?: (chart: IChartApi | null) => void;
  showSma50?: boolean;
  showSma200?: boolean;
};

function toCandleSeriesData(c: Candle) {
  return {
    time: toUTCTimestamp(c.time),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  };
}

function toLineData(c: Candle, value: number) {
  return {
    time: toUTCTimestamp(c.time),
    value,
  };
}

function computeSma(candles: Candle[], period: number) {
  if (candles.length < period) return [];

  const out: { time: UTCTimestamp; value: number }[] = [];
  let sum = 0;

  for (let i = 0; i < candles.length; i++) {
    const close = candles[i].close;
    sum += close;

    if (i >= period) {
      sum -= candles[i - period].close;
    }

    if (i >= period - 1) {
      out.push({
        time: toUTCTimestamp(candles[i].time),
        value: sum / period,
      });
    }
  }

  return out;
}

function applyVisibleWindow(chart: IChartApi, dataLength: number, visibleCount?: number) {
  if (!visibleCount || visibleCount <= 0) {
    chart.timeScale().fitContent();
    return;
  }

  const to = Math.max(0, dataLength - 1);
  const from = Math.max(0, to - (visibleCount - 1));

  // Use logical range so we show exactly the last `visibleCount` bars.
  chart.timeScale().setVisibleLogicalRange({ from, to });
}

export default function CandlesChart({
  candles,
  visibleCount,
  onChartReady,
  variant = "primary",
  priceIn = null,
  showSma50 = true,
  showSma200 = true,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const priceInSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const sma50SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const sma200SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  const roRef = useRef<ResizeObserver | null>(null);

  const normalizedCandles = useMemo(() => {
    const sorted = [...candles].sort(
      (a, b) => toUTCTimestamp(a.time) - toUTCTimestamp(b.time)
    );

    // De-dupe by timestamp (keep the last candle for a given time)
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
        out[out.length - 1] = c;
      } else if (t > lastT) {
        out.push(c);
      }
    }

    return out;
  }, [candles]);

  const candleData = useMemo(
    () => normalizedCandles.map(toCandleSeriesData),
    [normalizedCandles]
  );
  const sma50 = useMemo(() => computeSma(normalizedCandles, 50), [normalizedCandles]);
  const sma200 = useMemo(() => computeSma(normalizedCandles, 200), [normalizedCandles]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "rgba(229,229,229,0.8)",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        visible: variant === "primary",
        borderVisible: false,
      },
      timeScale: {
        visible: true,
        borderVisible: false,
        secondsVisible: false,
        timeVisible: true,
      },
      handleScroll: true,
      handleScale: true,
    });

    const candlesSeries = chart.addSeries(CandlestickSeries, {
      wickUpColor: "rgba(34,197,94,0.95)",
      upColor: "rgba(34,197,94,0.65)",
      wickDownColor: "rgba(239,68,68,0.95)",
      downColor: "rgba(239,68,68,0.65)",
      borderVisible: false,
    });

    const priceInSeries = chart.addSeries(LineSeries, {
      color: "rgba(250,204,21,0.80)", // price-in
      lineWidth: 1,
      lineStyle: 2, // dashed
      priceLineVisible: variant === "primary",
      lastValueVisible: false,
    });

    const sma50Series = chart.addSeries(LineSeries, {
      color: "rgba(147,197,253,0.80)", // light blue
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const sma200Series = chart.addSeries(LineSeries, {
      color: "rgba(196,181,253,0.80)", // light violet
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    chartRef.current = chart;
    onChartReady?.(chart);
    candleSeriesRef.current = candlesSeries;
    priceInSeriesRef.current = priceInSeries;
    sma50SeriesRef.current = sma50Series;
    sma200SeriesRef.current = sma200Series;

    if (candleData.length > 0) {
      candlesSeries.setData(candleData);
      applyVisibleWindow(chart, candleData.length, visibleCount);
    }

    roRef.current = new ResizeObserver(() => {
      applyVisibleWindow(chart, candleData.length, visibleCount);
    });
    roRef.current.observe(el);

    return () => {
      roRef.current?.disconnect();
      roRef.current = null;
      onChartReady?.(null);
      chart.remove();
      chartRef.current = null;

      candleSeriesRef.current = null;
      priceInSeriesRef.current = null;
      sma50SeriesRef.current = null;
      sma200SeriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, visibleCount, candleData.length]);

  // Candles
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    if (!chart || !candleSeries) return;

    // Defensive: force a full refresh when the time axis is identical but prices change
    // (common when switching symbols on the same intraday range).
    try {
      candleSeries.setData([]);
    } catch {
      // ignore
    }

    candleSeries.setData(candleData);
    applyVisibleWindow(chart, candleData.length, visibleCount);
  }, [candleData, visibleCount]);

  // Price-in overlay
  useEffect(() => {
    const priceSeries = priceInSeriesRef.current;
    if (!priceSeries) return;

    if (!priceIn || normalizedCandles.length === 0) {
      priceSeries.setData([]);
      return;
    }

    priceSeries.setData(normalizedCandles.map((c) => toLineData(c, priceIn)));
  }, [priceIn, normalizedCandles]);

  // SMA50 overlay
  useEffect(() => {
    const s = sma50SeriesRef.current;
    if (!s) return;

    if (!showSma50) {
      s.setData([]);
      return;
    }

    s.setData(sma50);
  }, [showSma50, sma50]);

  // SMA200 overlay
  useEffect(() => {
    const s = sma200SeriesRef.current;
    if (!s) return;

    if (!showSma200) {
      s.setData([]);
      return;
    }

    s.setData(sma200);
  }, [showSma200, sma200]);

  return (
    <div className="h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}