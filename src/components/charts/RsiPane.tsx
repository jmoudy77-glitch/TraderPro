"use client";

import React, { useEffect, useMemo, useRef } from "react";
import {
  createChart,
  LineSeries,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "@/lib/market-data/types";
import {
  computeRsi,
  constantLineFromCandles,
  normalizeCandles,
} from "@/lib/market-data/indicators";

type Props = {
  candles: Candle[];
  activeTime?: UTCTimestamp | null;
  visibleCount?: number | null;
  onChartReady?: (chart: IChartApi | null) => void;
  syncChart?: IChartApi | null;
  height?: number;
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

export default function RsiPane({
  candles,
  activeTime,
  visibleCount,
  onChartReady,
  syncChart,
  height,
  timeScaleVisible = true,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const rsiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const line30Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const line70Ref = useRef<ISeriesApi<"Line"> | null>(null);

  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const normalizedCandles = useMemo(() => normalizeCandles(candles), [candles]);

  const rsiData = useMemo(() => {
    const points = computeRsi(normalizedCandles, 14);
    // Clamp to [0,100] just to be safe with any weird stub values
    return points.map((p) => ({
      time: p.time,
      value: Math.max(0, Math.min(100, p.value)),
    })) as LineData<UTCTimestamp>[];
  }, [normalizedCandles]);

  const guide30 = useMemo(() => {
    return constantLineFromCandles(normalizedCandles, 30).map((p) => ({
      time: p.time,
      value: p.value,
    })) as LineData<UTCTimestamp>[];
  }, [normalizedCandles]);

  const guide70 = useMemo(() => {
    return constantLineFromCandles(normalizedCandles, 70).map((p) => ({
      time: p.time,
      value: p.value,
    })) as LineData<UTCTimestamp>[];
  }, [normalizedCandles]);

  const rsiByTime = useMemo(() => {
    const m = new Map<UTCTimestamp, number>();
    for (const p of rsiData) m.set(p.time, p.value);
    return m;
  }, [rsiData]);

  const lastRsi = useMemo(() => {
    const last = rsiData[rsiData.length - 1];
    return last ? last.value : null;
  }, [rsiData]);

  const displayedRsi = useMemo(() => {
    if (activeTime != null) {
      const v = rsiByTime.get(activeTime);
      if (typeof v === "number") return v;
    }
    return lastRsi;
  }, [activeTime, rsiByTime, lastRsi]);

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
        autoScale: true, // we’ll force RSI range via autoscaleInfoProvider
        scaleMargins: { top: 0.15, bottom: 0.15 },
        },

        // 🔒 Disable independent interaction
        handleScroll: false,
        handleScale: false,
        
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
    });

    chartRef.current = chart;
    onChartReady?.(chart);

    const rsi = chart.addSeries(LineSeries, {
        lineWidth: 2,
        priceScaleId: "right",
        autoscaleInfoProvider: () => ({
            priceRange: { minValue: 0, maxValue: 100 },
        }),
    });

    const l30 = chart.addSeries(LineSeries, {
        lineWidth: 1,
        priceScaleId: "right",
        lineStyle: 2,
        color: "rgba(255,255,255,0.25)",
        });

        const l70 = chart.addSeries(LineSeries, {
        lineWidth: 1,
        priceScaleId: "right",
        lineStyle: 2,
        color: "rgba(255,255,255,0.25)",
    });

    rsiSeriesRef.current = rsi;
    line30Ref.current = l30;
    line70Ref.current = l70;

    // Resize behavior: keep pinned window (Model 1)
    const ro = new ResizeObserver(() => {
      const ch = chartRef.current;
      const container = containerRef.current;
      if (!ch || !container) return;

      ch.applyOptions({
        width: container.clientWidth,
        height: Math.max(1, height ?? container.clientHeight),
      });
      // Use RSI length as dataLength reference (it’s the smallest series)
      if (syncChart) {
        const range = syncChart.timeScale().getVisibleLogicalRange();
        if (range) ch.timeScale().setVisibleLogicalRange(range as any);
      } else {
        applyVisibleWindow(ch, rsiData.length, visibleCount ?? null);
      }
    });

    resizeObserverRef.current = ro;
    ro.observe(el);

    return () => {
      ro.disconnect();
      resizeObserverRef.current = null;

      chart.remove();
      chartRef.current = null;
      rsiSeriesRef.current = null;
      line30Ref.current = null;
      line70Ref.current = null;
      onChartReady?.(null);
    };
    // createChart must only depend on mount-level concerns
    // height is safe to include; if you change height, chart re-creates
  }, [height, timeScaleVisible]);

  // Sync this pane's visible time window to the main chart (one-way) so zoom/pan aligns.
  useEffect(() => {
    const destChart = chartRef.current;
    if (!destChart || !syncChart) return;

    const src = syncChart.timeScale();
    const dst = destChart.timeScale();

    const handler = (range: any) => {
        if (!range) return;
        dst.setVisibleLogicalRange(range);
    };

    // Apply once immediately
    handler(src.getVisibleLogicalRange());

    // Subscribe
    src.subscribeVisibleLogicalRangeChange(handler);

    return () => {
        src.unsubscribeVisibleLogicalRangeChange(handler);
    };
    }, [syncChart]);

  // Update data when candles change
  useEffect(() => {
    const chart = chartRef.current;
    const rsi = rsiSeriesRef.current;
    const l30 = line30Ref.current;
    const l70 = line70Ref.current;
    if (!chart || !rsi || !l30 || !l70) return;

    rsi.setData(rsiData);
    l30.setData(guide30);
    l70.setData(guide70);

    // Enforce Model 1 window pinning
    if (!syncChart) {
        applyVisibleWindow(chart, rsiData.length, visibleCount ?? null);
    }
  }, [rsiData, guide30, guide70, visibleCount]);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="mb-1 flex items-center justify-between text-[11px] text-neutral-400">
        <div>RSI (14)</div>
        <div className="tabular-nums">
          {typeof displayedRsi === "number"
            ? `RSI: ${displayedRsi.toFixed(1)} • 30/70`
            : "30/70"}
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