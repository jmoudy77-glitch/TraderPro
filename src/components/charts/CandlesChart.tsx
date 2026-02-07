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
  HistogramSeries,
} from "lightweight-charts";

import type { Candle } from "@/lib/market-data/types";
import { useUserPreferences } from "@/components/shell/AppShell";


type Props = {
  candles: Candle[];
  visibleCount?: number;
  variant?: "primary" | "mini";
  priceIn?: number | null;
  onChartReady?: (
    ctx:
      | {
          chart: IChartApi;
          candleSeries: ISeriesApi<"Candlestick">;
          volumeSeries?: ISeriesApi<"Histogram">;
        }
      | null
  ) => void;
  showSma50?: boolean;
  showSma200?: boolean;
  liveTick?: { ts: number; price: number } | { t: number; p: number } | null;
};

function timeToDate(t: UTCTimestamp | { year: number; month: number; day: number }): Date {
  if (typeof t === "number") return new Date(Number(t) * 1000);
  // business day
  return new Date(Date.UTC(t.year, t.month - 1, t.day, 0, 0, 0, 0));
}

function fmtAxis(
  ts: UTCTimestamp | { year: number; month: number; day: number },
  tz: string,
  daily: boolean
): string {
  const d = timeToDate(ts);
  if (daily) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      month: "short",
      day: "numeric",
    }).format(d);
  }

  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function fmtCrosshair(tsSeconds: number, tz: string, daily: boolean): string {
  const d = new Date(tsSeconds * 1000);
  if (daily) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "short",
      day: "2-digit",
    }).format(d);
  }

  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function toUTCTimestamp(t: number): UTCTimestamp {
  // If t looks like milliseconds since epoch, convert to seconds.
  // Otherwise assume it's already seconds.
  const seconds = t > 20_000_000_000 ? Math.floor(t / 1000) : Math.floor(t);
  return seconds as UTCTimestamp;
}

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

