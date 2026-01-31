"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
} from "react";
import type { ChartKey } from "@/components/state/chart-keys";
import { CHART_KEYS } from "@/components/state/chart-keys";
import {
  DEFAULT_INDICATORS,
  DEFAULT_RANGE,
  DEFAULT_RESOLUTION,
  type ChartInstanceState,
  type ChartResolution,
  type ChartTarget,
  type ChartTimeRange,
  type Indicators,
} from "@/components/state/chart-types";

type ChartStateMap = Record<string, ChartInstanceState>;

type Action =
  | { type: "SET_TARGET"; key: ChartKey; target: ChartTarget }
  | { type: "SET_RANGE"; key: ChartKey; range: ChartTimeRange }
  | { type: "SET_RESOLUTION"; key: ChartKey; resolution: ChartResolution }
  | { type: "SET_INDICATORS"; key: ChartKey; indicators: Indicators }
  | { type: "TOGGLE_INDICATOR"; key: ChartKey; name: keyof Indicators }
  | {
      type: "RESET_INSTANCE";
      key: ChartKey;
      overrides?: Partial<Pick<ChartInstanceState, "target" | "range" | "resolution" | "indicators">>;
    }
  | { type: "SET_TARGETS"; updates: Array<{ key: ChartKey; target: ChartTarget }> };

