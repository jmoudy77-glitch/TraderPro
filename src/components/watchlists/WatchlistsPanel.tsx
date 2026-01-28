"use client";

import type { WatchlistKey } from "@/lib/watchlists/local-watchlists";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addWatchlistSymbol,
  clearPriceIn as clearPriceInAction,
  createWatchlist,
  getHoldingsMap,
  getWatchlistSymbols,
  reorderWatchlistSymbol,
  removeWatchlistSymbol,
  setHeld,
  setPriceIn,
  softDeleteWatchlist,
} from "@/app/actions/holdings";
import { useCandles } from "@/components/hooks/useCandles";
import CandlesChart from "@/components/charts/CandlesChart";
import { Sparkline1D } from "@/components/charts/Sparkline1D";

type RowVariant = "TRADE_LIST" | "SENTINEL";

type WatchlistSymbolDTO = {
  symbol: string;
  priceIn: number | null;
  held: boolean;
};

type TradeWatchlistKey = Exclude<WatchlistKey, "SENTINEL">;
type HoldingsMap = Record<string, { priceIn: number | null; held: boolean }>;

type SymbolMeta = {
  sector: string;
  sectorCode: string;
  industry?: string | null;
  industryCode?: string | null;
  industryAbbrev?: string | null;
  expiresAt?: string | null;
};

type SymbolMetaBySymbol = Record<string, SymbolMeta>;
type SectorOrderByWatchlistKey = Record<string, string[]>;

const SENTINEL_WATCH_ONLY_TOOLTIP =
  "Sentinels are for market diagnostic only. Ticker must be added to a different watchlist in order to be set as a holding.";

const CANONICAL_WATCHLIST_KEYS: WatchlistKey[] = [
  "SENTINEL",
  "LAUNCH_LEADERS",
  "HIGH_VELOCITY_MULTIPLIERS",
  "SLOW_BURNERS",
];

const CUSTOM_WATCHLIST_KEYS_STORAGE = "tp:watchlists:customKeys:v1";
const CUSTOM_WATCHLIST_TITLES_STORAGE = "tp:watchlists:customTitles:v1";

function normalizeWatchlistKey(input: string): string {
  const raw = (input ?? "").trim().toUpperCase();
  if (!raw) return "";

  // Reserved keys pass through.
  if (isReservedWatchlistKey(raw)) return raw;

  // If the caller already provided a CUSTOM_ key, do NOT double-prefix.
  // Normalize only the suffix into the DB-allowed slug pattern.
  const base = raw.startsWith("CUSTOM_") ? raw.slice("CUSTOM_".length) : raw;

  const slugBase = base
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slugBase) return "";

  const slug = slugBase.slice(0, 44); // DB: ^CUSTOM_[A-Z0-9_]{1,44}$
  return `CUSTOM_${slug}`;
}

function isReservedWatchlistKey(key: string): boolean {
  return CANONICAL_WATCHLIST_KEYS.includes(key as WatchlistKey);
}

function loadCustomWatchlistKeys(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_WATCHLIST_KEYS_STORAGE);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(
        parsed
          .map((x) => normalizeWatchlistKey(String(x ?? "")))
          .filter((k) => k && !isReservedWatchlistKey(k))
      )
    );
  } catch {
    return [];
  }
}

function saveCustomWatchlistKeys(keys: string[]) {
  try {
    localStorage.setItem(CUSTOM_WATCHLIST_KEYS_STORAGE, JSON.stringify(keys));
  } catch {
    // ignore
  }
}

function loadCustomWatchlistTitles(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CUSTOM_WATCHLIST_TITLES_STORAGE);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const key = normalizeWatchlistKey(String(k ?? ""));
      const title = String(v ?? "").trim();
      if (!key || isReservedWatchlistKey(key) || !title) continue;
      out[key] = title;
    }
    return out;
  } catch {
    return {};
  }
}

function saveCustomWatchlistTitles(map: Record<string, string>) {
  try {
    localStorage.setItem(CUSTOM_WATCHLIST_TITLES_STORAGE, JSON.stringify(map));
  } catch {
    // ignore
  }
}

