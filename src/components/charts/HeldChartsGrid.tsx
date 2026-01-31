"use client";

import { useChartInstance } from "@/components/state/ChartStateProvider";
import { CHART_KEYS } from "@/components/state/chart-keys";
import { useCandles } from "@/components/hooks/useCandles";
import CandlesChart from "@/components/charts/CandlesChart";
import { getLocalPriceIn } from "@/lib/price-in/price-in";
import { computeRsi, normalizeCandles } from "@/lib/market-data/indicators";
import MacdPane from "@/components/charts/MacdPane";
import type { IChartApi } from "lightweight-charts";
import { useEffect, useMemo, useState } from "react";
import SymbolFreshnessBadge from "@/components/realtime/SymbolFreshnessBadge";
import IntradayFreshnessOverlay from "@/components/realtime/IntradayFreshnessOverlay";
import { realtimeState } from "@/lib/realtime/realtimeState";

function labelForTarget(t: any) {
  if (t.type === "SYMBOL") return t.symbol;
  if (t.type === "IXIC") return "IXIC";
  if (t.type === "WATCHLIST_COMPOSITE") return `WL:${t.watchlistKey}`;
  return "(empty)";
}

function MiniChartCard({ chartKey }: { chartKey: string }) {
  const [miniChart, setMiniChart] = useState<IChartApi | null>(null);
  const [activeTime, setActiveTime] = useState<number | null>(null);

  useEffect(() => {
    if (!miniChart) return;

    const handler = (param: any) => {
      setActiveTime((param?.time as number | undefined) ?? null);
    };

    miniChart.subscribeCrosshairMove(handler);
    return () => {
      miniChart.unsubscribeCrosshairMove(handler);
    };
  }, [miniChart]);

  const { instance, setTarget } = useChartInstance(chartKey as any);

  const { candles, loading, error, meta } = useCandles(instance);

  const rsiSeries = useMemo(() => {
    if (!candles || candles.length < 20) return [];
    const norm = normalizeCandles(candles);
    return computeRsi(norm, 14);
  }, [candles]);

  const rsiByTime = useMemo(() => {
    const m = new Map<number, number>();
    for (const p of rsiSeries) m.set(p.time as unknown as number, p.value);
    return m;
  }, [rsiSeries]);

  const rsiValue = useMemo(() => {
    if (activeTime != null) {
      const v = rsiByTime.get(activeTime);
      if (typeof v === "number") return v;
    }
    const last = rsiSeries[rsiSeries.length - 1];
    return last ? last.value : null;
  }, [activeTime, rsiByTime, rsiSeries]);

  const symbol =
    instance.target.type === "SYMBOL" ? instance.target.symbol : null;

  useEffect(() => {
    const viewId = `held-mini:${chartKey}`;

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

  const canPromote =
    instance.target.type === "SYMBOL" && symbol && symbol !== "—";

  const openChartModal = () => {
    if (!canPromote) return;
    const id =
      (globalThis.crypto as any)?.randomUUID?.() ||
      `chart-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    window.dispatchEvent(
      new CustomEvent("tp:modal:open", {
        detail: {
          id,
          type: "chart",
          title: symbol,
          position: { x: 120, y: 120 },
          size: { w: 720, h: 520 },
          state: {
            target: { type: "SYMBOL", symbol },
            range: instance.range,
            resolution: instance.resolution,
            indicators: {
              rsi: !!instance.indicators?.rsi,
              macd: !!instance.indicators?.macd,
              sma50: !!instance.indicators?.sma50,
              sma200: !!instance.indicators?.sma200,
            },
            source: "heldGrid",
          },
        },
      })
    );
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        openChartModal();
      }}
      onKeyDown={(e) => {
        if (!canPromote) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openChartModal();
        }
      }}
      aria-disabled={!canPromote}
      className={[
        "flex h-full min-h-[110px] flex-col overflow-hidden rounded-md border bg-neutral-950 text-left",
        canPromote
          ? "border-neutral-800 hover:border-neutral-700"
          : "border-neutral-900 opacity-70 cursor-not-allowed",
      ].join(" ")}
      title={canPromote ? "Promote to Primary" : "No symbol assigned"}
    >
      <div className="flex items-center justify-between border-b border-neutral-800 px-2 py-1">
        <div className="text-[11px] font-medium text-neutral-200">
          {labelForTarget(instance.target)}

          {symbol ? <SymbolFreshnessBadge symbol={symbol} /> : null}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-neutral-500">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openChartModal();
            }}
            disabled={!canPromote}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700 hover:text-neutral-100 disabled:opacity-40"
            title="Promote to Primary"
            aria-label="Promote to Primary"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6" />
              <path d="M10 14L21 3" />
              <path d="M9 21H3v-6" />
              <path d="M14 10L3 21" />
            </svg>
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (!symbol) return;
              window.dispatchEvent(
                new CustomEvent("tp:analysisGrid:addSymbols", {
                  detail: { symbols: [symbol] },
                })
              );
            }}
            disabled={!symbol}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700 hover:text-neutral-100 disabled:opacity-40"
            title="Send to Analysis Grid"
            aria-label="Send to Analysis Grid"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="4" width="7" height="7" />
              <rect x="13" y="4" width="7" height="7" />
              <rect x="4" y="13" width="7" height="7" />
              <rect x="13" y="13" width="7" height="7" />
            </svg>
          </button>
          {typeof rsiValue === "number" && (
            <span className="tabular-nums">RSI {rsiValue.toFixed(1)}</span>
          )}
          <span>{instance.range} • {instance.resolution}</span>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col p-1">
        {(loading || error) && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-[11px] text-neutral-500">
            {error ? "error" : "loading…"}
          </div>
        )}

        <div className="min-h-0 flex-1">
          <div className="relative h-full w-full overflow-hidden rounded-sm border border-neutral-900">
            <CandlesChart
              candles={candles}
              variant="mini"
              priceIn={priceIn}
              showSma50={instance.indicators.sma50}
              showSma200={instance.indicators.sma200}
              onChartReady={setMiniChart}
            />
            <IntradayFreshnessOverlay meta={meta} candlesCount={candles.length} />
          </div>
        </div>
        {instance.indicators.macd && miniChart && (
          <div className="mt-1 flex-none">
            <MacdPane
              candles={candles}
              activeTime={activeTime as any}
              syncChart={miniChart}
              height={80}
              rightPriceScaleVisible={false}
              timeScaleVisible={false}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default function HeldChartsGrid() {
  const slot1 = useChartInstance(CHART_KEYS.GRID_1 as any);
  const slot2 = useChartInstance(CHART_KEYS.GRID_2 as any);
  const slot3 = useChartInstance(CHART_KEYS.GRID_3 as any);
  const slot4 = useChartInstance(CHART_KEYS.GRID_4 as any);
  const slot5 = useChartInstance(CHART_KEYS.GRID_5 as any);
  const slot6 = useChartInstance(CHART_KEYS.GRID_6 as any);

  const slots = useMemo(
    () => [
      { key: CHART_KEYS.GRID_1, instance: slot1.instance, setTarget: slot1.setTarget },
      { key: CHART_KEYS.GRID_2, instance: slot2.instance, setTarget: slot2.setTarget },
      { key: CHART_KEYS.GRID_3, instance: slot3.instance, setTarget: slot3.setTarget },
      { key: CHART_KEYS.GRID_4, instance: slot4.instance, setTarget: slot4.setTarget },
      { key: CHART_KEYS.GRID_5, instance: slot5.instance, setTarget: slot5.setTarget },
      { key: CHART_KEYS.GRID_6, instance: slot6.instance, setTarget: slot6.setTarget },
    ],
    [
      slot1.instance,
      slot1.setTarget,
      slot2.instance,
      slot2.setTarget,
      slot3.instance,
      slot3.setTarget,
      slot4.instance,
      slot4.setTarget,
      slot5.instance,
      slot5.setTarget,
      slot6.instance,
      slot6.setTarget,
    ]
  );

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent;
      const detail = (ce?.detail ?? {}) as any;
      const symbol = String(detail.symbol ?? "").trim().toUpperCase();
      const held = Boolean(detail.held);
      if (!symbol) return;

      const current = slots.map((s) =>
        s.instance.target.type === "SYMBOL" ? s.instance.target.symbol : null
      );

      if (held) {
        // If already present, no-op.
        if (current.some((s) => s === symbol)) return;

        // Fill the first EMPTY slot.
        const emptyIdx = slots.findIndex((s) => s.instance.target.type === "EMPTY");
        if (emptyIdx === -1) return;

        slots[emptyIdx].setTarget({ type: "SYMBOL", symbol } as any);
        return;
      }

      // held=false: clear any slot currently holding this symbol.
      const idx = slots.findIndex(
        (s) => s.instance.target.type === "SYMBOL" && s.instance.target.symbol === symbol
      );
      if (idx === -1) return;

      slots[idx].setTarget({ type: "EMPTY" } as any);
    };

    window.addEventListener("tp:held:toggle", handler as any);
    return () => {
      window.removeEventListener("tp:held:toggle", handler as any);
    };
  }, [slots]);

  return (
    <section className="flex h-full min-h-0 flex-col rounded-lg border border-neutral-800 bg-neutral-950">
      <div className="border-b border-neutral-800 px-3 py-2 text-sm font-medium">
        Held Symbols
      </div>

      <div className="flex-1 min-h-0 p-3">
        <div className="grid h-full min-h-0 grid-cols-2 grid-rows-3 grid-auto-rows-fr gap-px rounded-md bg-neutral-800 p-px">
          <MiniChartCard chartKey={CHART_KEYS.GRID_1} />
          <MiniChartCard chartKey={CHART_KEYS.GRID_2} />
          <MiniChartCard chartKey={CHART_KEYS.GRID_3} />
          <MiniChartCard chartKey={CHART_KEYS.GRID_4} />
          <MiniChartCard chartKey={CHART_KEYS.GRID_5} />
          <MiniChartCard chartKey={CHART_KEYS.GRID_6} />
        </div>
      </div>
    </section>
  );
}