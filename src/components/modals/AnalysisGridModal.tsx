"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartPanel } from "@/components/charts/PrimaryChartPanel";
import { CHART_KEYS } from "@/components/state/chart-keys";
import { useChartState } from "@/components/state/ChartStateProvider";
import type { UTCTimestamp } from "lightweight-charts";

// Keep this modal loosely typed so it can evolve with the shell's ModalWindow type.
export default function AnalysisGridModal({
  modal,
  onPatch,
}: {
  modal: { id: string; title?: string; state?: any };
  onPatch: (patch: { state?: any }) => void;
}) {

  const state = modal?.state ?? {};

  const STORAGE_KEY = "tp:analysisGrid:v1";
  const hydratedRef = useRef(false);

  const symbols: string[] = Array.isArray(state.symbols) ? state.symbols : [];
  const page: number = typeof state.page === "number" ? state.page : 0;

  const range: any = state.range ?? "5D";
  const resolution: any = state.resolution ?? "1h";

  const indicators: any = {
    rsi: true,
    macd: true,
    sma50: !!state?.indicators?.sma50,
    sma200: !!state?.indicators?.sma200,
  };

  const persistable = useMemo(
    () => ({
      symbols,
      page,
      range,
      resolution,
      indicators,
    }),
    [symbols, page, range, resolution, indicators]
  );

  const pageSize = 9;
  const pageCount = Math.max(1, Math.ceil(symbols.length / pageSize));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);

  // Bulk add input
  const [bulkText, setBulkText] = useState<string>("");

  // Crosshair sync across tiles
  const [activeTime, setActiveTime] = useState<UTCTimestamp | null>(null);

  // Dedicated chart keys for analysis grid tiles (avoids MODAL_* collisions)
  const { setTarget, setRange, setResolution, setIndicators } = useChartState();

  const tileKeys = useMemo(
    () => [
      CHART_KEYS.ANALYSIS_GRID_1,
      CHART_KEYS.ANALYSIS_GRID_2,
      CHART_KEYS.ANALYSIS_GRID_3,
      CHART_KEYS.ANALYSIS_GRID_4,
      CHART_KEYS.ANALYSIS_GRID_5,
      CHART_KEYS.ANALYSIS_GRID_6,
      CHART_KEYS.ANALYSIS_GRID_7,
      CHART_KEYS.ANALYSIS_GRID_8,
      CHART_KEYS.ANALYSIS_GRID_9,
    ],
    []
  );

  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;

      const next = {
        symbols: Array.isArray(parsed.symbols) ? parsed.symbols : symbols,
        page: typeof parsed.page === "number" ? parsed.page : page,
        range: parsed.range ?? range,
        resolution: parsed.resolution ?? resolution,
        indicators: parsed.indicators ?? indicators,
      };

      // Only patch if something materially differs from current modal state.
      const differs =
        JSON.stringify({ symbols, page, range, resolution, indicators }) !==
        JSON.stringify({
          symbols: next.symbols,
          page: next.page,
          range: next.range,
          resolution: next.resolution,
          indicators: next.indicators,
        });

      if (differs) {
        onPatch({ state: { ...state, ...next } });
      }
    } catch {
      // Ignore storage/parse errors
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
    } catch {
      // Ignore quota / storage errors
    }
  }, [persistable]);

  const slots = useMemo(() => {
    const start = currentPage * pageSize;
    const pageSymbols = symbols.slice(start, start + pageSize);
    const filled = [...pageSymbols];
    while (filled.length < pageSize) filled.push("");
    return filled;
  }, [symbols, currentPage]);

  // Apply global + per-slot targets into chart instances.
  useEffect(() => {
    for (let i = 0; i < pageSize; i++) {
      const key = tileKeys[i];
      const sym = slots[i];

      // Global config
      setRange(key as any, range);
      setResolution(key as any, resolution);
      setIndicators(key as any, indicators);

      // Per-slot target
      if (sym && typeof sym === "string") {
        setTarget(key as any, { type: "SYMBOL", symbol: sym.toUpperCase() } as any);
      } else {
        setTarget(key as any, { type: "EMPTY" } as any);
      }
    }
  }, [tileKeys, slots, range, resolution, indicators, setRange, setResolution, setIndicators, setTarget]);

  const setModalState = useCallback(
    (next: any) => {
        onPatch({ state: { ...state, ...next } });
    },
    [onPatch, state]
  );

  const onBulkAdd = useCallback(() => {
    const raw = bulkText
      .split(/[^A-Za-z0-9\.\-]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.toUpperCase());

    if (raw.length === 0) return;

    const existing = new Set(symbols.map((s) => String(s).toUpperCase()));
    const nextSymbols: string[] = [...symbols];

    for (const s of raw) {
      if (!existing.has(s)) {
        existing.add(s);
        nextSymbols.push(s);
      }
    }

    setBulkText("");
    setModalState({ symbols: nextSymbols, page: 0, range: "5D", resolution: "1h", indicators });
  }, [bulkText, symbols, setModalState, indicators]);

  const onClearAll = useCallback(() => {
    setBulkText("");
    setActiveTime(null);
    setModalState({ symbols: [], page: 0, range: "5D", resolution: "1h", indicators });
  }, [setModalState, indicators]);

  const onPrev = useCallback(() => {
    setActiveTime(null);
    setModalState({ page: Math.max(0, currentPage - 1) });
  }, [currentPage, setModalState]);

  const onNext = useCallback(() => {
    setActiveTime(null);
    setModalState({ page: Math.min(pageCount - 1, currentPage + 1) });
  }, [currentPage, pageCount, setModalState]);

  const removeSymbol = useCallback(
    (symbol: string) => {
      const sym = String(symbol || "").trim().toUpperCase();
      if (!sym) return;

      const nextSymbols = symbols.filter((s) => String(s).toUpperCase() !== sym);

      // Recompute page bounds after removal.
      const nextPageCount = Math.max(1, Math.ceil(nextSymbols.length / pageSize));
      const nextPage = Math.min(currentPage, nextPageCount - 1);

      setActiveTime(null);
      setModalState({ symbols: nextSymbols, page: nextPage });
    },
    [symbols, pageSize, currentPage, setModalState]
  );

  // Promote (expand) a grid tile to a chart modal
  const promoteFromGrid = useCallback(
    (symbol: string) => {
      const sym = String(symbol || "").trim().toUpperCase();
      if (!sym) return;

      const id =
        (globalThis.crypto as any)?.randomUUID?.() ||
        `chart-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      window.dispatchEvent(
        new CustomEvent("tp:modal:open", {
          detail: {
            id,
            type: "chart",
            title: sym,
            position: { x: 120, y: 120 },
            size: { w: 760, h: 560 },
            state: {
              target: { type: "SYMBOL", symbol: sym },
              range,
              resolution,
              indicators,
              source: "analysisGrid",
            },
          },
        })
      );
    },
    [range, resolution, indicators]
  );

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-neutral-100">
            {modal.title ?? "Pre-trade Analysis"}
          </div>
          <div className="text-[11px] text-neutral-400">
            Global: {String(range)} / {String(resolution)} • Tiles: {symbols.length} • Page {currentPage + 1}/
            {pageCount}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPrev}
            disabled={currentPage <= 0}
            className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 disabled:opacity-40"
            title="Previous page"
          >
            Prev
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={currentPage >= pageCount - 1}
            className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 disabled:opacity-40"
            title="Next page"
          >
            Next
          </button>
          <button
            type="button"
            onClick={onClearAll}
            className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-900"
            title="Clear all symbols"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-neutral-900 px-3 py-2">
        <input
          value={bulkText}
          onChange={(e) => setBulkText(e.target.value)}
          placeholder="Bulk add symbols (comma/space separated): QQQ, NVDA, MSFT…"
          className="min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500"
        />
        <button
          type="button"
          onClick={onBulkAdd}
          className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 hover:bg-neutral-800"
          title="Add symbols"
        >
          Add
        </button>
      </div>

      <div className="min-h-0 flex-1 p-2">
        <div className="grid h-full min-h-0 grid-cols-3 grid-rows-3 gap-2">
          {Array.from({ length: pageSize }).map((_, i) => {
            const key = tileKeys[i];
            const sym = slots[i];
            const label = sym ? sym.toUpperCase() : "Empty";

            return (
              <div key={`${key}-${i}`} className="min-h-0 overflow-hidden rounded-md border border-neutral-900 bg-neutral-950">
                <div className="flex items-center justify-between border-b border-neutral-900 px-2 py-1 text-[11px] text-neutral-300">
                  <div className="truncate font-medium text-neutral-200">{label}</div>
                  <div className="flex items-center gap-2">
                    {sym ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          promoteFromGrid(sym);
                        }}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
                        title="Open chart"
                        aria-label="Open chart"
                      >
                        ⤢
                      </button>
                    ) : null}
                    {sym ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeSymbol(sym);
                        }}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-[16px] leading-none text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
                        title="Remove from grid"
                        aria-label="Remove from grid"
                      >
                        ×
                      </button>
                    ) : null}
                    <div className="text-neutral-500">5D/1h</div>
                  </div>
                </div>
                <div className="min-h-0 h-[calc(100%-1.5rem)]">
                  <ChartPanel
                    chartKey={key}
                    title={label}
                    mode="tile"
                    activeTime={activeTime}
                    onActiveTimeChange={setActiveTime}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}