function SymbolRow({
  symbol,
  industryAbbrev,
  industry,
  onPromote,
  onIntel,
  onSendToGrid,
  variant,
  priceIn,
  held,
  onEditPriceIn,
  onToggleHeld,
  showReorderControls,
  onMove,
  pctChange,
  prevClose,
  prevCloseDate,
  sparklinePoints,
  canRemove,
  onRemove,
}: {
  symbol: string;
  industryAbbrev?: string | null;
  industry?: string | null;
  onPromote: () => void;
  onIntel: () => void;
  onSendToGrid: () => void;
  variant: RowVariant;
  priceIn: number | null;
  held: boolean;
  onEditPriceIn: () => void;
  onToggleHeld: () => void;
  showReorderControls?: boolean;
  onMove?: (direction: "up" | "down") => void;
  pctChange?: number;
  prevClose?: number | null;
  prevCloseDate?: string | null;
  sparklinePoints?: number[];
  canRemove?: boolean;
  onRemove?: () => void;
}) {
  return (
    <div className="grid w-full grid-cols-[minmax(0,1fr)_96px_72px_auto_auto_auto_auto_auto] items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-2">
      {/* 1. Symbol + industry micro-pill */}
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onPromote}
          className="min-w-0 truncate text-left text-xs font-medium text-neutral-200 hover:underline"
          title={symbol}
        >
          {symbol}
        </button>
        {industryAbbrev ? (
          <span
            className="shrink-0 rounded-sm bg-neutral-900 px-1.5 py-0.5 text-[10px] text-neutral-300"
            title={industry ? `Industry: ${industry}` : "Industry"}
          >
            {industryAbbrev}
          </span>
        ) : null}
        {canRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
            title="Remove from watchlist"
            aria-label="Remove from watchlist"
          >
            ×
          </button>
        ) : null}
      </div>

      {/* 2. Sparkline */}
      <div className="text-neutral-400">
        <Sparkline1D
          points={sparklinePoints ?? []}
          baseline={typeof prevClose === "number" ? prevClose : undefined}
          positive={
            typeof prevClose === "number" && (sparklinePoints?.length ?? 0) > 0
              ? (sparklinePoints as number[])[(sparklinePoints as number[]).length - 1] >= prevClose
              : undefined
          }
        />
      </div>

      {/* 3-8: Actions and metrics, fixed columns */}
      {variant === "TRADE_LIST" ? (
        <>
          {/* % change (fixed column) */}
          <div className="flex justify-end">
            {typeof pctChange === "number" ? (
              <span
                className={
                  "rounded-full border px-2 py-0.5 text-[11px] " +
                  (pctChange >= 0 ? "border-green-800 text-green-400" : "border-red-800 text-red-400")
                }
                title={
                  "Day % (prev close → now)" +
                  (typeof prevClose === "number" ? ` • Prev close: ${prevClose}` : "") +
                  (prevCloseDate ? ` • Date: ${prevCloseDate}` : "")
                }
              >
                {pctChange >= 0 ? "+" : ""}
                {pctChange.toFixed(2)}%
              </span>
            ) : (
              <span className="h-[22px]" />
            )}
          </div>

          {/* Held */}
          <button
            type="button"
            onClick={onToggleHeld}
            className="rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-200 hover:border-neutral-700"
            title="Toggle held"
          >
            {held ? "Held" : "Not held"}
          </button>

          {/* IN @ */}
          <button
            type="button"
            onClick={onEditPriceIn}
            className="rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-200 hover:border-neutral-700"
            title="Edit price-in"
          >
            {priceIn == null ? "IN @ —" : `IN @ ${priceIn}`}
          </button>

          {/* Intel */}
          <button
            type="button"
            onClick={onIntel}
            className="rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-200 hover:border-neutral-700"
            title="Open Intel"
          >
            Intel
          </button>

          {/* Grid */}
          <button
            type="button"
            onClick={onSendToGrid}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
            title="Send to Analysis Grid"
            aria-label="Send to Analysis Grid"
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="4" y="4" width="7" height="7" />
              <rect x="13" y="4" width="7" height="7" />
              <rect x="4" y="13" width="7" height="7" />
              <rect x="13" y="13" width="7" height="7" />
            </svg>
          </button>

          {/* Promote (last) */}
          <button
            type="button"
            onClick={onPromote}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
            title="Promote to Primary"
            aria-label="Promote to Primary"
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15 3h6v6" />
              <path d="M10 14L21 3" />
              <path d="M9 21H3v-6" />
              <path d="M14 10L3 21" />
            </svg>
          </button>
        </>
      ) : (
        <>
          {/* % change */}
          <div className="flex justify-end">
            {typeof pctChange === "number" ? (
              <span
                className={
                  "rounded-full border px-2 py-0.5 text-[11px] " +
                  (pctChange >= 0 ? "border-green-800 text-green-400" : "border-red-800 text-red-400")
                }
                title={
                  "Day % (prev close → now)" +
                  (typeof prevClose === "number" ? ` • Prev close: ${prevClose}` : "") +
                  (prevCloseDate ? ` • Date: ${prevCloseDate}` : "")
                }
              >
                {pctChange >= 0 ? "+" : ""}
                {pctChange.toFixed(2)}%
              </span>
            ) : (
              <span className="h-[22px]" />
            )}
          </div>

          {/* Held slot uses WATCH_ONLY */}
          <button
            type="button"
            className="rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 cursor-help text-[11px] text-neutral-200 hover:border-neutral-700"
            title={SENTINEL_WATCH_ONLY_TOOLTIP}
          >
            WATCH_ONLY
          </button>

          {/* IN @ slot (blank for sentinel) */}
          <span className="h-[22px]" />

          {/* Intel */}
          <button
            type="button"
            onClick={onIntel}
            className="rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-200 hover:border-neutral-700"
            title="Open Intel"
          >
            Intel
          </button>

          {/* Grid */}
          <button
            type="button"
            onClick={onSendToGrid}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
            title="Send to Analysis Grid"
            aria-label="Send to Analysis Grid"
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="4" y="4" width="7" height="7" />
              <rect x="13" y="4" width="7" height="7" />
              <rect x="4" y="13" width="7" height="7" />
              <rect x="13" y="13" width="7" height="7" />
            </svg>
          </button>

          {/* Promote (last) */}
          <button
            type="button"
            onClick={onPromote}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
            title="Promote to Primary"
            aria-label="Promote to Primary"
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15 3h6v6" />
              <path d="M10 14L21 3" />
              <path d="M9 21H3v-6" />
              <path d="M14 10L3 21" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}

function WatchlistCard({
  title,
  subtitle,
  collapsed,
  onToggleCollapsed,
  watchlistKey,
  symbols,
  variant = "TRADE_LIST",
  getSymbolState,
  onEditPriceIn,
  onToggleHeld,
  onIntel,
  canAdd,
  onRequestAdd,
  addOpen,
  addValue,
  onChangeAddValue,
  onCommitAdd,
  onCancelAdd,
  reorderMode,
  onToggleReorderMode,
  onMoveSymbol,
  symbolMetaBySymbol,
  sectorOrder,
  onUpdateSectorOrder,
  onRemoveSymbol,
  onDeleteWatchlist,
}: {
  title: string;
  subtitle: string;
  watchlistKey: string;
  symbols: string[];
  variant?: RowVariant;
  getSymbolState: (symbol: string) => { priceIn: number | null; held: boolean };
  onEditPriceIn: (symbol: string) => void;
  onToggleHeld: (symbol: string) => void;
  onIntel: (symbol: string) => void;
  canAdd?: boolean;
  onRequestAdd?: () => void;
  addOpen?: boolean;
  addValue?: string;
  onChangeAddValue?: (v: string) => void;
  onCommitAdd?: () => void;
  onCancelAdd?: () => void;
  reorderMode?: boolean;
  onToggleReorderMode?: () => void;
  onMoveSymbol?: (symbol: string, direction: "up" | "down") => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  symbolMetaBySymbol: SymbolMetaBySymbol;
  sectorOrder?: string[];
  onUpdateSectorOrder?: (nextOrder: string[]) => void;
  onRemoveSymbol?: (symbol: string) => void;
  onDeleteWatchlist?: () => void;
}) {
  // V1 single-user: watchlist composites require ownerUserId to populate per-symbol meta (pctChange/sparkline).
  const OWNER_USER_ID = process.env.NEXT_PUBLIC_DEV_OWNER_USER_ID;
  const compositeTarget = useMemo(
    () =>
      ({
        type: "WATCHLIST_COMPOSITE",
        watchlistKey: watchlistKey as any,
      } as const),
    [watchlistKey]
  );
  const { candles: compositeCandles, meta: compositeMeta } = useCandles({
    target: compositeTarget,
    range: "1D",
    resolution: "5m",
    key: `watchlist:${watchlistKey}:1D:5m:${OWNER_USER_ID ?? "anon"}`,
    indicators: {
      rsi: false,
      macd: false,
      sma50: false,
      sma200: false,
    },
  });

  const compositePctChange = useMemo(() => {
    if (!compositeCandles || compositeCandles.length < 2) return null;
    const first = compositeCandles[0]?.close;
    const last = compositeCandles[compositeCandles.length - 1]?.close;
    if (typeof first !== "number" || typeof last !== "number" || first <= 0) return null;
    return ((last / first) - 1) * 100;
  }, [compositeCandles]);

  const rows: WatchlistSymbolDTO[] = useMemo(() => {
    return symbols.map((symbol) => {
      const st = getSymbolState(symbol);
      return { symbol, priceIn: st.priceIn, held: st.held };
    });
  }, [getSymbolState, symbols]);

  const rowsBySector = useMemo(() => {
    const m: Record<string, WatchlistSymbolDTO[]> = {};
    for (const r of rows) {
      const meta = symbolMetaBySymbol[r.symbol.toUpperCase()];
      const sector = meta?.sector || "Unclassified";
      if (!m[sector]) m[sector] = [];
      m[sector].push(r);
    }

    // Sort within each sector by industry abbrev (then symbol) for stable scanning.
    for (const [sectorName, list] of Object.entries(m)) {
      m[sectorName] = list.slice().sort((a, b) => {
        const am = symbolMetaBySymbol[a.symbol.toUpperCase()];
        const bm = symbolMetaBySymbol[b.symbol.toUpperCase()];

        const ai = (am?.industryAbbrev ?? "").toUpperCase();
        const bi = (bm?.industryAbbrev ?? "").toUpperCase();
        if (ai < bi) return -1;
        if (ai > bi) return 1;

        const as = a.symbol.toUpperCase();
        const bs = b.symbol.toUpperCase();
        return as < bs ? -1 : as > bs ? 1 : 0;
      });
    }

    return m;
  }, [rows, symbolMetaBySymbol]);

  const orderedSectors = useMemo(() => {
    const present = Object.keys(rowsBySector);
    const order = Array.isArray(sectorOrder) ? sectorOrder : [];

    const seen = new Set<string>();
    const out: string[] = [];

    for (const s of order) {
      if (present.includes(s) && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }

    for (const s of present) {
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }

    return out;
  }, [rowsBySector, sectorOrder]);

  const moveSector = useCallback(
    (sectorName: string, direction: "up" | "down") => {
      const current = orderedSectors.slice();
      const idx = current.indexOf(sectorName);
      if (idx < 0) return;

      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= current.length) return;

      const next = current.slice();
      const tmp = next[idx];
      next[idx] = next[swapIdx];
      next[swapIdx] = tmp;

      onUpdateSectorOrder?.(next);
    },
    [orderedSectors, onUpdateSectorOrder]
  );

  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950">
      <div className="border-b border-neutral-800 px-3 py-2">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="flex items-center gap-2 text-left text-sm font-medium text-neutral-200 hover:text-neutral-100"
            title={collapsed ? "Expand" : "Collapse"}
          >
            <span>{title}</span>
            <span className="text-xs text-neutral-500">{collapsed ? "▸" : "▾"}</span>
          </button>

          <div className="flex items-center gap-2">
            {canAdd ? (
              <button
                type="button"
                onClick={onRequestAdd}
                className="rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-200 hover:border-neutral-700"
                title="Add symbol"
              >
                Add
              </button>
            ) : null}
            {variant !== "SENTINEL" && !collapsed ? (
              <button
                type="button"
                onClick={onToggleReorderMode}
                className="rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-200 hover:border-neutral-700"
                title={reorderMode ? "Exit reorder mode" : "Reorder symbols"}
              >
                {reorderMode ? "Done" : "Reorder"}
              </button>
            ) : null}
            {onDeleteWatchlist ? (
              <button
                type="button"
                onClick={onDeleteWatchlist}
                className="rounded-full border border-red-900 bg-neutral-900 px-2 py-0.5 text-[11px] text-red-400 hover:border-red-700"
                title="Delete watchlist"
              >
                Delete
              </button>
            ) : null}
          </div>
        </div>

        <div className="text-xs text-neutral-500">{subtitle}</div>

        {variant === "SENTINEL" ? null : (
          <div
            className="mt-2 cursor-pointer rounded-md border border-neutral-800 bg-neutral-900 p-2 hover:border-neutral-700"
            onClick={() => {
              const id =
                (globalThis.crypto as any)?.randomUUID?.() ||
                `chart-${Date.now()}-${Math.random().toString(16).slice(2)}`;
              window.dispatchEvent(
                new CustomEvent("tp:modal:open", {
                  detail: {
                    id,
                    type: "chart",
                    title: `${title} (Composite)`,
                    position: { x: 120, y: 120 },
                    size: { w: 720, h: 520 },
                    state: {
                      target: {
                        type: "WATCHLIST_COMPOSITE",
                        watchlistKey: watchlistKey as TradeWatchlistKey,
                      },
                      range: "1D",
                      resolution: "5m",
                      indicators: {
                        rsi: true,
                        macd: true,
                        sma50: false,
                        sma200: false,
                      },
                      source: "watchlistComposite",
                    },
                  },
                })
              );
            }}
            title="Open composite chart"
          >
            <div className="relative h-24 w-full">
              {typeof compositePctChange === "number" ? (
                <div
                  className={
                    "absolute right-2 top-2 z-10 rounded-full border px-2 py-0.5 text-[11px] " +
                    (compositePctChange >= 0
                      ? "border-green-800 text-green-400"
                      : "border-red-800 text-red-400")
                  }
                  title="Day % (prev close → now)"
                >
                  {compositePctChange >= 0 ? "+" : ""}
                  {compositePctChange.toFixed(2)}%
                </div>
              ) : null}

              <CandlesChart candles={compositeCandles} variant="mini" showSma50={false} showSma200={false} />
            </div>
          </div>
        )}
      </div>

      {collapsed ? null : (
        <div className="p-3">
          {variant === "SENTINEL" ? (
            <div className="mb-3 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-3 text-[11px] text-neutral-500">
              Sentinel composite (diagnostic)
            </div>
          ) : null}

          {canAdd && addOpen ? (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 p-2">
              <input
                value={addValue ?? ""}
                onChange={(e) => onChangeAddValue?.(e.target.value)}
                className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-200 outline-none focus:border-neutral-700"
                placeholder="Add symbol (e.g., NVDA)"
              />
              <button
                type="button"
                onClick={onCommitAdd}
                className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-200 hover:border-neutral-700"
              >
                Add
              </button>
              <button
                type="button"
                onClick={onCancelAdd}
                className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-200 hover:border-neutral-700"
              >
                Cancel
              </button>
            </div>
          ) : null}

          {/* SENTINEL: keep flat list (no sector grouping) */}
          {variant === "SENTINEL" ? (
            <div className="space-y-2">
              {rows.map((row) => {
                const meta = symbolMetaBySymbol[row.symbol.toUpperCase()];
                return (
                  <SymbolRow
                    key={row.symbol}
                    symbol={row.symbol}
                    canRemove
                    onRemove={() => onRemoveSymbol?.(row.symbol)}
                    industry={meta?.industry ?? null}
                    industryAbbrev={meta?.industryAbbrev ?? null}
                    variant={variant}
                    priceIn={row.priceIn}
                    held={row.held}
                    onPromote={() => {
                      const id =
                        (globalThis.crypto as any)?.randomUUID?.() ||
                        `chart-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                      window.dispatchEvent(
                        new CustomEvent("tp:modal:open", {
                          detail: {
                            id,
                            type: "chart",
                            title: row.symbol,
                            position: { x: 120, y: 120 },
                            size: { w: 720, h: 520 },
                            state: {
                              target: { type: "SYMBOL", symbol: row.symbol },
                              range: "1D",
                              resolution: "5m",
                              indicators: {
                                rsi: true,
                                macd: true,
                                sma50: false,
                                sma200: false,
                              },
                              source: "watchlistRow",
                            },
                          },
                        })
                      );
                    }}
                    showReorderControls={false}
                    onMove={undefined}
                    onIntel={() => onIntel(row.symbol)}
                    onSendToGrid={() => {
                      window.dispatchEvent(
                        new CustomEvent("tp:analysisGrid:addSymbols", {
                          detail: { symbols: [row.symbol] },
                        })
                      );
                    }}
                    onEditPriceIn={() => onEditPriceIn(row.symbol)}
                    onToggleHeld={() => onToggleHeld(row.symbol)}
                    pctChange={compositeMeta?.constituents?.[row.symbol]?.pctChange}
                    prevClose={compositeMeta?.constituents?.[row.symbol]?.prevClose}
                    prevCloseDate={compositeMeta?.constituents?.[row.symbol]?.prevCloseDate}
                    sparklinePoints={compositeMeta?.constituents?.[row.symbol]?.sparkline1d}
                  />
                );
              })}
            </div>
          ) : (
            <div className="space-y-3">
              {orderedSectors.map((sectorName) => {
                const sectorRows = rowsBySector[sectorName] ?? [];
                if (sectorRows.length === 0) return null;

                return (
                  <div key={sectorName} className="rounded-md border border-neutral-800 bg-neutral-950">
                    <div className="flex items-center justify-between border-b border-neutral-900 px-2 py-1">
                      <div className="text-[11px] font-medium text-neutral-300">
                        {sectorName}
                        <span className="ml-2 text-[11px] text-neutral-600">({sectorRows.length})</span>
                      </div>

                      {Boolean(reorderMode) ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => moveSector(sectorName, "up")}
                            className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-200 hover:border-neutral-700"
                            title="Move sector up"
                          >
                            UP
                          </button>
                          <button
                            type="button"
                            onClick={() => moveSector(sectorName, "down")}
                            className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-200 hover:border-neutral-700"
                            title="Move sector down"
                          >
                            DN
                          </button>
                        </div>
                      ) : null}
                    </div>

                    <div className="space-y-2 p-2">
                      {sectorRows.map((row) => {
                        const meta = symbolMetaBySymbol[row.symbol.toUpperCase()];
                        return (
                          <SymbolRow
                            key={row.symbol}
                            symbol={row.symbol}
                            canRemove
                            onRemove={() => onRemoveSymbol?.(row.symbol)}
                            industry={meta?.industry ?? null}
                            industryAbbrev={meta?.industryAbbrev ?? null}
                            variant={variant}
                            priceIn={row.priceIn}
                            held={row.held}
                            onPromote={() => {
                              const id =
                                (globalThis.crypto as any)?.randomUUID?.() ||
                                `chart-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                              window.dispatchEvent(
                                new CustomEvent("tp:modal:open", {
                                  detail: {
                                    id,
                                    type: "chart",
                                    title: row.symbol,
                                    position: { x: 120, y: 120 },
                                    size: { w: 720, h: 520 },
                                    state: {
                                      target: { type: "SYMBOL", symbol: row.symbol },
                                      range: "1D",
                                      resolution: "5m",
                                      indicators: {
                                        rsi: true,
                                        macd: true,
                                        sma50: false,
                                        sma200: false,
                                      },
                                      source: "watchlistRow",
                                    },
                                  },
                                })
                              );
                            }}
                            showReorderControls={Boolean(reorderMode)}
                            onMove={(direction) => onMoveSymbol?.(row.symbol, direction)}
                            onIntel={() => onIntel(row.symbol)}
                            onSendToGrid={() => {
                              window.dispatchEvent(
                                new CustomEvent("tp:analysisGrid:addSymbols", {
                                  detail: { symbols: [row.symbol] },
                                })
                              );
                            }}
                            onEditPriceIn={() => onEditPriceIn(row.symbol)}
                            onToggleHeld={() => onToggleHeld(row.symbol)}
                            pctChange={compositeMeta?.constituents?.[row.symbol]?.pctChange}
                            prevClose={compositeMeta?.constituents?.[row.symbol]?.prevClose}
                            prevCloseDate={compositeMeta?.constituents?.[row.symbol]?.prevCloseDate}
                            sparklinePoints={compositeMeta?.constituents?.[row.symbol]?.sparkline1d}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function WatchlistsPanel() {
  const [intelOpen, setIntelOpen] = useState(false);
  const [intelSymbol, setIntelSymbol] = useState<string | null>(null);

  const [priceInBySymbol, setPriceInBySymbol] = useState<Record<string, number | null>>({});
  const [heldBySymbol, setHeldBySymbol] = useState<Record<string, boolean>>({});

  const [priceInEditorOpen, setPriceInEditorOpen] = useState(false);
  const [priceInEditorSymbol, setPriceInEditorSymbol] = useState<string | null>(null);
  const [priceInEditorValue, setPriceInEditorValue] = useState<string>("");

  const OWNER_USER_ID = process.env.NEXT_PUBLIC_DEV_OWNER_USER_ID;

  const [symbolsByWatchlistKey, setSymbolsByWatchlistKey] = useState<Record<string, string[]>>(() => ({
    SENTINEL: [],
    LAUNCH_LEADERS: [],
    HIGH_VELOCITY_MULTIPLIERS: [],
    SLOW_BURNERS: [],
  }));

  const [symbolMetaBySymbol, setSymbolMetaBySymbol] = useState<SymbolMetaBySymbol>({});
  const [sectorOrderByWatchlistKey, setSectorOrderByWatchlistKey] = useState<SectorOrderByWatchlistKey>(() => ({}));

  const [customWatchlistKeys, setCustomWatchlistKeys] = useState<string[]>([]);
  const [customWatchlistTitles, setCustomWatchlistTitles] = useState<Record<string, string>>({});
  const [newWatchlistOpen, setNewWatchlistOpen] = useState(false);
  const [newWatchlistValue, setNewWatchlistValue] = useState("");

  const fetchSymbolMeta = useCallback(async (symbols: string[]) => {
    const uniq = Array.from(new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)));
    if (uniq.length === 0) {
      setSymbolMetaBySymbol({});
      return;
    }

    try {
      const qs = encodeURIComponent(uniq.join(","));
      // Add a cache-buster to prevent any intermediary caching from serving a stale meta payload.
      const res = await fetch(`/api/market/symbol-meta?symbols=${qs}&t=${Date.now()}`, {
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
      });
      if (!res.ok) return;

      const json = await res.json();
      const meta = (json?.meta ?? {}) as Record<string, any>;

      const next: SymbolMetaBySymbol = {};
      for (const [k, v] of Object.entries(meta)) {
        const sym = String(k).toUpperCase();
        if (!v || typeof v !== "object") continue;
        next[sym] = {
          sector: String((v as any).sector ?? "Unclassified"),
          sectorCode: String((v as any).sectorCode ?? ""),
          industry: (v as any).industry ?? null,
          industryCode: (v as any).industryCode ?? null,
          industryAbbrev: (v as any).industryAbbrev ?? null,
          expiresAt: (v as any).expiresAt ?? null,
        };
      }
      // Merge to avoid dropping previously-known meta if a subsequent response is partial.
      setSymbolMetaBySymbol((prev) => ({ ...prev, ...next }));
    } catch {
      // fail-silent (v1)
    }
  }, []);

  const fetchSectorOrder = useCallback(
    async (watchlistKey: string) => {
      if (!OWNER_USER_ID) return;
      if (watchlistKey === "SENTINEL") return;

      try {
        const res = await fetch(
          `/api/watchlists/sector-order?ownerUserId=${encodeURIComponent(OWNER_USER_ID)}&watchlistKey=${encodeURIComponent(
            watchlistKey
          )}`,
          { cache: "no-store" }
        );
        if (!res.ok) return;

        const json = await res.json();
        const sectors = Array.isArray(json?.sectors) ? (json.sectors as string[]) : [];
        setSectorOrderByWatchlistKey((prev) => ({ ...prev, [watchlistKey]: sectors }));
      } catch {
        // fail-silent (v1)
      }
    },
    [OWNER_USER_ID]
  );

  const saveSectorOrder = useCallback(
    async (watchlistKey: string, sectors: string[]) => {
      if (!OWNER_USER_ID) return;
      if (watchlistKey === "SENTINEL") return;

      setSectorOrderByWatchlistKey((prev) => ({ ...prev, [watchlistKey]: sectors }));

      try {
        await fetch(`/api/watchlists/sector-order`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ownerUserId: OWNER_USER_ID, watchlistKey, sectors }),
        });
      } catch {
        // fail-silent (v1)
      }
    },
    [OWNER_USER_ID]
  );

  const [addOpenKey, setAddOpenKey] = useState<string | null>(null);
  const [addValue, setAddValue] = useState("");

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => ({
    SENTINEL: false,
    LAUNCH_LEADERS: false,
    HIGH_VELOCITY_MULTIPLIERS: false,
    SLOW_BURNERS: false,
  }));

  const toggleCollapsed = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !Boolean(prev[key]) }));
  };

  const [reorderMode, setReorderMode] = useState<Record<string, boolean>>(() => ({
    SENTINEL: false,
    LAUNCH_LEADERS: false,
    HIGH_VELOCITY_MULTIPLIERS: false,
    SLOW_BURNERS: false,
  }));

  const toggleReorderMode = (key: string) => {
    if (key === "SENTINEL") return;
    setReorderMode((prev) => ({ ...prev, [key]: !Boolean(prev[key]) }));
  };

  const refreshWatchlist = async (key: string) => {
    if (!OWNER_USER_ID) return;
    const syms = await getWatchlistSymbols(OWNER_USER_ID, key as any);
    setSymbolsByWatchlistKey((prev) => ({ ...prev, [String(key)]: syms }));
  };

  const removeSymbolLocal = async (key: string, symbol: string) => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    if (!OWNER_USER_ID) return;
    if (!globalThis.confirm?.(`Remove ${sym} from ${key}?`)) return;

    // Optimistic UI removal.
    setSymbolsByWatchlistKey((prev) => {
      const kk = String(key);
      const current = prev[kk] ?? [];
      return { ...prev, [kk]: current.filter((s) => s.toUpperCase() !== sym) };
    });

    try {
      await removeWatchlistSymbol(OWNER_USER_ID, key as any, sym);
    } catch {
      // If persistence fails, re-sync from DB.
      await refreshWatchlist(key);
      return;
    }

    // Re-sync from DB to ensure ordering/active set is canonical.
    await refreshWatchlist(key);
  };

  const moveSymbol = async (key: string, symbol: string, direction: "up" | "down") => {
    if (!OWNER_USER_ID) return;
    if (key === "SENTINEL") return;

    // optimistic swap
    setSymbolsByWatchlistKey((prev) => {
      const kk = String(key);
      const current = prev[kk] ?? [];
      const idx = current.indexOf(symbol);
      if (idx < 0) return prev;

      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= current.length) return prev;

      const next = current.slice();
      const tmp = next[idx];
      next[idx] = next[swapIdx];
      next[swapIdx] = tmp;

      return { ...prev, [kk]: next };
    });

    try {
      await reorderWatchlistSymbol(OWNER_USER_ID, key as any, symbol, direction);
    } finally {
      await refreshWatchlist(key);
    }
  };

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!OWNER_USER_ID) return;
        const map = (await getHoldingsMap(OWNER_USER_ID)) as HoldingsMap;
        if (cancelled) return;

        const nextPrice: Record<string, number | null> = {};
        const nextHeld: Record<string, boolean> = {};

        for (const [symbol, st] of Object.entries(map)) {
          nextPrice[symbol] = st.priceIn;
          nextHeld[symbol] = st.held;
        }

        setPriceInBySymbol(nextPrice);
        setHeldBySymbol(nextHeld);
      } catch {
        // fail-silent (v1)
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [OWNER_USER_ID]);

  useEffect(() => {
    try {
      const keys = loadCustomWatchlistKeys();
      setCustomWatchlistKeys(keys);
      const titles = loadCustomWatchlistTitles();
      setCustomWatchlistTitles(titles);

      // Ensure per-key buckets exist so the UI can render immediately.
      setSymbolsByWatchlistKey((prev) => {
        const next: any = { ...prev };
        for (const k of keys) if (!Array.isArray(next[k])) next[k] = [];
        return next;
      });
      setCollapsed((prev) => {
        const next: any = { ...prev };
        for (const k of keys) if (typeof next[k] !== "boolean") next[k] = false;
        return next;
      });
      setReorderMode((prev) => {
        const next: any = { ...prev };
        for (const k of keys) if (typeof next[k] !== "boolean") next[k] = false;
        return next;
      });
      setCustomWatchlistTitles((prev) => {
        const next = { ...prev };
        for (const k of keys) {
          if (!next[k]) next[k] = k;
        }
        saveCustomWatchlistTitles(next);
        return next;
      });
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!OWNER_USER_ID) return;

        const keys: any[] = [...CANONICAL_WATCHLIST_KEYS, ...customWatchlistKeys];

        const results = await Promise.all(
          keys.map(async (k) => {
            try {
              const syms = await getWatchlistSymbols(OWNER_USER_ID, k);
              return [k, syms] as const;
            } catch {
              return [k, [] as string[]] as const;
            }
          })
        );

        if (cancelled) return;

        setSymbolsByWatchlistKey((prev) => {
          const next: Record<string, string[]> = { ...(prev as any) };
          for (const [k, syms] of results) {
            next[String(k)] = syms;
          }
          return next as any;
        });
      } catch {
        // fail-silent (v1)
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [OWNER_USER_ID, customWatchlistKeys]);

  // hydrate symbol meta whenever symbols change
  useEffect(() => {
    const all: string[] = [];
    for (const syms of Object.values(symbolsByWatchlistKey)) {
      for (const s of syms) all.push(s);
    }
    fetchSymbolMeta(all);
  }, [symbolsByWatchlistKey, fetchSymbolMeta]);

  // hydrate sector order (trade watchlists + custom watchlists)
  useEffect(() => {
    if (!OWNER_USER_ID) return;

    const keys: string[] = [
      "LAUNCH_LEADERS",
      "HIGH_VELOCITY_MULTIPLIERS",
      "SLOW_BURNERS",
      ...customWatchlistKeys,
    ];

    for (const k of keys) fetchSectorOrder(k);
  }, [OWNER_USER_ID, fetchSectorOrder, customWatchlistKeys]);

  const getSymbolState = (symbol: string) => ({
    priceIn: Object.prototype.hasOwnProperty.call(priceInBySymbol, symbol) ? priceInBySymbol[symbol] ?? null : null,
    held: Object.prototype.hasOwnProperty.call(heldBySymbol, symbol) ? Boolean(heldBySymbol[symbol]) : false,
  });

  const openIntel = (symbol: string) => {
    setIntelSymbol(symbol);
    setIntelOpen(true);
  };

  const editPriceIn = (symbol: string) => {
    const current = priceInBySymbol[symbol] ?? null;
    setPriceInEditorSymbol(symbol);
    setPriceInEditorValue(current == null ? "" : String(current));
    setPriceInEditorOpen(true);
  };

  const closePriceInEditor = () => {
    setPriceInEditorOpen(false);
    setPriceInEditorSymbol(null);
    setPriceInEditorValue("");
  };

  const commitPriceIn = async () => {
    if (!priceInEditorSymbol) return;
    const trimmed = priceInEditorValue.trim();
    if (trimmed === "") return;
    const next = Number(trimmed);
    if (!Number.isFinite(next)) return;

    setPriceInBySymbol((prev) => ({ ...prev, [priceInEditorSymbol]: next }));
    if (OWNER_USER_ID) {
      try {
        await setPriceIn(OWNER_USER_ID, priceInEditorSymbol, next);
      } catch {}
    }
    closePriceInEditor();
  };

  const clearPriceIn = async () => {
    if (!priceInEditorSymbol) return;

    setPriceInBySymbol((prev) => ({ ...prev, [priceInEditorSymbol]: null }));
    if (OWNER_USER_ID) {
      try {
        await clearPriceInAction(OWNER_USER_ID, priceInEditorSymbol);
      } catch {}
    }
    closePriceInEditor();
  };

  const toggleHeldLocal = async (symbol: string) => {
    const next = !Boolean(heldBySymbol[symbol]);
    setHeldBySymbol((prev) => ({ ...prev, [symbol]: next }));
    if (OWNER_USER_ID) {
      try {
        await setHeld(OWNER_USER_ID, symbol, next);
      } catch {}
    }
  };

  const openAdd = (key: string) => {
    setAddOpenKey(key);
    setAddValue("");
  };

  const cancelAdd = () => {
    setAddOpenKey(null);
    setAddValue("");
  };

  const commitAdd = async (key: string) => {
    const nextSymbol = addValue.trim().toUpperCase();
    if (!nextSymbol) return;
    if (!OWNER_USER_ID) return;

    try {
      await addWatchlistSymbol(OWNER_USER_ID, key as any, nextSymbol);
    } catch {
      cancelAdd();
      return;
    }

    try {
      const syms = await getWatchlistSymbols(OWNER_USER_ID, key as any);
      setSymbolsByWatchlistKey((prev) => ({ ...prev, [String(key)]: syms }));
    } catch {}

    cancelAdd();
  };

  const createWatchlistLocal = async () => {
    if (!OWNER_USER_ID) return;

    const desiredTitle = newWatchlistValue.trim();
    if (!desiredTitle) return;

    try {
      const created = await createWatchlist(OWNER_USER_ID, desiredTitle);
      const key = normalizeWatchlistKey((created as any)?.key ?? "");
      const title = String((created as any)?.title ?? desiredTitle).trim() || desiredTitle;

      if (!key) return;
      if (isReservedWatchlistKey(key)) return;

      setCustomWatchlistKeys((prev) => {
        const next = Array.from(new Set([...prev, key]));
        saveCustomWatchlistKeys(next);
        return next;
      });

      setCustomWatchlistTitles((prev) => {
        const next = { ...prev, [key]: title };
        saveCustomWatchlistTitles(next);
        return next;
      });

      // Ensure buckets
      setSymbolsByWatchlistKey((prev) => {
        const next: any = { ...prev };
        if (!Array.isArray(next[key])) next[key] = [];
        return next;
      });
      setCollapsed((prev) => ({ ...(prev as any), [key]: false } as any));
      setReorderMode((prev) => ({ ...(prev as any), [key]: false } as any));

      // Hydrate symbols (likely empty)
      try {
        const syms = await getWatchlistSymbols(OWNER_USER_ID, key as any);
        setSymbolsByWatchlistKey((prev) => ({ ...(prev as any), [key]: syms } as any));
      } catch {
        // ignore
      }

      setNewWatchlistOpen(false);
      setNewWatchlistValue("");
    } catch {
      return;
    }
  };

  const deleteWatchlistLocal = async (key: string) => {
    if (!OWNER_USER_ID) return;
    if (isReservedWatchlistKey(key)) return;

    const ok = globalThis.confirm?.(`Delete watchlist "${key}"? This will remove it from your lists.`);
    if (!ok) return;

    // Optimistic UI removal
    setCustomWatchlistKeys((prev) => {
      const next = prev.filter((k) => k !== key);
      saveCustomWatchlistKeys(next);
      return next;
    });

    setSymbolsByWatchlistKey((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

    setCustomWatchlistTitles((prev) => {
      const next = { ...prev };
      delete next[key];
      saveCustomWatchlistTitles(next);
      return next;
    });

    setCollapsed((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

    setReorderMode((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

    setSectorOrderByWatchlistKey((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

    try {
      await softDeleteWatchlist(OWNER_USER_ID, key);
    } catch {
      // If persistence fails, force reload to canonical state
      window.location.reload();
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="text-sm font-medium">Watchlists</div>
          <button
            type="button"
            onClick={() => setNewWatchlistOpen((v) => !v)}
            className="rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-200 hover:border-neutral-700"
            title="Create a new watchlist"
          >
            New
          </button>
        </div>

        <div className="text-xs text-neutral-500">Symbol/⤢ → Modal • ☐☐ → Grid</div>
      </div>

      {newWatchlistOpen ? (
        <div className="border-b border-neutral-800 px-3 py-2">
          <div className="flex items-center gap-2">
            <input
              value={newWatchlistValue}
              onChange={(e) => setNewWatchlistValue(e.target.value)}
              className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-200 outline-none focus:border-neutral-700"
              placeholder="New watchlist name (e.g., My Swings)"
            />
            <button
              type="button"
              onClick={createWatchlistLocal}
              className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-200 hover:border-neutral-700"
              title="Create"
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => {
                setNewWatchlistOpen(false);
                setNewWatchlistValue("");
              }}
              className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-200 hover:border-neutral-700"
              title="Cancel"
            >
              Cancel
            </button>
          </div>
          <div className="mt-1 text-[11px] text-neutral-500">
            Names are stored with a canonical key in the database. Canonical system watchlists are reserved.
          </div>
        </div>
      ) : null}

      <div className="h-0 min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden p-3">
        <WatchlistCard
          title="Sentinel"
          subtitle="Risk permission • durability • macro stress (never traded)"
          watchlistKey="SENTINEL"
          variant="SENTINEL"
          symbols={symbolsByWatchlistKey["SENTINEL"] ?? []}
          getSymbolState={getSymbolState}
          onEditPriceIn={() => {}}
          onToggleHeld={() => {}}
          onIntel={openIntel}
          canAdd
          onRequestAdd={() => openAdd("SENTINEL")}
          addOpen={addOpenKey === "SENTINEL"}
          addValue={addValue}
          onChangeAddValue={setAddValue}
          onCommitAdd={() => commitAdd("SENTINEL")}
          onCancelAdd={cancelAdd}
          collapsed={Boolean(collapsed["SENTINEL"])}
          onToggleCollapsed={() => toggleCollapsed("SENTINEL")}
          reorderMode={Boolean(reorderMode["SENTINEL"])}
          onToggleReorderMode={() => toggleReorderMode("SENTINEL")}
          onMoveSymbol={(symbol, direction) => moveSymbol("SENTINEL", symbol, direction)}
          symbolMetaBySymbol={symbolMetaBySymbol}
          onRemoveSymbol={(symbol) => removeSymbolLocal("SENTINEL", symbol)}
        />

        <WatchlistCard
          title="Launch Leaders"
          subtitle="High-impulse breakouts (tracking)"
          watchlistKey="LAUNCH_LEADERS"
          symbols={symbolsByWatchlistKey["LAUNCH_LEADERS"] ?? []}
          getSymbolState={getSymbolState}
          onEditPriceIn={editPriceIn}
          onToggleHeld={toggleHeldLocal}
          onIntel={openIntel}
          canAdd
          onRequestAdd={() => openAdd("LAUNCH_LEADERS")}
          addOpen={addOpenKey === "LAUNCH_LEADERS"}
          addValue={addValue}
          onChangeAddValue={setAddValue}
          onCommitAdd={() => commitAdd("LAUNCH_LEADERS")}
          onCancelAdd={cancelAdd}
          collapsed={Boolean(collapsed["LAUNCH_LEADERS"])}
          onToggleCollapsed={() => toggleCollapsed("LAUNCH_LEADERS")}
          reorderMode={Boolean(reorderMode["LAUNCH_LEADERS"])}
          onToggleReorderMode={() => toggleReorderMode("LAUNCH_LEADERS")}
          onMoveSymbol={(symbol, direction) => moveSymbol("LAUNCH_LEADERS", symbol, direction)}
          symbolMetaBySymbol={symbolMetaBySymbol}
          sectorOrder={sectorOrderByWatchlistKey["LAUNCH_LEADERS"]}
          onUpdateSectorOrder={(next) => saveSectorOrder("LAUNCH_LEADERS", next)}
          onRemoveSymbol={(symbol) => removeSymbolLocal("LAUNCH_LEADERS", symbol)}
        />

        <WatchlistCard
          title="High-Velocity Multipliers"
          subtitle="Momentum continuation / expansion"
          watchlistKey="HIGH_VELOCITY_MULTIPLIERS"
          symbols={symbolsByWatchlistKey["HIGH_VELOCITY_MULTIPLIERS"] ?? []}
          getSymbolState={getSymbolState}
          onEditPriceIn={editPriceIn}
          onToggleHeld={toggleHeldLocal}
          onIntel={openIntel}
          canAdd
          onRequestAdd={() => openAdd("HIGH_VELOCITY_MULTIPLIERS")}
          addOpen={addOpenKey === "HIGH_VELOCITY_MULTIPLIERS"}
          addValue={addValue}
          onChangeAddValue={setAddValue}
          onCommitAdd={() => commitAdd("HIGH_VELOCITY_MULTIPLIERS")}
          onCancelAdd={cancelAdd}
          collapsed={Boolean(collapsed["HIGH_VELOCITY_MULTIPLIERS"])}
          onToggleCollapsed={() => toggleCollapsed("HIGH_VELOCITY_MULTIPLIERS")}
          reorderMode={Boolean(reorderMode["HIGH_VELOCITY_MULTIPLIERS"])}
          onToggleReorderMode={() => toggleReorderMode("HIGH_VELOCITY_MULTIPLIERS")}
          onMoveSymbol={(symbol, direction) => moveSymbol("HIGH_VELOCITY_MULTIPLIERS", symbol, direction)}
          symbolMetaBySymbol={symbolMetaBySymbol}
          sectorOrder={sectorOrderByWatchlistKey["HIGH_VELOCITY_MULTIPLIERS"]}
          onUpdateSectorOrder={(next) => saveSectorOrder("HIGH_VELOCITY_MULTIPLIERS", next)}
          onRemoveSymbol={(symbol) => removeSymbolLocal("HIGH_VELOCITY_MULTIPLIERS", symbol)}
        />

        <WatchlistCard
          title="Slow Burners"
          subtitle="Gradual trend builders"
          watchlistKey="SLOW_BURNERS"
          symbols={symbolsByWatchlistKey["SLOW_BURNERS"] ?? []}
          getSymbolState={getSymbolState}
          onEditPriceIn={editPriceIn}
          onToggleHeld={toggleHeldLocal}
          onIntel={openIntel}
          canAdd
          onRequestAdd={() => openAdd("SLOW_BURNERS")}
          addOpen={addOpenKey === "SLOW_BURNERS"}
          addValue={addValue}
          onChangeAddValue={setAddValue}
          onCommitAdd={() => commitAdd("SLOW_BURNERS")}
          onCancelAdd={cancelAdd}
          collapsed={Boolean(collapsed["SLOW_BURNERS"])}
          onToggleCollapsed={() => toggleCollapsed("SLOW_BURNERS")}
          reorderMode={Boolean(reorderMode["SLOW_BURNERS"])}
          onToggleReorderMode={() => toggleReorderMode("SLOW_BURNERS")}
          onMoveSymbol={(symbol, direction) => moveSymbol("SLOW_BURNERS", symbol, direction)}
          symbolMetaBySymbol={symbolMetaBySymbol}
          sectorOrder={sectorOrderByWatchlistKey["SLOW_BURNERS"]}
          onUpdateSectorOrder={(next) => saveSectorOrder("SLOW_BURNERS", next)}
          onRemoveSymbol={(symbol) => removeSymbolLocal("SLOW_BURNERS", symbol)}
        />

        {customWatchlistKeys.length > 0 ? (
          <div className="pt-2">
            <div className="mb-2 text-[11px] font-medium text-neutral-400">Custom Watchlists</div>
            <div className="space-y-3">
              {customWatchlistKeys.map((k) => (
                <WatchlistCard
                  key={k}
                  title={customWatchlistTitles[k] ?? k}
                  subtitle="Custom watchlist"
                  watchlistKey={k}
                  symbols={symbolsByWatchlistKey[k] ?? []}
                  getSymbolState={getSymbolState}
                  onEditPriceIn={editPriceIn}
                  onToggleHeld={toggleHeldLocal}
                  onIntel={openIntel}
                  canAdd
                  onRequestAdd={() => openAdd(k)}
                  addOpen={addOpenKey === k}
                  addValue={addValue}
                  onChangeAddValue={setAddValue}
                  onCommitAdd={() => commitAdd(k)}
                  onCancelAdd={cancelAdd}
                  collapsed={Boolean(collapsed[k])}
                  onToggleCollapsed={() => toggleCollapsed(k)}
                  reorderMode={Boolean(reorderMode[k])}
                  onToggleReorderMode={() => toggleReorderMode(k)}
                  onMoveSymbol={(symbol, direction) => moveSymbol(k, symbol, direction)}
                  symbolMetaBySymbol={symbolMetaBySymbol}
                  sectorOrder={sectorOrderByWatchlistKey[k]}
                  onUpdateSectorOrder={(next) => saveSectorOrder(k, next)}
                  onRemoveSymbol={(symbol) => removeSymbolLocal(k, symbol)}
                  onDeleteWatchlist={() => deleteWatchlistLocal(k)}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* Intel + Price-in modals can remain as you already have them; keeping minimal here */}
      {intelOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-950 p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Intel: {intelSymbol}</div>
              <button
                type="button"
                className="text-xs text-neutral-400 hover:text-neutral-200"
                onClick={() => setIntelOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="mt-3 text-xs text-neutral-500">Intel briefing placeholder.</div>
          </div>
        </div>
      )}

      {priceInEditorOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-950 p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Price-in: {priceInEditorSymbol}</div>
              <button type="button" className="text-xs text-neutral-400 hover:text-neutral-200" onClick={closePriceInEditor}>
                Close
              </button>
            </div>

            <div className="mt-3">
              <label className="mb-1 block text-xs text-neutral-500">Entry price</label>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                value={priceInEditorValue}
                onChange={(e) => setPriceInEditorValue(e.target.value)}
                className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-700"
                placeholder="e.g., 123.45"
              />
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={clearPriceIn}
                className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-200 hover:border-neutral-700"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={commitPriceIn}
                className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-200 hover:border-neutral-700"
              >
                Set
              </button>
              <button
                type="button"
                onClick={closePriceInEditor}
                className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-200 hover:border-neutral-700"
              >
                Cancel
              </button>
            </div>

            <div className="mt-3 text-xs text-neutral-500">
              Set commits explicitly; blank values are not accepted. Use Clear to remove.
            </div>
          </div>
        </div>
      )}
    </section>
  );
}