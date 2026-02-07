"use client";

import { useChartInstance } from "@/components/state/ChartStateProvider";
import { CHART_KEYS } from "@/components/state/chart-keys";
import { useCandles } from "@/components/hooks/useCandles";
import CandlesChart from "@/components/charts/CandlesChart";
import RsiPane from "@/components/charts/RsiPane";
import MacdPane from "@/components/charts/MacdPane";
import { getLocalPriceIn } from "@/lib/price-in/price-in";
import ChartControls from "@/components/charts/ChartControls";
import IndicatorToggles from "@/components/charts/IndicatorToggles";
import { useEffect, useMemo, useRef, useState } from "react";
import { type IChartApi, type UTCTimestamp } from "lightweight-charts";
import SymbolFreshnessBadge from "@/components/realtime/SymbolFreshnessBadge";
import IntradayFreshnessOverlay from "@/components/realtime/IntradayFreshnessOverlay";
import { realtimeState } from "@/lib/realtime/realtimeState";
import { useRealtimeState } from "@/lib/realtime/useRealtimeState";

import {
  upsertHorizontalLevels,
  clearHorizontalLevels as clearHorizontalLevelsDraw,
  type HorizontalLevel,
} from "@/components/charts/draw/DrawTools";

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200">
      {children}
    </span>
  );
}

function targetLabel(t: any) {
  if (t.type === "IXIC") return "IXIC";
  if (t.type === "SYMBOL") return t.symbol;
  if (t.type === "WATCHLIST_COMPOSITE") return `WL:${t.watchlistKey}`;
  return "—";
}

function fmtPrice(n: number) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function timeKey(t: any): number | null {
  if (!t) return null;
  if (typeof t === "number" && Number.isFinite(t)) {
    // Match chart's time normalization: ms -> seconds if needed.
    return Math.floor(t > 20_000_000_000 ? t / 1000 : t);
  }
  if (
    typeof t === "object" &&
    typeof t.year === "number" &&
    typeof t.month === "number" &&
    typeof t.day === "number"
  ) {
    return Math.floor(Date.UTC(t.year, t.month - 1, t.day, 0, 0, 0, 0) / 1000);
  }
  return null;
}

