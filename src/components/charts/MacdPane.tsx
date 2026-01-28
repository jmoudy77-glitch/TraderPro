"use client";

import React, { useEffect, useMemo, useRef } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type HistogramData,
  type UTCTimestamp,
} from "lightweight-charts";

import type { Candle } from "@/lib/market-data/types";
import { computeMacd, normalizeCandles } from "@/lib/market-data/indicators";

type Props = {
  candles: Candle[];
  activeTime?: UTCTimestamp | null;
  visibleCount?: number | null;
  onChartReady?: (chart: IChartApi | null) => void;
  syncChart?: IChartApi | null;
  height?: number;
  rightPriceScaleVisible?: boolean;
  timeScaleVisible?: boolean;
};

function applyVisibleWindow(
  chart: IChartApi,
  dataLength: number,
  visibleCount?: number | null
) {
  if (!visibleCount || visibleCount <= 0) {
    chart.timeScale().fitContent();
    return;
  }

  const to = Math.max(0, dataLength - 1);
  const from = Math.max(0, to - (visibleCount - 1));
  chart.timeScale().setVisibleLogicalRange({ from, to });
}

export default function MacdPane({
  candles,
  activeTime,
  visibleCount,
  onChartReady,
  syncChart,
  height,
  rightPriceScaleVisible = true,
  timeScaleVisible = true,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const macdSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const signalSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const histSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const syncChartRef = useRef<IChartApi | null>(null);
  const visibleCountRef = useRef<number | null>(null);
  const dataLenRef = useRef<number>(0);

  useEffect(() => {
    syncChartRef.current = syncChart ?? null;
  }, [syncChart]);

  useEffect(() => {
    visibleCountRef.current = visibleCount ?? null;
  }, [visibleCount]);

  const normalizedCandles = useMemo(() => normalizeCandles(candles), [candles]);
  const macdPack = useMemo(
    () => computeMacd(normalizedCandles, 12, 26, 9),
    [normalizedCandles]
  );

  const macdLine = useMemo(
    () =>
      macdPack.macd.map((p) => ({
        time: p.time,
        value: p.value,
      })) as LineData<UTCTimestamp>[],
    [macdPack.macd]
  );

  const signalLine = useMemo(
    () =>
      macdPack.signal.map((p) => ({
        time: p.time,
        value: p.value,
      })) as LineData<UTCTimestamp>[],
    [macdPack.signal]
  );

  const histogram = useMemo(
    () =>
      macdPack.histogram.map((p) => ({
        time: p.time,
        value: p.value,
        color: p.value >= 0 ? "rgba(34,197,94,0.55)" : "rgba(239,68,68,0.55)",
      })) as HistogramData<UTCTimestamp>[],
    [macdPack.histogram]
  );

  const macdByTime = useMemo(() => {
    const m = new Map<UTCTimestamp, number>();
    for (const p of macdPack.macd) m.set(p.time, p.value);
    return m;
  }, [macdPack.macd]);

  const signalByTime = useMemo(() => {
    const m = new Map<UTCTimestamp, number>();
    for (const p of macdPack.signal) m.set(p.time, p.value);
    return m;
  }, [macdPack.signal]);

  const histByTime = useMemo(() => {
    const m = new Map<UTCTimestamp, number>();
    for (const p of macdPack.histogram) m.set(p.time, p.value);
    return m;
  }, [macdPack.histogram]);

  const lastMacd = useMemo(() => {
    const last = macdPack.macd[macdPack.macd.length - 1];
    return last ? last.value : null;
  }, [macdPack.macd]);

  const lastSignal = useMemo(() => {
    const last = macdPack.signal[macdPack.signal.length - 1];
    return last ? last.value : null;
  }, [macdPack.signal]);

  const lastHist = useMemo(() => {
    const last = macdPack.histogram[macdPack.histogram.length - 1];
    return last ? last.value : null;
  }, [macdPack.histogram]);

  const displayedMacd = useMemo(() => {
    if (activeTime != null) {
      const v = macdByTime.get(activeTime);
      if (typeof v === "number") return v;
    }
    return lastMacd;
  }, [activeTime, macdByTime, lastMacd]);

  const displayedSignal = useMemo(() => {
    if (activeTime != null) {
      const v = signalByTime.get(activeTime);
      if (typeof v === "number") return v;
    }
    return lastSignal;
  }, [activeTime, signalByTime, lastSignal]);

  const displayedHist = useMemo(() => {
    if (activeTime != null) {
      const v = histByTime.get(activeTime);
      if (typeof v === "number") return v;
    }
    return lastHist;
  }, [activeTime, histByTime, lastHist]);

  useEffect(() => {
    dataLenRef.current = histogram.length;
  }, [histogram.length]);

  // Create chart once on mount
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      height: Math.max(1, height ?? el.clientHeight),
      width: el.clientWidth,
      layout: {
        background: { type: ColorType.Solid, color: "#0a0a0a" },
        textColor: "#a3a3a3",
      },
      rightPriceScale: {
        borderVisible: false,
        visible: rightPriceScaleVisible,
        autoScale: true,
        scaleMargins: { top: 0.15, bottom: 0.15 },
      },
      timeScale: {
        visible: timeScaleVisible,
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: true },
      },
      crosshair: {
        vertLine: { visible: true },
        horzLine: { visible: true },
      },

      // Disable independent interaction; this pane is slaved to the primary.
      handleScroll: false,
      handleScale: false,
    });

    chartRef.current = chart;
    onChartReady?.(chart);

    const hist = chart.addSeries(HistogramSeries, { priceScaleId: "right", base: 0 });
    const macd = chart.addSeries(LineSeries, {
      lineWidth: 2,
      priceScaleId: "right",
      color: "rgba(147,197,253,0.95)",
    });
    const signal = chart.addSeries(LineSeries, {
      lineWidth: 2,
      priceScaleId: "right",
      color: "rgba(196,181,253,0.95)",
    });

    histSeriesRef.current = hist;
    macdSeriesRef.current = macd;
    signalSeriesRef.current = signal;

    const ro = new ResizeObserver(() => {
      const ch = chartRef.current;
      const container = containerRef.current;
      if (!ch || !container) return;

      ch.applyOptions({
        width: container.clientWidth,
        height: Math.max(1, height ?? container.clientHeight),
      });

      const srcChart = syncChartRef.current;
      if (srcChart) {
        const range = srcChart.timeScale().getVisibleLogicalRange();
        if (range) ch.timeScale().setVisibleLogicalRange(range as any);
      } else {
        applyVisibleWindow(ch, dataLenRef.current, visibleCountRef.current);
      }
    });

    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      macdSeriesRef.current = null;
      signalSeriesRef.current = null;
      histSeriesRef.current = null;
      onChartReady?.(null);
    };
  }, [height, onChartReady, rightPriceScaleVisible, timeScaleVisible]);

  // Timeline sync
  useEffect(() => {
    const destChart = chartRef.current;
    if (!destChart || !syncChart) return;

    const src = syncChart.timeScale();
    const dst = destChart.timeScale();

    const handler = (range: any) => {
      if (!range) return;
      dst.setVisibleLogicalRange(range);
    };

    handler(src.getVisibleLogicalRange());
    src.subscribeVisibleLogicalRangeChange(handler);

    return () => {
      src.unsubscribeVisibleLogicalRangeChange(handler);
    };
  }, [syncChart]);

  // Update data
  useEffect(() => {
    const chart = chartRef.current;
    const macd = macdSeriesRef.current;
    const signal = signalSeriesRef.current;
    const hist = histSeriesRef.current;
    if (!chart || !macd || !signal || !hist) return;

    hist.setData(histogram);
    macd.setData(macdLine);
    signal.setData(signalLine);

    if (!syncChart) {
      applyVisibleWindow(chart, histogram.length, visibleCount ?? null);
    }
  }, [histogram, macdLine, signalLine, visibleCount, syncChart]);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="mb-1 flex items-center justify-between text-[11px] text-neutral-400">
        <div>MACD (12, 26, 9)</div>
        <div className="tabular-nums">
          {typeof displayedMacd === "number" &&
          typeof displayedSignal === "number" &&
          typeof displayedHist === "number"
            ? `MACD: ${displayedMacd.toFixed(2)}  SIG: ${displayedSignal.toFixed(2)}  HIST: ${displayedHist.toFixed(2)}`
            : "MACD / Signal / Hist"}
        </div>
      </div>
      <div
        ref={containerRef}
        className={
          height
            ? "w-full rounded-md border border-neutral-900 bg-neutral-950"
            : "min-h-0 flex-1 w-full rounded-md border border-neutral-900 bg-neutral-950"
        }
        style={height ? { height } : undefined}
      />
    </div>
  );
}