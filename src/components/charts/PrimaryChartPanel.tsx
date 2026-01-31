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
import { useEffect, useState } from "react";
import type { IChartApi, UTCTimestamp } from "lightweight-charts";
import SymbolFreshnessBadge from "@/components/realtime/SymbolFreshnessBadge";
import IntradayFreshnessOverlay from "@/components/realtime/IntradayFreshnessOverlay";
import { realtimeState } from "@/lib/realtime/realtimeState";

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
  } = useChartInstance(chartKey as any) as any;

  const [chartApi, setChartApi] = useState<IChartApi | null>(null);
  const [activeTimeLocal, setActiveTimeLocal] = useState<UTCTimestamp | null>(null);
  const activeTime = typeof activeTimeProp !== "undefined" ? activeTimeProp : activeTimeLocal;
  const { candles, visibleCount, meta, loading, error } = useCandles(instance as any) as any;
  const symbol = instance.target.type === "SYMBOL" ? instance.target.symbol : null;

  useEffect(() => {
    const viewId = `chart-panel:${chartKey}`;

    if (symbol) {
      realtimeState.setViewSymbols(viewId, [symbol]);
    } else {
      realtimeState.clearViewSymbols(viewId);
    }

    return () => {
      realtimeState.clearViewSymbols(viewId);
    };
  }, [chartKey, symbol]);

  const priceIn = symbol ? getLocalPriceIn(symbol) : null;

  useEffect(() => {
    console.log("[ChartPanel]", {
      chartKey,
      target: instance.target,
      candlesLen: candles?.length ?? 0,
      firstTime: candles?.[0]?.time,
      lastTime: candles?.[candles.length - 1]?.time,
      lastClose: candles?.[candles.length - 1]?.close,
    });
  }, [chartKey, instance.target, candles]);

  useEffect(() => {
    if (!chartApi) return;

    const handler = (param: any) => {
      // param.time is undefined when cursor leaves the chart area
      const t = (param?.time as UTCTimestamp | undefined) ?? null;
      if (typeof onActiveTimeChange === "function") {
        onActiveTimeChange(t);
      } else {
        setActiveTimeLocal(t);
      }
    };

    chartApi.subscribeCrosshairMove(handler);
    return () => {
      chartApi.unsubscribeCrosshairMove(handler);
    };
  }, [chartApi, onActiveTimeChange]);

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
          </div>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-xs text-neutral-400">
            Loading candles…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-xs text-red-400">
            Error: {error}
          </div>
        )}

        {!error && candles.length > 0 && (
          <div className="absolute left-3 top-3 z-10 rounded border border-neutral-800 bg-neutral-950/70 px-2 py-1 text-[11px] text-neutral-200">
            {candles.length} bars • last close {candles[candles.length - 1].close.toFixed(2)}
          </div>
        )}

        <IntradayFreshnessOverlay meta={meta} candlesCount={candles.length} />

        <div className="flex h-full w-full min-h-0 flex-col gap-2">
          <div
            className={indicatorCount > 0 ? "min-h-0" : "min-h-0 flex-1"}
            style={
              indicatorCount > 0
                ? { flexBasis: `${Math.round(MAIN_CHART_PCT * 100)}%`, flexShrink: 0 }
                : undefined
            }
          >
            <CandlesChart
              key={targetLabel(instance.target)}
              candles={candles}
              visibleCount={visibleCount}
              variant="primary"
              priceIn={priceIn}
              showSma50={instance.indicators.sma50}
              showSma200={instance.indicators.sma200}
              onChartReady={setChartApi}
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