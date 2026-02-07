"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
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

function toUTCTimestamp(t: number): UTCTimestamp {
  // If t looks like milliseconds since epoch, convert to seconds.
  // Otherwise assume it's already seconds.
  const seconds = t > 20_000_000_000 ? Math.floor(t / 1000) : Math.floor(t);
  return seconds as UTCTimestamp;
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
  const anchorSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const rsiLabelRef = useRef<any>(null);

  const isHoveringRef = useRef(false);

  const [rsiOverlay, setRsiOverlay] = useState<{ y: number; text: string } | null>(null);

  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const normalizedCandles = useMemo(() => normalizeCandles(candles), [candles]);

  const anchorLine = useMemo(
    () =>
      normalizedCandles.map((c) => ({
        time: toUTCTimestamp(Number(c.time)),
        value: 50,
      })) as LineData<UTCTimestamp>[],
    [normalizedCandles]
  );

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
        attributionLogo: false,
        },
        rightPriceScale: {
        borderVisible: false,
        autoScale: true, // we’ll force RSI range via autoscaleInfoProvider
        scaleMargins: { top: 0.1, bottom: 0.1 },
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
        horzLines: { visible: false },
      },
      crosshair: {
        vertLine: { visible: true },
        horzLine: { visible: false },
      },
    });

    chartRef.current = chart;
    onChartReady?.(chart);

    const anchor = chart.addSeries(LineSeries, {
      lineWidth: 1,
      priceScaleId: "right",
      color: "rgba(0,0,0,0)",
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const rsi = chart.addSeries(LineSeries, {
        lineWidth: 2,
        priceScaleId: "right",
        priceLineVisible: false,
        lastValueVisible: false,
        autoscaleInfoProvider: () => ({
            priceRange: { minValue: 0, maxValue: 100 },
        }),
    });

    // Label-only right-scale RSI value (no horizontal line). Updated on crosshair move.
    rsiLabelRef.current = (rsi as any).createPriceLine?.({
      price: 50,
      color: "rgba(229,229,229,0.85)",
      lineWidth: 1,
      axisLabelVisible: false,
      lineVisible: false,
      title: "RSI",
    });

    const l30 = chart.addSeries(LineSeries, {
      lineWidth: 1,
      priceScaleId: "right",
      lineStyle: 2,
      color: "rgba(255,255,255,0.25)",
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const l70 = chart.addSeries(LineSeries, {
      lineWidth: 1,
      priceScaleId: "right",
      lineStyle: 2,
      color: "rgba(255,255,255,0.25)",
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    anchorSeriesRef.current = anchor;
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
      rsiLabelRef.current = null;
      anchorSeriesRef.current = null;
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

  // Crosshair sync (mirror primary chart hover) + right-scale value label
  useEffect(() => {
    const destChart = chartRef.current;
    const anchor = anchorSeriesRef.current;
    if (!destChart || !syncChart || !anchor) return;

    const handler = (param: any) => {
      try {
        const t = param?.time;
        if (t != null) {
          isHoveringRef.current = true;
          (destChart as any).setCrosshairPosition?.(50, t, anchor as any);

          const rv = rsiByTime.get(t as any);
          if (typeof rv === "number") {
            try {
              const y = (rsiSeriesRef.current as any)?.priceToCoordinate?.(rv);
              if (typeof y === "number" && Number.isFinite(y)) {
                setRsiOverlay({ y, text: rv.toFixed(2) });
              }
            } catch {
              // ignore
            }
          }
        } else {
          isHoveringRef.current = false;
          (destChart as any).clearCrosshairPosition?.();

          if (typeof lastRsi === "number") {
            try {
              const y = (rsiSeriesRef.current as any)?.priceToCoordinate?.(lastRsi);
              if (typeof y === "number" && Number.isFinite(y)) {
                setRsiOverlay({ y, text: lastRsi.toFixed(2) });
              } else {
                setRsiOverlay(null);
              }
            } catch {
              setRsiOverlay(null);
            }
          } else {
            setRsiOverlay(null);
          }
        }
      } catch {
        // ignore
      }
    };

    (syncChart as any).subscribeCrosshairMove?.(handler);

    return () => {
      try {
        (syncChart as any).unsubscribeCrosshairMove?.(handler);
      } catch {
        // ignore
      }
      try {
        (destChart as any).clearCrosshairPosition?.();
      } catch {
        // ignore
      }
      try {
        isHoveringRef.current = false;
        setRsiOverlay(null);
      } catch {
        // ignore
      }
    };
  }, [syncChart, rsiByTime, lastRsi]);

  // Update data when candles change
  useEffect(() => {
    const chart = chartRef.current;
    const anchor = anchorSeriesRef.current;
    const rsi = rsiSeriesRef.current;
    const l30 = line30Ref.current;
    const l70 = line70Ref.current;
    if (!chart || !anchor || !rsi || !l30 || !l70) return;

    anchor.setData(anchorLine);

    rsi.setData(rsiData);
    l30.setData(guide30);
    l70.setData(guide70);

    // Default the right-scale RSI label to the last value when not hovering.
    if (typeof lastRsi === "number") {
      try {
        rsiLabelRef.current?.applyOptions?.({ price: lastRsi });
      } catch {
        // ignore
      }
    }
    // Keep the overlay showing the current RSI when not hovering (and re-compute Y after rescale).
    if (!isHoveringRef.current && typeof lastRsi === "number") {
      try {
        const y = (rsiSeriesRef.current as any)?.priceToCoordinate?.(lastRsi);
        if (typeof y === "number" && Number.isFinite(y)) {
          setRsiOverlay({ y, text: lastRsi.toFixed(2) });
        }
      } catch {
        // ignore
      }
    }

    // Enforce Model 1 window pinning
    if (!syncChart) {
        applyVisibleWindow(chart, rsiData.length, visibleCount ?? null);
    }
  }, [anchorLine, rsiData, guide30, guide70, visibleCount, lastRsi]);

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
        className={
          height
            ? "relative w-full rounded-md border border-neutral-900 bg-neutral-950"
            : "relative min-h-0 flex-1 w-full rounded-md border border-neutral-900 bg-neutral-950"
        }
        style={height ? { height } : undefined}
      >
        <div ref={containerRef} className="absolute inset-0" />

        {rsiOverlay ? (
          <div
            className="pointer-events-none absolute right-1 z-50 rounded bg-neutral-900/90 px-1.5 py-0.5 text-[11px] tabular-nums text-neutral-100"
            style={{ top: rsiOverlay.y, transform: "translateY(-50%)" }}
          >
            RSI {rsiOverlay.text}
          </div>
        ) : null}
      </div>
    </div>
  );
}