function applyVisibleWindow(
  chart: IChartApi,
  dataLength: number,
  variant: "primary" | "mini",
  visibleCount?: number
) {
  if (variant === "mini") {
    chart.timeScale().fitContent();
    return;
  }

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
  liveTick = null,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceInSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const sma50SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const sma200SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const barSecondsRef = useRef<number>(60);

  const lastBarStartRef = useRef<number | null>(null);
  const lastBarRef = useRef<{ time: UTCTimestamp; open: number; high: number; low: number; close: number } | null>(null);
  const lastPriceLineRef = useRef<any | null>(null);

  const roRef = useRef<ResizeObserver | null>(null);

  const { prefs } = useUserPreferences();

  const DEFAULT_TIMEZONE =
    process.env.NEXT_PUBLIC_DEV_OWNER_TZ ??
    process.env.DEV_OWNER_TZ ??
    "America/Chicago";

  function sanitizeTimezone(raw: unknown): string {
    const candidate = typeof raw === "string" ? raw.trim() : "";
    if (!candidate) return DEFAULT_TIMEZONE;

    try {
      new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date(0));
      return candidate;
    } catch {
      return DEFAULT_TIMEZONE;
    }
  }

  const timeZone = sanitizeTimezone(prefs?.timezone);

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

  const inferredDailySeries = useMemo(() => {
    if (normalizedCandles.length < 3) return false;

    const times = normalizedCandles
      .map((c) => toUTCTimestamp(c.time))
      .sort((a, b) => a - b);

    const deltas: number[] = [];
    for (let i = 1; i < times.length; i++) {
      const d = Number(times[i]) - Number(times[i - 1]);
      if (Number.isFinite(d) && d > 0) deltas.push(d);
    }

    if (deltas.length < 2) return false;

    deltas.sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)];

    // Treat ~1D bars as date-only (hide time-of-day) when spacing is >= ~20h.
    return median >= 60 * 60 * 20;
  }, [normalizedCandles]);

  const inferredBarSeconds = useMemo(() => {
    if (normalizedCandles.length < 3) return 60;

    const times = normalizedCandles
      .map((c) => Number(toUTCTimestamp(c.time)))
      .sort((a, b) => a - b);

    const deltas: number[] = [];
    for (let i = 1; i < times.length; i++) {
      const d = times[i] - times[i - 1];
      if (Number.isFinite(d) && d > 0) deltas.push(d);
    }

    if (deltas.length < 2) return 60;

    deltas.sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)];

    // Clamp to sane range: 1s..1d
    return Math.max(1, Math.min(86_400, Math.floor(median)));
  }, [normalizedCandles]);

  useEffect(() => {
    barSecondsRef.current = inferredBarSeconds;
  }, [inferredBarSeconds]);

  const candleData = useMemo(
    () => normalizedCandles.map(toCandleSeriesData),
    [normalizedCandles]
  );
  const volumeData = useMemo(() => {
    return normalizedCandles.map((c) => {
      const vol = Number((c as any).volume ?? 0);
      const up = c.close >= c.open;
      return {
        time: toUTCTimestamp(c.time),
        value: Number.isFinite(vol) ? vol : 0,
        color: up ? "rgba(34,197,94,0.45)" : "rgba(239,68,68,0.45)",
      };
    });
  }, [normalizedCandles]);
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
        attributionLogo: false,
      },
      localization: {
        timeFormatter: (time: UTCTimestamp) =>
          fmtCrosshair(Number(time), timeZone, inferredDailySeries),
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
        // When we are intraday, allow seconds so tick-driven updates can show true time granularity.
        secondsVisible: !inferredDailySeries,
        // For daily-ish data, show date only (avoid confusing anchor times like 04:00/05:00).
        timeVisible: !inferredDailySeries,
        tickMarkFormatter: (time: any) => fmtAxis(time, timeZone, inferredDailySeries),
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

    // Volume histogram on overlay price scale (bottom of chart)
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });

    // Reserve bottom space for volume (applies to the shared price scale of the candles)
    try {
      candlesSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.08, bottom: 0.28 },
      });
      volumeSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.72, bottom: 0.02 },
      });
    } catch {
      // ignore
    }

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
    candleSeriesRef.current = candlesSeries;
    volumeSeriesRef.current = volumeSeries;
    priceInSeriesRef.current = priceInSeries;
    sma50SeriesRef.current = sma50Series;
    sma200SeriesRef.current = sma200Series;

    // Back-compat: callers expect an IChartApi. Attach series handles for consumers that need them.
    (chart as any).candleSeries = candlesSeries;
    (chart as any).volumeSeries = volumeSeries;

    onChartReady?.({
      chart,
      candleSeries: candlesSeries,
      volumeSeries,
    });

    if (candleData.length > 0) {
      candlesSeries.setData(candleData);
      volumeSeries.setData(volumeData as any);
      applyVisibleWindow(chart, candleData.length, variant, visibleCount);
    } else {
      volumeSeries.setData([]);
    }

    roRef.current = new ResizeObserver(() => {
      applyVisibleWindow(chart, candleData.length, variant, visibleCount);
    });
    roRef.current.observe(el);

    return () => {
      roRef.current?.disconnect();
      roRef.current = null;
      try {
        if (chartRef.current) {
          delete (chartRef.current as any).candleSeries;
          delete (chartRef.current as any).volumeSeries;
        }
      } catch {
        // ignore
      }
      onChartReady?.(null);
      try {
        if (lastPriceLineRef.current && candleSeriesRef.current) {
          candleSeriesRef.current.removePriceLine(lastPriceLineRef.current);
        }
      } catch {
        // ignore
      }
      lastPriceLineRef.current = null;
      lastBarStartRef.current = null;
      lastBarRef.current = null;
      chart.remove();
      chartRef.current = null;

      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      priceInSeriesRef.current = null;
      sma50SeriesRef.current = null;
      sma200SeriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, visibleCount, candleData.length, inferredDailySeries, timeZone]);

  // Candles
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!chart || !candleSeries || !volumeSeries) return;

    // Defensive: force a full refresh when the time axis is identical but prices change
    // (common when switching symbols on the same intraday range).
    try {
      candleSeries.setData([]);
    } catch {
      // ignore
    }

    candleSeries.setData(candleData);
    volumeSeries.setData(volumeData as any);
    applyVisibleWindow(chart, candleData.length, variant, visibleCount);

    if (candleData.length > 0) {
      const last = candleData[candleData.length - 1];
      lastBarStartRef.current = Number(last.time);
      lastBarRef.current = {
        time: last.time as UTCTimestamp,
        open: last.open,
        high: last.high,
        low: last.low,
        close: last.close,
      };

      // Rebuild a single last-price priceLine on the candlestick series (no time-series line).
      try {
        if (lastPriceLineRef.current) {
          candleSeries.removePriceLine(lastPriceLineRef.current);
        }
      } catch {
        // ignore
      }
      try {
        lastPriceLineRef.current = candleSeries.createPriceLine({
          price: last.close,
          color: "rgba(250,204,21,0.95)",
          lineWidth: 1,
          lineStyle: 0,
          axisLabelVisible: variant === "primary",
          title: "",
        });
      } catch {
        // ignore
      }
    }
  }, [candleData, volumeData, visibleCount, variant]);

  // Time axis formatting: hide time-of-day for daily-ish data.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    try {
      chart.timeScale().applyOptions({
        timeVisible: !inferredDailySeries,
        secondsVisible: !inferredDailySeries,
      });
    } catch {
      // ignore
    }
  }, [inferredDailySeries]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    try {
      chart.applyOptions({
        localization: {
          timeFormatter: (time: UTCTimestamp) =>
            fmtCrosshair(Number(time), timeZone, inferredDailySeries),
        },
        timeScale: {
          tickMarkFormatter: (time: any) => fmtAxis(time, timeZone, inferredDailySeries),
        },
      });
    } catch {
      // ignore
    }
  }, [timeZone, inferredDailySeries]);

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

  // Live tick -> update the forming candle (intraday only) and a single last-price priceLine (no line-series)
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    if (!candleSeries) return;

    const tick =
      liveTick &&
      typeof (liveTick as any).ts === "number" &&
      typeof (liveTick as any).price === "number"
        ? { ts: (liveTick as any).ts as number, price: (liveTick as any).price as number }
        : liveTick &&
            typeof (liveTick as any).t === "number" &&
            typeof (liveTick as any).p === "number"
          ? { ts: (liveTick as any).t as number, price: (liveTick as any).p as number }
          : null;

    if (!tick || !Number.isFinite(tick.ts) || !Number.isFinite(tick.price)) return;
    if (candleData.length === 0) return;

    // Do not mutate candle bars for daily-ish series.
    if (inferredDailySeries) {
      return;
    }

    const tickSec = Number(toUTCTimestamp(tick.ts));
    const barSec = barSecondsRef.current || 60;
    const bucketStart = Math.floor(tickSec / barSec) * barSec;

    // Ensure refs are initialized.
    if (lastBarStartRef.current == null || !lastBarRef.current) {
      const last = candleData[candleData.length - 1];
      lastBarStartRef.current = Number(last.time);
      lastBarRef.current = {
        time: last.time as UTCTimestamp,
        open: last.open,
        high: last.high,
        low: last.low,
        close: last.close,
      };
    }

    const lastBarStart = lastBarStartRef.current as number;
    const lastBar = lastBarRef.current as {
      time: UTCTimestamp;
      open: number;
      high: number;
      low: number;
      close: number;
    };

    // New bar window -> append a new candle.
    if (bucketStart > lastBarStart) {
      const next = {
        time: bucketStart as UTCTimestamp,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
      };

      try {
        candleSeries.update(next);
      } catch {
        // ignore
      }

      lastBarStartRef.current = bucketStart;
      lastBarRef.current = next;

      // Update the single last-price priceLine.
      try {
        if (lastPriceLineRef.current) {
          candleSeries.removePriceLine(lastPriceLineRef.current);
        }
      } catch {
        // ignore
      }
      try {
        lastPriceLineRef.current = candleSeries.createPriceLine({
          price: tick.price,
          color: "rgba(250,204,21,0.95)",
          lineWidth: 1,
          lineStyle: 0,
          axisLabelVisible: variant === "primary",
          title: "",
        });
      } catch {
        // ignore
      }

      return;
    }

    // Same bar window -> update OHLC for the forming candle.
    if (bucketStart === lastBarStart) {
      const next = {
        time: lastBar.time,
        open: lastBar.open,
        high: Math.max(lastBar.high, tick.price),
        low: Math.min(lastBar.low, tick.price),
        close: tick.price,
      };

      try {
        candleSeries.update(next);
      } catch {
        // ignore
      }

      lastBarRef.current = next;

      // Update the single last-price priceLine.
      try {
        if (lastPriceLineRef.current) {
          candleSeries.removePriceLine(lastPriceLineRef.current);
        }
      } catch {
        // ignore
      }
      try {
        lastPriceLineRef.current = candleSeries.createPriceLine({
          price: tick.price,
          color: "rgba(250,204,21,0.95)",
          lineWidth: 1,
          lineStyle: 0,
          axisLabelVisible: variant === "primary",
          title: "",
        });
      } catch {
        // ignore
      }
    }
  }, [liveTick, candleData, inferredDailySeries, variant]);

  return (
    <div className="h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}