export function ChartPanel({
  chartKey,
  title = "Chart",
  mode = "full",
  activeTime: activeTimeProp,
  onActiveTimeChange,
}: {
  chartKey: string;
  title?: string;
  mode?: "full" | "tile";
  activeTime?: UTCTimestamp | null;
  onActiveTimeChange?: (t: UTCTimestamp | null) => void;
}) {
  const {
    instance,
    setTarget,
    setRange,
    setResolution,
    setIndicators,
    setIndicator,
    horizontalLevels,
    addHorizontalLevel,
    removeHorizontalLevel,
    setHorizontalLevels,
  } = useChartInstance(chartKey as any) as any;

  const [chartCtx, setChartCtx] = useState<{
    chart: IChartApi;
    candleSeries: any;
    volumeSeries?: any;
  } | null>(null);

  const chartApi: IChartApi | null = chartCtx?.chart ?? null;
  const candleSeriesRef = useRef<any>(null);
  const levelHandlesRef = useRef<Record<string, any>>({});
  const [activeTimeLocal, setActiveTimeLocal] = useState<UTCTimestamp | null>(null);
  const activeTime = typeof activeTimeProp !== "undefined" ? activeTimeProp : activeTimeLocal;
  const { candles, visibleCount, meta, loading, error } = useCandles(instance as any) as any;
  const symbol = instance.target.type === "SYMBOL" ? instance.target.symbol : null;

  const live = useRealtimeState((s) => {
    if (!symbol) return { tick: null as any };
    const sym = String(symbol).trim().toUpperCase();
    return { tick: (s.lastTickBySymbol as any)?.[sym] ?? null };
  });

  const liveTickRaw = live.tick;

  const liveTick: { t: number; p: number } | null =
    liveTickRaw &&
    typeof liveTickRaw.ts === "number" &&
    typeof liveTickRaw.price === "number"
      ? { t: liveTickRaw.ts, p: liveTickRaw.price }
      : null;

  const liveTickTs = liveTick?.t ?? null;
  const liveTickPrice = liveTick?.p ?? null;

  useEffect(() => {
    const viewId = `chart-panel:${chartKey}`;

    if (symbol) {
      const sym = String(symbol).trim().toUpperCase();
      realtimeState.setViewSymbols(viewId, [sym]);
    } else {
      realtimeState.clearViewSymbols(viewId);
    }

    return () => {
      realtimeState.clearViewSymbols(viewId);
    };
  }, [chartKey, symbol]);

  const priceIn = symbol ? getLocalPriceIn(symbol) : null;
  const lastCandle = candles?.length ? candles[candles.length - 1] : null;
  const lastClose = typeof lastCandle?.close === "number" ? lastCandle.close : null;
  const levelSuggestedPrice =
    typeof liveTickPrice === "number"
      ? liveTickPrice
      : typeof lastClose === "number"
        ? lastClose
        : null;
  const CandlesChartAny = CandlesChart as any;
  const candleCloseByTime = useMemo(() => {
    const map = new Map<number, number>();
    for (const c of candles ?? []) {
      const t = timeKey(c?.time);
      if (typeof t === "number" && Number.isFinite(c?.close)) {
        map.set(t, c.close);
      }
    }
    return map;
  }, [candles]);

  useEffect(() => {
    candleSeriesRef.current =
      chartCtx?.candleSeries ?? (chartApi as any)?.candleSeries ?? null;
  }, [chartCtx, chartApi]);

  useEffect(() => {
    console.log("[ChartPanel]", {
      chartKey,
      target: instance.target,
      candlesLen: candles?.length ?? 0,
      firstTime: candles?.[0]?.time,
      lastTime: lastCandle?.time,
      lastClose,
      liveTickTs,
      liveTickPrice,
    });
  }, [chartKey, instance.target, candles, lastCandle, lastClose, liveTickTs, liveTickPrice]);

  useEffect(() => {
    if (!chartApi) return;

    const handler = (param: any) => {
      // param.time is undefined when cursor leaves the chart area
      const t = (param?.time as UTCTimestamp | undefined) ?? null;
      if (typeof onActiveTimeChange === "function") {
        onActiveTimeChange(t);
      } else {
        setActiveTimeLocal((prev) => (prev === t ? prev : t));
      }
    };

    chartApi.subscribeCrosshairMove(handler);
    return () => {
      chartApi.unsubscribeCrosshairMove(handler);
    };
  }, [chartApi, onActiveTimeChange]);

  useEffect(() => {
    const chart = chartApi;
    if (!chart) return;

    const handler = (param: any) => {

      // Need a Y coordinate to place a price level.
      const y = param?.point?.y;
      if (typeof y !== "number" || !Number.isFinite(y)) return;

      const liveCandleSeries: any = candleSeriesRef.current ?? (chart as any).candleSeries ?? null;

      // 0) Preferred path: use the live candle series scale to convert Y -> price.
      if (liveCandleSeries) {
        try {
          const p = liveCandleSeries.coordinateToPrice?.(y);
          const pn = typeof p === "number" ? p : Number(p);
          if (Number.isFinite(pn)) {
            addHorizontalLevel(pn);
            return;
          }
        } catch {
          // ignore
        }
      }

      // 1) Next: use the series instance from the event (survives chart rebuilds).
      try {
        let eventSeries: any = null;
        let eventData: any = null;
        const seriesData = param?.seriesData;
        if (seriesData && typeof seriesData.forEach === "function") {
          seriesData.forEach((value: any, key: any) => {
            if (!value || typeof value !== "object") return;
            if (
              typeof value.open === "number" &&
              typeof value.high === "number" &&
              typeof value.low === "number" &&
              typeof value.close === "number"
            ) {
              eventSeries = key;
              eventData = value;
            }
          });
        }

        const close = eventData && typeof eventData.close === "number" ? eventData.close : null;
        if (typeof close === "number" && Number.isFinite(close)) {
          addHorizontalLevel(close);
          return;
        }

        // If we found the event series, use its coordinate conversion.
        if (eventSeries?.coordinateToPrice) {
          const p = eventSeries.coordinateToPrice(y);
          const pn = typeof p === "number" ? p : Number(p);
          if (Number.isFinite(pn)) {
            addHorizontalLevel(pn);
            return;
          }
        }
      } catch {
        // ignore
      }

      // 2) Next: if time is known, use the candle close at that time.
      const t = timeKey(param?.time);
      if (typeof t === "number") {
        const close = candleCloseByTime.get(t);
        if (typeof close === "number" && Number.isFinite(close)) {
          addHorizontalLevel(close);
          return;
        }
      }

      // 3) Final fallback: use the chart's right price scale conversion (works even without candleSeries).
      try {
        const ps: any = (chart as any).priceScale?.("right");
        const p = ps?.coordinateToPrice?.(y);
        const pn = typeof p === "number" ? p : Number(p);
        if (Number.isFinite(pn)) {
          addHorizontalLevel(pn);
        }
      } catch {
        // ignore
      }
    };

    chart.subscribeClick(handler);
    return () => {
      chart.unsubscribeClick(handler);
    };
  }, [chartApi, chartCtx, addHorizontalLevel]);

  useEffect(() => {
    const candleSeries =
      candleSeriesRef.current ?? chartCtx?.candleSeries ?? (chartApi as any)?.candleSeries;
    if (!candleSeries) return;

    upsertHorizontalLevels(candleSeries, horizontalLevels ?? [], levelHandlesRef.current);

    return () => {
      clearHorizontalLevelsDraw(candleSeries, levelHandlesRef.current);
    };
  }, [chartCtx, chartApi, horizontalLevels]);

  function toggle(key: "rsi" | "macd" | "sma50" | "sma200") {
    const next = { ...instance.indicators, [key]: !instance.indicators[key] };

    // Prefer bulk setter if available, fallback to single-key setter
    if (typeof setIndicators === "function") {
      setIndicators(next);
      return;
    }
    if (typeof setIndicator === "function") {
      setIndicator(key, next[key]);
      return;
    }

    // If neither exists, we add it in ChartStateProvider (next step)
    throw new Error("Chart state setter for indicators is missing.");
  }

  const indicatorCount =
    (instance.indicators.rsi ? 1 : 0) + (instance.indicators.macd ? 1 : 0);

  // Main chart gets a fixed share; enabled indicators evenly split the remainder.
  const MAIN_CHART_PCT = 0.62;
  const INDICATORS_PCT = 1 - MAIN_CHART_PCT;

  return (
    <section className="flex h-full min-h-0 flex-col rounded-lg border border-neutral-800 bg-neutral-950">
      <div className={
        mode === "tile"
          ? "flex items-center justify-between border-b border-neutral-800 px-2 py-1.5"
          : "flex items-center justify-between border-b border-neutral-800 px-3 py-2"
      }>
        <div className="flex items-center gap-2">
          <div className="text-sm font-medium">{title}</div>
          <Pill>{targetLabel(instance.target)}</Pill>

          {symbol ? <SymbolFreshnessBadge symbol={symbol} /> : null}
        </div>

        {mode === "full" && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setTarget({ type: "IXIC" })}
              className="rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-200 hover:bg-neutral-800"
              title="Return to IXIC"
            >
              IXIC
            </button>
            <ChartControls
              range={instance.range}
              resolution={instance.resolution}
              onRange={setRange}
              onResolution={setResolution}
            />
            <IndicatorToggles
              indicators={instance.indicators as any}
              onToggle={toggle}
            />
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  if (typeof levelSuggestedPrice === "number") addHorizontalLevel(levelSuggestedPrice);
                }}
                className="rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-200 hover:bg-neutral-800"
                title="Add horizontal price level"
              >
                + Level
              </button>
              {(horizontalLevels?.length ?? 0) > 0 ? (
                <span className="text-[11px] text-neutral-400">{horizontalLevels?.length ?? 0}</span>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-xs text-neutral-400 pointer-events-none">
            Loading candles…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-xs text-red-400 pointer-events-none">
            Error: {error}
          </div>
        )}

        {!error && candles.length > 0 && (
          <div className="absolute left-3 top-3 z-10 rounded border border-neutral-800 bg-neutral-950/70 px-2 py-1 text-[11px] text-neutral-200 pointer-events-none">
            <div>
              {candles.length} bars • last close {lastClose !== null ? lastClose.toFixed(2) : "—"}
            </div>
            {symbol ? (
              <div className="mt-0.5 text-neutral-300">
                tick:{" "}
                {liveTickTs != null ? new Date(liveTickTs).toLocaleTimeString() : "—"}
                {liveTickPrice != null ? ` • ${liveTickPrice.toFixed(2)}` : ""}
              </div>
            ) : null}
          </div>
        )}

        {(horizontalLevels?.length ?? 0) > 0 && (
          <div className="absolute right-3 top-3 z-10 flex flex-col gap-1 rounded border border-neutral-800 bg-neutral-950/70 px-2 py-1 text-[11px] text-neutral-200 pointer-events-none">
            <div className="text-neutral-300">Levels</div>
            {(horizontalLevels ?? []).slice(0, 8).map((lvl: any) => (
              <div key={lvl.id} className="flex items-center justify-between gap-2">
                <span className="tabular-nums">{fmtPrice(lvl.price)}</span>
                <button
                  type="button"
                  onClick={() => removeHorizontalLevel(lvl.id)}
                  className="pointer-events-auto text-neutral-400 hover:text-neutral-200"
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            ))}
            {(horizontalLevels?.length ?? 0) > 8 ? (
              <div className="text-neutral-400">+{(horizontalLevels?.length ?? 0) - 8} more</div>
            ) : null}
          </div>
        )}

        <div className="pointer-events-none">
          <IntradayFreshnessOverlay meta={meta} candlesCount={candles.length} />
        </div>

        <div className="flex h-full w-full min-h-0 flex-col gap-2">
          <div
            className={indicatorCount > 0 ? "min-h-0" : "min-h-0 flex-1"}
            style={
              indicatorCount > 0
                ? { flexBasis: `${Math.round(MAIN_CHART_PCT * 100)}%`, flexShrink: 0 }
                : undefined
            }
          >
            <CandlesChartAny
              key={targetLabel(instance.target)}
              candles={candles}
              visibleCount={visibleCount}
              variant="primary"
              priceIn={priceIn}
              showSma50={instance.indicators.sma50}
              showSma200={instance.indicators.sma200}
              onChartReady={setChartCtx}
              liveTick={liveTick}
            />
          </div>

          {indicatorCount > 0 && (
            <div
              className="min-h-0 flex-1"
              style={{ flexBasis: `${Math.round(INDICATORS_PCT * 100)}%` }}
            >
              <div
                className="grid h-full min-h-0 gap-2"
                style={{
                  gridTemplateRows: `repeat(${indicatorCount}, minmax(0, 1fr))`,
                }}
              >
                {instance.indicators.rsi && (
                  <div className="relative min-h-0 h-full overflow-hidden">
                    <RsiPane
                      candles={candles}
                      activeTime={activeTime}
                      visibleCount={visibleCount}
                      syncChart={chartApi}
                      timeScaleVisible={false}
                    />
                  </div>
                )}
                {instance.indicators.macd && (
                  <div className="relative min-h-0 h-full overflow-hidden">
                    <MacdPane
                      candles={candles}
                      activeTime={activeTime}
                      visibleCount={visibleCount}
                      syncChart={chartApi}
                      timeScaleVisible={false}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default function PrimaryChartPanel() {
  return <ChartPanel chartKey={CHART_KEYS.PRIMARY} title="Primary Chart" />;
}