function makeDefaultState(): ChartStateMap {
  return {
    [CHART_KEYS.PRIMARY]: {
      key: CHART_KEYS.PRIMARY,
      target: { type: "IXIC" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.GRID_1]: {
      key: CHART_KEYS.GRID_1,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.GRID_2]: {
      key: CHART_KEYS.GRID_2,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.GRID_3]: {
      key: CHART_KEYS.GRID_3,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.GRID_4]: {
      key: CHART_KEYS.GRID_4,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.GRID_5]: {
      key: CHART_KEYS.GRID_5,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.GRID_6]: {
      key: CHART_KEYS.GRID_6,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.ANALYSIS_GRID_1]: {
      key: CHART_KEYS.ANALYSIS_GRID_1,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.ANALYSIS_GRID_2]: {
      key: CHART_KEYS.ANALYSIS_GRID_2,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.ANALYSIS_GRID_3]: {
      key: CHART_KEYS.ANALYSIS_GRID_3,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.ANALYSIS_GRID_4]: {
      key: CHART_KEYS.ANALYSIS_GRID_4,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.ANALYSIS_GRID_5]: {
      key: CHART_KEYS.ANALYSIS_GRID_5,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.ANALYSIS_GRID_6]: {
      key: CHART_KEYS.ANALYSIS_GRID_6,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.ANALYSIS_GRID_7]: {
      key: CHART_KEYS.ANALYSIS_GRID_7,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.ANALYSIS_GRID_8]: {
      key: CHART_KEYS.ANALYSIS_GRID_8,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.ANALYSIS_GRID_9]: {
      key: CHART_KEYS.ANALYSIS_GRID_9,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.WATCHLIST_LAUNCH]: {
      key: CHART_KEYS.WATCHLIST_LAUNCH,
      target: { type: "WATCHLIST_COMPOSITE", watchlistKey: "LAUNCH_LEADERS" },
      range: "1Y",
      resolution: "1d",
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.WATCHLIST_HVM]: {
      key: CHART_KEYS.WATCHLIST_HVM,
      target: {
        type: "WATCHLIST_COMPOSITE",
        watchlistKey: "HIGH_VELOCITY_MULTIPLIERS",
      },
      range: "1Y",
      resolution: "1d",
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.WATCHLIST_SLOW]: {
      key: CHART_KEYS.WATCHLIST_SLOW,
      target: { type: "WATCHLIST_COMPOSITE", watchlistKey: "SLOW_BURNERS" },
      range: "1Y",
      resolution: "1d",
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_1]: {
      key: CHART_KEYS.MODAL_1,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_2]: {
      key: CHART_KEYS.MODAL_2,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_3]: {
      key: CHART_KEYS.MODAL_3,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_4]: {
      key: CHART_KEYS.MODAL_4,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_5]: {
      key: CHART_KEYS.MODAL_5,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_6]: {
      key: CHART_KEYS.MODAL_6,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_7]: {
      key: CHART_KEYS.MODAL_7,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_8]: {
      key: CHART_KEYS.MODAL_8,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_9]: {
      key: CHART_KEYS.MODAL_9,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_10]: {
      key: CHART_KEYS.MODAL_10,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_11]: {
      key: CHART_KEYS.MODAL_11,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_12]: {
      key: CHART_KEYS.MODAL_12,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_13]: {
      key: CHART_KEYS.MODAL_13,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_14]: {
      key: CHART_KEYS.MODAL_14,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_15]: {
      key: CHART_KEYS.MODAL_15,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_16]: {
      key: CHART_KEYS.MODAL_16,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_17]: {
      key: CHART_KEYS.MODAL_17,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_18]: {
      key: CHART_KEYS.MODAL_18,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_19]: {
      key: CHART_KEYS.MODAL_19,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_20]: {
      key: CHART_KEYS.MODAL_20,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_21]: {
      key: CHART_KEYS.MODAL_21,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_22]: {
      key: CHART_KEYS.MODAL_22,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_23]: {
      key: CHART_KEYS.MODAL_23,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
    [CHART_KEYS.MODAL_24]: {
      key: CHART_KEYS.MODAL_24,
      target: { type: "EMPTY" },
      range: DEFAULT_RANGE,
      resolution: DEFAULT_RESOLUTION,
      indicators: { ...DEFAULT_INDICATORS },
    },
  };
}

function makeEmptyInstance(key: ChartKey): ChartInstanceState {
  return {
    key,
    target: { type: "EMPTY" },
    range: DEFAULT_RANGE,
    resolution: DEFAULT_RESOLUTION,
    indicators: { ...DEFAULT_INDICATORS },
  };
}

function isSameTarget(a: ChartTarget, b: ChartTarget) {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "SYMBOL":
      return (a as any).symbol === (b as any).symbol;
    case "WATCHLIST_COMPOSITE":
      return (a as any).watchlistKey === (b as any).watchlistKey;
    default:
      return true;
  }
}

function isSameIndicators(a: Indicators, b: Indicators) {
  return (
    a.rsi === b.rsi &&
    a.macd === b.macd &&
    a.sma50 === b.sma50 &&
    a.sma200 === b.sma200
  );
}

function reducer(state: ChartStateMap, action: Action): ChartStateMap {
  // SET_TARGETS does not use action.key
  if (action.type === "SET_TARGETS") {
    let next = state;
    let changed = false;
    for (const { key, target } of action.updates) {
      const current = next[key];
      if (!current) continue;
      if (isSameTarget(current.target, target)) continue;
      if (!changed) {
        next = { ...next };
        changed = true;
      }
      next[key] = { ...current, target };
    }
    return next;
  }

  const current = state[action.key];
  if (!current) return state;

  switch (action.type) {
    case "SET_TARGET":
      if (isSameTarget(current.target, action.target)) return state;
      return { ...state, [action.key]: { ...current, target: action.target } };
    case "SET_RANGE":
      if (current.range === action.range) return state;
      return { ...state, [action.key]: { ...current, range: action.range } };
    case "SET_RESOLUTION":
      if (current.resolution === action.resolution) return state;
      return {
        ...state,
        [action.key]: { ...current, resolution: action.resolution },
      };
    case "SET_INDICATORS":
      if (isSameIndicators(current.indicators, action.indicators)) return state;
      return {
        ...state,
        [action.key]: { ...current, indicators: action.indicators },
      };
    case "TOGGLE_INDICATOR":
      return {
        ...state,
        [action.key]: {
          ...current,
          indicators: {
            ...current.indicators,
            [action.name]: !current.indicators[action.name],
          },
        },
      };
    case "RESET_INSTANCE": {
      const base = makeEmptyInstance(action.key);
      const overrides = action.overrides ?? {};
      return {
        ...state,
        [action.key]: {
          ...base,
          ...overrides,
          key: action.key,
        },
      };
    }
    default:
      return state;
  }
}

type ChartStateContextValue = {
  state: ChartStateMap;
  setTarget: (key: ChartKey, target: ChartTarget) => void;
  setRange: (key: ChartKey, range: ChartTimeRange) => void;
  setResolution: (key: ChartKey, resolution: ChartResolution) => void;
  toggleIndicator: (key: ChartKey, name: keyof Indicators) => void;
  setIndicators: (key: ChartKey, indicators: Indicators) => void;
  setTargets: (updates: Array<{ key: ChartKey; target: ChartTarget }>) => void;

  // Modal chart key allocation (v1)
  allocateModalKey: () => ChartKey;
  releaseModalKey: (key: ChartKey) => void;
};

const ChartStateContext = createContext<ChartStateContextValue | null>(null);

export function ChartStateProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, makeDefaultState);

  const setTarget = useCallback(
    (key: ChartKey, target: ChartTarget) =>
      dispatch({ type: "SET_TARGET", key, target }),
    []
  );

  const setRange = useCallback(
    (key: ChartKey, range: ChartTimeRange) =>
      dispatch({ type: "SET_RANGE", key, range }),
    []
  );

  const setResolution = useCallback(
    (key: ChartKey, resolution: ChartResolution) =>
      dispatch({ type: "SET_RESOLUTION", key, resolution }),
    []
  );

  const toggleIndicator = useCallback(
    (key: ChartKey, name: keyof Indicators) =>
      dispatch({ type: "TOGGLE_INDICATOR", key, name }),
    []
  );

  const setIndicators = useCallback(
    (key: ChartKey, indicators: Indicators) =>
      dispatch({ type: "SET_INDICATORS", key, indicators }),
    []
  );

  const resetInstance = useCallback(
    (
      key: ChartKey,
      overrides?: Partial<Pick<ChartInstanceState, "target" | "range" | "resolution" | "indicators">>
    ) => dispatch({ type: "RESET_INSTANCE", key, overrides }),
    []
  );

  const setTargets = useCallback(
    (updates: Array<{ key: ChartKey; target: ChartTarget }>) =>
      dispatch({ type: "SET_TARGETS", updates }),
    []
  );

  const usedModalKeysRef = useRef<Set<ChartKey>>(new Set());

  const allocateModalKey = useCallback((): ChartKey => {
    const candidates: ChartKey[] = [
      CHART_KEYS.MODAL_1,
      CHART_KEYS.MODAL_2,
      CHART_KEYS.MODAL_3,
      CHART_KEYS.MODAL_4,
      CHART_KEYS.MODAL_5,
      CHART_KEYS.MODAL_6,
      CHART_KEYS.MODAL_7,
      CHART_KEYS.MODAL_8,
      CHART_KEYS.MODAL_9,
      CHART_KEYS.MODAL_10,
      CHART_KEYS.MODAL_11,
      CHART_KEYS.MODAL_12,
      CHART_KEYS.MODAL_13,
      CHART_KEYS.MODAL_14,
      CHART_KEYS.MODAL_15,
      CHART_KEYS.MODAL_16,
      CHART_KEYS.MODAL_17,
      CHART_KEYS.MODAL_18,
      CHART_KEYS.MODAL_19,
      CHART_KEYS.MODAL_20,
      CHART_KEYS.MODAL_21,
      CHART_KEYS.MODAL_22,
      CHART_KEYS.MODAL_23,
      CHART_KEYS.MODAL_24,
    ];

    for (const k of candidates) {
      if (!usedModalKeysRef.current.has(k)) {
        usedModalKeysRef.current.add(k);
        // Hard reset on allocate so reused modal keys cannot carry stale targets (e.g. AMPL).
        resetInstance(k);
        return k;
      }
    }

    throw new Error("No available modal chart keys (exhausted MODAL_* pool)");
  }, [resetInstance]);

  const releaseModalKey = useCallback(
    (key: ChartKey) => {
      usedModalKeysRef.current.delete(key);
      // Hard reset on release to keep the pool clean even if a caller forgets to apply state.
      resetInstance(key);
    },
    [resetInstance]
  );

  const value = useMemo<ChartStateContextValue>(() => {
    return {
      state,
      setTarget,
      setRange,
      setResolution,
      toggleIndicator,
      setIndicators,
      setTargets,
      allocateModalKey,
      releaseModalKey,
    };
  }, [
    state,
    setTarget,
    setRange,
    setResolution,
    toggleIndicator,
    setIndicators,
    setTargets,
    allocateModalKey,
    releaseModalKey,
  ]);

  return (
    <ChartStateContext.Provider value={value}>
      {children}
    </ChartStateContext.Provider>
  );
}

export function useChartState() {
  const ctx = useContext(ChartStateContext);
  if (!ctx) throw new Error("useChartState must be used within ChartStateProvider");
  return ctx;
}

export function useChartInstance(key: ChartKey) {
  const ctx = useContext(ChartStateContext);
  if (!ctx) throw new Error("useChartInstance must be used within ChartStateProvider");

  const instance = ctx.state[key];
  if (!instance) throw new Error(`Chart instance not found for key: ${key}`);

  return {
    instance,
    setTarget: (target: ChartTarget) => ctx.setTarget(key, target),
    setRange: (range: ChartTimeRange) => ctx.setRange(key, range),
    setResolution: (resolution: ChartResolution) =>
      ctx.setResolution(key, resolution),
    toggleIndicator: (name: keyof Indicators) => ctx.toggleIndicator(key, name),
    setIndicators: (indicators: Indicators) => ctx.setIndicators(key, indicators),
  };
}