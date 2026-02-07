"use client";

import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ChartModal from "../modals/ChartModal";
import AnalysisGridModal from "../modals/AnalysisGridModal";

import ProviderStatusIndicator from "../realtime/ProviderStatusIndicator";

// -------------------- Industry Intraday Modal (non-durable, v1) --------------------
// NOTE: This modal is intentionally non-durable and modal-only. It does not write posture truth.

type IndustryIntradayState = {
  industryCode?: string;
  industryAbbrev?: string;
  relToIndex?: "OUTPERFORM" | "UNDERPERFORM" | "INLINE";
  trend5d?: "UP" | "DOWN" | "FLAT";
  symbols?: string[];
};

function IndustryIntradayModal(props: { modal: ModalWindow }) {
  const { modal } = props;
  const { openModal } = useModalManager();

  const state = (modal.state ?? {}) as IndustryIntradayState;
  const industryAbbrev =
    String(state.industryAbbrev ?? state.industryCode ?? "").trim() || "Industry";
  const rel = state.relToIndex ?? "INLINE";
  const trend = state.trend5d ?? "FLAT";
  const subtitle = `Daily posture: ${rel} | 5d: ${trend}`;

  const symbols = Array.isArray(state.symbols)
    ? state.symbols
        .filter((s) => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim().toUpperCase())
    : [];

  const sortedSymbols = useMemo(() => Array.from(new Set(symbols)).sort(), [symbols]);

  const openSymbolChart = useCallback(
    (symbol: string) => {
      const sym = String(symbol ?? "").trim().toUpperCase();
      if (!sym) return;

      openModal({
        id: `chart:${sym}:${Date.now()}`,
        type: "chart",
        title: sym,
        position: { x: modal.position.x + 40, y: modal.position.y + 40 },
        size: { w: 1180, h: 760 },
        state: {
          target: { type: "SYMBOL", symbol: sym },
        },
      });
    },
    [openModal, modal.position.x, modal.position.y]
  );

  type IndustryIntradayRow = {
    symbol: string;
    last: number | null;
    pctSinceOpen: number;
    pct60m: number;
  };

  type IndustryIntradaySummary = {
    breadth: {
      green: number;
      red: number;
      total: number;
      pctGreen: number;
      pctRed: number;
    };
    leaders: IndustryIntradayRow[];
    laggards: IndustryIntradayRow[];
  };

  type IndustryIntradayResponse = {
    ok: boolean;
    summary?: IndustryIntradaySummary;
    rows?: IndustryIntradayRow[];
    error?: any;
  };

  type SparklinePoint = { d: string; pct: number | null };

  type IndustryRotationSparklinesResponse = {
    ok: boolean;
    meta?: {
      industryCode: string;
      symbols: string[];
      days: number;
      calendar: string;
      metric: string;
      unit: string;
      timezone: string;
      asOfDay: string;
    };
    axis?: { days: string[] };
    industry?: { method: string; points: SparklinePoint[] };
    seriesBySymbol?: Record<string, { points: SparklinePoint[]; coverage: number }>;
    scale?: { yMin: number; yMax: number; method: string };
    error?: any;
  };

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<IndustryIntradayResponse | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);

  const [sparkLoading, setSparkLoading] = useState(false);
  const [sparkError, setSparkError] = useState<string | null>(null);
  const [sparklines, setSparklines] = useState<IndustryRotationSparklinesResponse | null>(null);

  // Hover-sync across sparklines (macro context)
  const [sparkHoverIndex, setSparkHoverIndex] = useState<number | null>(null);
  const [sparkHoverActive, setSparkHoverActive] = useState(false);

  const industryCode = String(state.industryCode ?? "").trim().toUpperCase();

  const symbolsKey = useMemo(() => sortedSymbols.join(","), [sortedSymbols]);

  const intradayBySymbol = useMemo(() => {
    const rows = Array.isArray(data?.rows) ? data!.rows! : [];
    const m = new Map<string, IndustryIntradayRow>();
    for (const r of rows) m.set(String(r.symbol).toUpperCase(), r);
    return m;
  }, [data]);

  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

  const buildSparkPath = useCallback(
    (pts: Array<number | null>, w: number, h: number) => {
      const n = pts.length;
      if (n <= 1) return "";

      const finite = pts.filter((v) => typeof v === "number" && Number.isFinite(v)) as number[];
      if (finite.length === 0) return "";

      const min = Math.min(...finite);
      const max = Math.max(...finite);
      const span = max - min;

      const xStep = w / (n - 1);
      const yFor = (v: number) => {
        if (!Number.isFinite(v)) return h / 2;
        if (span === 0) return h / 2;
        const t = (v - min) / span;
        return h - clamp01(t) * h;
      };

      let d = "";
      for (let i = 0; i < n; i++) {
        const v = pts[i];
        const x = i * xStep;
        const y = typeof v === "number" && Number.isFinite(v) ? yFor(v) : h / 2;
        d += i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
      }
      return d;
    },
    []
  );

  const Sparkline = useCallback(
    (props: {
      points: Array<number | null>;
      width?: number;
      height?: number;
      hoverIndex?: number | null;
    }) => {
      const w = props.width ?? 180;
      const h = props.height ?? 34;
      const pts = Array.isArray(props.points) ? props.points : [];
      const n = pts.length;
      const d = buildSparkPath(pts, w, h);

      // Hover line x-position is derived from the point index so all rails align.
      const idx = typeof props.hoverIndex === "number" ? props.hoverIndex : null;
      const showLine = idx != null && n > 1 && idx >= 0 && idx < n;
      const xStep = n > 1 ? w / (n - 1) : 0;
      const x = showLine ? idx * xStep : 0;

      return (
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          className="block"
          aria-hidden="true"
        >
          <path d={d || ""} fill="none" stroke="currentColor" strokeWidth="1.5" />
          {showLine ? (
            <line
              x1={x}
              x2={x}
              y1={0}
              y2={h}
              stroke="currentColor"
              strokeWidth={1}
              opacity={0.35}
            />
          ) : null}
        </svg>
      );
    },
    [buildSparkPath]
  );

  const fmtPctMaybe = (x: number | null | undefined) =>
    typeof x === "number" && Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : "—";

  // Spark rail layout constants (keep all rows horizontally aligned)
  const SPARK_W = 520;
  const SPARK_H_INDUSTRY = 42;
  const SPARK_H_ROW = 34;

  const sparkAxisDays = sparklines?.axis?.days ?? [];
  const sparkN = sparkAxisDays.length;

  const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const pickHoverIndexFromClientX = useCallback(
    (clientX: number, el: HTMLElement | null) => {
      if (!el) return null;
      if (!sparkN || sparkN <= 1) return null;
      const r = el.getBoundingClientRect();
      const x = clientX - r.left;
      const t = r.width > 0 ? x / r.width : 0;
      const idx = Math.round(t * (sparkN - 1));
      return clampInt(idx, 0, sparkN - 1);
    },
    [sparkN]
  );

  const fmtPctMaybeSpark = (x: number | null | undefined) =>
    typeof x === "number" && Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : "—";

  const fetchIntraday = useCallback(async () => {
    if (!symbolsKey) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const controller = new AbortController();
    const t = window.setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(`/api/realtime/industry-intraday?symbols=${encodeURIComponent(symbolsKey)}`,
        {
          cache: "no-store",
          signal: controller.signal,
        }
      );

      const json = (await res.json()) as IndustryIntradayResponse;
      if (!json || json.ok !== true) {
        setData(json ?? null);
        setError("intraday_unavailable");
      } else {
        setData(json);
        setLastFetchedAt(Date.now());
      }
    } catch {
      setError("intraday_fetch_failed");
    } finally {
      window.clearTimeout(t);
      setLoading(false);
    }
  }, [symbolsKey]);

  const fetchSparklines = useCallback(async () => {
    if (!industryCode || !symbolsKey) {
      setSparklines(null);
      setSparkError(null);
      setSparkLoading(false);
      return;
    }

    setSparkLoading(true);
    setSparkError(null);

    const controller = new AbortController();
    const t = window.setTimeout(() => controller.abort(), 12000);

    try {
      const url = `/api/market/industry-rotation-sparklines?industryCode=${encodeURIComponent(
        industryCode
      )}&symbols=${encodeURIComponent(symbolsKey)}`;

      const res = await fetch(url, { cache: "no-store", signal: controller.signal });
      const json = (await res.json()) as IndustryRotationSparklinesResponse;
      if (!json || json.ok !== true) {
        setSparklines(json ?? null);
        setSparkError("sparklines_unavailable");
      } else {
        setSparklines(json);
      }
    } catch {
      setSparkError("sparklines_fetch_failed");
    } finally {
      window.clearTimeout(t);
      setSparkLoading(false);
    }
  }, [industryCode, symbolsKey]);

  useEffect(() => {
    // Fetch once when modal opens / symbols set changes.
    fetchIntraday();
    fetchSparklines();

    // Light polling for intraday while the modal stays open.
    const id = window.setInterval(() => {
      fetchIntraday();
    }, 10000);

    return () => window.clearInterval(id);
  }, [fetchIntraday, fetchSparklines]);

  const rowsSorted = useMemo(() => {
    const rows = Array.isArray(data?.rows) ? data!.rows! : [];
    return [...rows].sort((a, b) => b.pctSinceOpen - a.pctSinceOpen);
  }, [data]);

  const fmtPct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const fmtPrice = (x: number | null) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(2) : "—");

  const breadth = data?.summary?.breadth;
  const leaders = data?.summary?.leaders ?? [];
  const laggards = data?.summary?.laggards ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-neutral-800 px-3 py-2">
        <div className="text-xs font-medium text-neutral-200">{industryAbbrev} — Intraday</div>
        <div className="mt-0.5 text-[10px] text-neutral-400">{subtitle}</div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[10px] text-neutral-500">
            Source: realtime-ws (5m) • modal-only • non-durable
          </div>
          <div className="text-[10px] text-neutral-500">
            {loading ? "Updating…" : lastFetchedAt ? `Updated ${new Date(lastFetchedAt).toLocaleTimeString()}` : ""}
          </div>
        </div>

        {/* A) Industry intraday summary */}
        <div className="mb-3 rounded border border-neutral-800 bg-neutral-900/30 p-3">
          {breadth ? (
            <div className="flex flex-wrap items-center gap-3">
              <div className="text-xs text-neutral-200">
                Breadth: <span className="font-medium">{breadth.green}</span> green / <span className="font-medium">{breadth.red}</span> red
              </div>
              <div className="text-xs text-neutral-400">
                ({Math.round(breadth.pctGreen * 100)}% green)
              </div>

              <div className="ml-auto flex flex-wrap gap-2">
                <div className="text-[10px] text-neutral-500">Leaders:</div>
                {leaders.map((r) => (
                  <button
                    key={`lead-${r.symbol}`}
                    type="button"
                    className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-[10px] text-neutral-200 hover:border-neutral-600"
                    onClick={() => openSymbolChart(r.symbol)}
                    title="Open chart"
                  >
                    {r.symbol} {fmtPct(r.pctSinceOpen)}
                  </button>
                ))}
                <div className="ml-2 text-[10px] text-neutral-500">Laggards:</div>
                {laggards.map((r) => (
                  <button
                    key={`lag-${r.symbol}`}
                    type="button"
                    className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-[10px] text-neutral-200 hover:border-neutral-600"
                    onClick={() => openSymbolChart(r.symbol)}
                    title="Open chart"
                  >
                    {r.symbol} {fmtPct(r.pctSinceOpen)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-xs text-neutral-400">
              {symbolsKey.length === 0
                ? "No constituents available for this industry."
                : error
                  ? "Intraday stats unavailable (route missing or upstream unavailable)."
                  : "Loading intraday stats…"}
            </div>
          )}
        </div>

        {/* B) Rotation context (30D daily % change) + intraday pills */}
        <div className="mb-3 rounded border border-neutral-800 bg-neutral-900/20 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[10px] text-neutral-500">Rotation context • 30D • daily % change</div>
            <div className="text-[10px] text-neutral-500">
              {sparkLoading ? "Loading…" : sparklines?.meta?.asOfDay ? `As of ${sparklines.meta.asOfDay}` : ""}
            </div>
          </div>

          {sparklines?.ok && Array.isArray(sparklines.industry?.points) && sparklines.industry!.points.length > 0 ? (
            <div
              className="grid items-center gap-3"
              style={{ gridTemplateColumns: "64px 1fr 96px" }}
            >
              <div className="text-xs font-medium text-neutral-200">Industry</div>

              <div
                className="relative"
                style={{ width: SPARK_W }}
                onMouseEnter={() => setSparkHoverActive(true)}
                onMouseLeave={() => {
                  setSparkHoverActive(false);
                  setSparkHoverIndex(null);
                }}
                onMouseMove={(e) => {
                  const idx = pickHoverIndexFromClientX(e.clientX, e.currentTarget);
                  if (idx == null) return;
                  setSparkHoverActive(true);
                  setSparkHoverIndex(idx);
                }}
                aria-label="Rotation context hover rail"
              >
                <div className="text-neutral-300">
                  <Sparkline
                    points={sparklines.industry!.points.map((p) =>
                      typeof p.pct === "number" ? p.pct : null
                    )}
                    width={SPARK_W}
                    height={SPARK_H_INDUSTRY}
                    hoverIndex={sparkHoverActive ? sparkHoverIndex : null}
                  />
                </div>
              </div>

              <div className="w-24 text-right">
                <span className="inline-flex min-w-[76px] items-center justify-center rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-[10px] font-medium text-neutral-200">
                  {sparkHoverActive && typeof sparkHoverIndex === "number"
                    ? fmtPctMaybeSpark(
                        sparklines.industry!.points[sparkHoverIndex]?.pct ?? null
                      )
                    : ""}
                </span>
              </div>
            </div>
          ) : (
            <div className="text-xs text-neutral-400">
              {sparkError
                ? "Rotation context unavailable (daily tape missing or endpoint error)."
                : sparkLoading
                  ? "Loading rotation context…"
                  : "No rotation context available for these constituents."}
            </div>
          )}
        </div>

        <div className="space-y-2">
          {sortedSymbols.map((sym) => {
            const series = sparklines?.seriesBySymbol?.[sym]?.points ?? [];
            const points = Array.isArray(series)
              ? series.map((p) => (typeof p.pct === "number" ? p.pct : null))
              : [];

            const intr = intradayBySymbol.get(sym);
            const intradayPill = intr ? fmtPctMaybe(intr.pctSinceOpen) : "—";

            const hoverPill =
              sparkHoverActive && typeof sparkHoverIndex === "number" && sparkHoverIndex >= 0
                ? fmtPctMaybeSpark((series as any)?.[sparkHoverIndex]?.pct ?? null)
                : null;

            return (
              <button
                key={sym}
                type="button"
                className="grid w-full items-center gap-3 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-left hover:border-neutral-600"
                style={{ gridTemplateColumns: "64px 1fr 96px" }}
                onClick={() => openSymbolChart(sym)}
                title="Open chart"
              >
                <div className="w-16 text-xs font-semibold text-neutral-100">{sym}</div>

                <div className="min-w-0" style={{ width: SPARK_W }}>
                  {points.length > 1 ? (
                    <div className="text-neutral-300">
                      <Sparkline
                        points={points}
                        width={SPARK_W}
                        height={SPARK_H_ROW}
                        hoverIndex={sparkHoverActive ? sparkHoverIndex : null}
                      />
                    </div>
                  ) : (
                    <div style={{ height: SPARK_H_ROW }} />
                  )}
                </div>

                <div className="w-24 text-right">
                  <span className="inline-flex min-w-[76px] items-center justify-center rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-[10px] font-medium text-neutral-200">
                    {hoverPill ?? intradayPill}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// -------------------- User Preferences (client-side semantic overlay, v1) --------------------
// NOTE: This is intentionally minimal and designed to be backed by `public.user_preferences`.
// Until auth exists, the API route can use DEV owner id like other routes.

type UserPreferences = {
  timezone: string; // IANA tz, e.g. "America/New_York"
};

const DEFAULT_TIMEZONE =
  process.env.NEXT_PUBLIC_DEV_OWNER_TZ ??
  process.env.DEV_OWNER_TZ ??
  "America/Chicago";

function sanitizeTimezone(raw: unknown): string {
  const candidate = typeof raw === "string" ? raw.trim() : "";
  if (!candidate) return DEFAULT_TIMEZONE;

  // Validate IANA tz. If invalid, fall back to DEFAULT_TIMEZONE.
  try {
    // Intl throws RangeError for invalid timeZone.
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

type UserPreferencesContextValue = {
  prefs: UserPreferences;
  setTimezone: (tz: string) => void;
  refresh: () => Promise<void>;
};

const UserPreferencesContext = createContext<UserPreferencesContextValue | null>(null);

export function useUserPreferences() {
  const ctx = useContext(UserPreferencesContext);
  if (!ctx) throw new Error("useUserPreferences must be used within UserPreferencesContext");
  return ctx;
}

function UserPreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<UserPreferences>({ timezone: DEFAULT_TIMEZONE });
  const [loadedOnce, setLoadedOnce] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/user/preferences", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP_${res.status}`);
      const json = (await res.json()) as any;
      if (json && json.ok && json.preferences && typeof json.preferences.timezone === "string") {
        setPrefs({ timezone: sanitizeTimezone(json.preferences.timezone) });
      }
      setLoadedOnce(true);
    } catch {
      // Keep defaults; this must never block shell rendering.
      setLoadedOnce(true);
    }
  }, []);

  useEffect(() => {
    // Load once on mount; safe if route isn't wired yet.
    refresh();
  }, [refresh]);

  const setTimezone = useCallback((tz: string) => {
    const next = sanitizeTimezone(tz);
    if (!next) return;

    setPrefs((p) => {
      if (p.timezone === next) return p;
      return { ...p, timezone: next };
    });

    // Fire-and-forget persist.
    // Route should upsert into `user_preferences`.
    fetch("/api/user/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: next }),
    }).catch(() => {
      // ignore
    });
  }, []);

  const value = useMemo<UserPreferencesContextValue>(
    () => ({ prefs, setTimezone, refresh }),
    [prefs, setTimezone, refresh]
  );

  // If preferences are not loaded yet, we still render children with defaults.
  // `loadedOnce` is kept only for future UX (e.g., subtle loading indicator).
  void loadedOnce;

  return (
    <UserPreferencesContext.Provider value={value}>{children}</UserPreferencesContext.Provider>
  );
}

function UserSettingsOverlay(props: { open: boolean; onClose: () => void }) {
  const { open, onClose } = props;
  const { prefs, setTimezone } = useUserPreferences();

  const tzOptions = useMemo(
    () => [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "America/Phoenix",
      "America/Anchorage",
      "Pacific/Honolulu",
      "UTC",
    ],
    []
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative w-[520px] rounded-lg border border-neutral-800 bg-neutral-950 p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-neutral-100">User Settings</div>
            <div className="text-xs text-neutral-400">Time semantics overlay (client-side)</div>
          </div>
          <button
            type="button"
            className="rounded border border-neutral-800 px-2 py-1 text-[10px] text-neutral-300 hover:text-neutral-100"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-neutral-300">Timezone</label>
            <select
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-2 text-xs text-neutral-100"
              value={prefs.timezone}
              onChange={(e) => setTimezone(e.target.value)}
            >
              {tzOptions.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
            <div className="mt-1 text-[10px] text-neutral-500">
              Used to interpret 1h/4h/1D candle bucket semantics on the client.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// -------------------- Modal Manager (minimal v1) --------------------
type ModalType = "chart" | "analysisGrid" | "industryIntraday";

type ModalWindow = {
  id: string;
  type: ModalType;
  title: string;
  position: { x: number; y: number };
  size: { w: number; h: number };
  z: number;
  // `state` is intentionally loose for v1; typed payloads come with ChartModal/AnalysisGridModal.
  state?: any;
};

type ModalManager = {
  modals: ModalWindow[];
  openModal: (modal: Omit<ModalWindow, "z">) => void;
  closeModal: (id: string) => void;
  bringToFront: (id: string) => void;
  updateModal: (id: string, patch: Partial<Pick<ModalWindow, "position" | "size" | "title" | "state">>) => void;
};

const ModalManagerContext = createContext<ModalManager | null>(null);

export function useModalManager() {
  const ctx = useContext(ModalManagerContext);
  if (!ctx) throw new Error("useModalManager must be used within ModalManagerContext");
  return ctx;
}

function ModalHost() {
  const { modals, closeModal, bringToFront, updateModal } = useModalManager();

  const [interactionCount, setInteractionCount] = useState(0);
  const beginInteraction = useCallback(() => {
    setInteractionCount((n) => n + 1);
  }, []);
  const endInteraction = useCallback(() => {
    setInteractionCount((n) => Math.max(0, n - 1));
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 z-[1000]">
      {interactionCount > 0 ? (
        <div
          className="pointer-events-auto absolute inset-0 z-0 bg-transparent"
          aria-hidden="true"
        />
      ) : null}
      {modals.map((m) => (
        <DraggableWindow
          key={m.id}
          id={m.id}
          title={m.title}
          position={m.position}
          size={m.size}
          z={m.z}
          onClose={() => closeModal(m.id)}
          onFocus={() => bringToFront(m.id)}
          onMove={(pos) => updateModal(m.id, { position: pos })}
          onResize={(sz) => updateModal(m.id, { size: sz })}
          onInteractionStart={beginInteraction}
          onInteractionEnd={endInteraction}
        >
          {m.type === "chart" ? (
            <ChartModal modal={m} />
          ) : m.type === "analysisGrid" ? (
            <AnalysisGridModal modal={m} onPatch={(patch) => updateModal(m.id, patch)} />
          ) : m.type === "industryIntraday" ? (
            <IndustryIntradayModal modal={m} />
          ) : null}
        </DraggableWindow>
      ))}
    </div>
  );
}

function DraggableWindow(props: {
  id: string;
  title: string;
  position: { x: number; y: number };
  size: { w: number; h: number };
  z: number;
  onClose: () => void;
  onFocus: () => void;
  onMove: (pos: { x: number; y: number }) => void;
  onResize: (size: { w: number; h: number }) => void;
  onInteractionStart: () => void;
  onInteractionEnd: () => void;
  children: ReactNode;
}) {
  const {
    title,
    position,
    size,
    z,
    onClose,
    onFocus,
    onMove,
    onResize,
    onInteractionStart,
    onInteractionEnd,
    children,
  } = props;
  const interactionActiveRef = useRef(false);

  const startInteraction = useCallback(() => {
    if (interactionActiveRef.current) return;
    interactionActiveRef.current = true;
    onInteractionStart();
    try {
      document.body.style.userSelect = "none";
    } catch {
      // ignore
    }
  }, [onInteractionStart]);

  const stopInteraction = useCallback(() => {
    if (!interactionActiveRef.current) return;
    interactionActiveRef.current = false;
    onInteractionEnd();
    try {
      document.body.style.userSelect = "";
    } catch {
      // ignore
    }
  }, [onInteractionEnd]);

  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    dragging: boolean;
  } | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingPosRef = useRef<{ x: number; y: number } | null>(null);
  const lastSentPosRef = useRef<{ x: number; y: number } | null>(null);

  // --- Resize gesture refs and constants ---
  const resizeRef = useRef<{
    startX: number;
    startY: number;
    originW: number;
    originH: number;
    ratio: number;
    resizing: boolean;
  } | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const pendingSizeRef = useRef<{ w: number; h: number } | null>(null);
  const lastSentSizeRef = useRef<{ w: number; h: number } | null>(null);

  const MIN_W = 520;
  const MIN_H = 360;
  const MAX_W = 1600;
  const MAX_H = 1200;

  const onPointerDown = (e: React.PointerEvent) => {
    onFocus();
    e.preventDefault();

    // Do not initiate drag when interacting with controls inside the header.
    const target = e.target as HTMLElement | null;
    if (target && target.closest("button,a,input,textarea,select")) return;

    startInteraction();
    (e.currentTarget as any).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: position.x,
      originY: position.y,
      dragging: true,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d?.dragging) return;

    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    pendingPosRef.current = { x: d.originX + dx, y: d.originY + dy };

    if (rafRef.current != null) return;

    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const next = pendingPosRef.current;
      if (!next) return;

      const last = lastSentPosRef.current;
      if (last && last.x === next.x && last.y === next.y) return;

      lastSentPosRef.current = next;
      onMove(next);
    });
  };

  // --- Resize pointer handlers ---
  const onResizePointerDown = (e: React.PointerEvent) => {
    onFocus();
    e.preventDefault();
    e.stopPropagation();
    startInteraction();
    (e.currentTarget as any).setPointerCapture?.(e.pointerId);

    const ratio = size.w > 0 && size.h > 0 ? size.w / size.h : 1;
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originW: size.w,
      originH: size.h,
      ratio,
      resizing: true,
    };
  };

  const onResizePointerMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r?.resizing) return;

    const dx = e.clientX - r.startX;
    const dy = e.clientY - r.startY;

    // Choose the dominant axis so the gesture feels natural; then enforce aspect ratio.
    let nextW = r.originW + dx;
    let nextH = r.originH + dy;

    if (Math.abs(dx) >= Math.abs(dy)) {
      nextW = r.originW + dx;
      nextH = nextW / r.ratio;
    } else {
      nextH = r.originH + dy;
      nextW = nextH * r.ratio;
    }

    nextW = Math.max(MIN_W, Math.min(MAX_W, Math.round(nextW)));
    nextH = Math.max(MIN_H, Math.min(MAX_H, Math.round(nextH)));

    pendingSizeRef.current = { w: nextW, h: nextH };

    if (resizeRafRef.current != null) return;

    resizeRafRef.current = window.requestAnimationFrame(() => {
      resizeRafRef.current = null;
      const next = pendingSizeRef.current;
      if (!next) return;

      const last = lastSentSizeRef.current;
      if (last && last.w === next.w && last.h === next.h) return;

      lastSentSizeRef.current = next;
      onResize(next);
    });
  };

  const onResizePointerUp = () => {
    const r = resizeRef.current;
    if (r) r.resizing = false;

    if (resizeRafRef.current != null) {
      window.cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = null;
    }
    pendingSizeRef.current = null;
    stopInteraction();
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    if (d) d.dragging = false;

    if (rafRef.current != null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingPosRef.current = null;

    // Also end any resize gesture (in case pointerup bubbles from handle).
    onResizePointerUp();
    stopInteraction();
  };

  return (
    <div
      className="pointer-events-auto absolute flex flex-col rounded-md border border-neutral-800 bg-neutral-950 shadow-xl"
      style={{
        left: position.x,
        top: position.y,
        width: size.w,
        height: size.h,
        zIndex: z,
      }}
      onPointerDown={() => onFocus()}
    >
      <div
        className="flex h-10 touch-none select-none items-center justify-between border-b border-neutral-800 px-3"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="text-xs font-medium text-neutral-200">{title}</div>
        <button
          type="button"
          className="rounded border border-neutral-800 px-2 py-1 text-[10px] text-neutral-300 hover:text-neutral-100"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          Close
        </button>
      </div>
      <div className="flex min-h-0 flex-1">{children}</div>
      <div
        className="absolute bottom-1 right-1 z-[2000] h-4 w-4 touch-none cursor-se-resize rounded-sm border border-neutral-700 bg-neutral-900/60"
        title="Resize"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
      />
    </div>
  );
}

function ModalManagerProvider({ children }: { children: ReactNode }) {
  const [modals, setModals] = useState<ModalWindow[]>([]);

  const bringToFront = useCallback((id: string) => {
    setModals((prev) => {
      const maxZ = prev.reduce((m, w) => Math.max(m, w.z), 0);
      return prev.map((w) => (w.id === id ? { ...w, z: maxZ + 1 } : w));
    });
  }, []);

  const openModal = useCallback((modal: Omit<ModalWindow, "z">) => {
    setModals((prev) => {
      const maxZ = prev.reduce((m, w) => Math.max(m, w.z), 0);
      return [...prev, { ...modal, z: maxZ + 1 }];
    });
  }, []);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const ce = e as CustomEvent<Omit<ModalWindow, "z">>;
      const detail = ce.detail;
      if (!detail || typeof detail !== "object") return;
      openModal(detail);
    };

    window.addEventListener("tp:modal:open", onOpen as any);
    return () => window.removeEventListener("tp:modal:open", onOpen as any);
  }, [openModal]);

  // Listen for global Analysis Grid symbol add events.
  useEffect(() => {
    const onAddSymbols = (e: Event) => {
      const ce = e as CustomEvent<{ symbols?: unknown }>;
      const detail = ce.detail;
      const raw = (detail as any)?.symbols;
      if (!Array.isArray(raw)) return;

      const incoming = raw
        .filter((s) => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim().toUpperCase());

      if (incoming.length === 0) return;

      setModals((prev) => {
        // Try to find an existing analysis grid modal.
        const existing = prev.find((m) => m.type === "analysisGrid");

        const dedupeAppend = (current: any, add: string[]) => {
          const cur = Array.isArray(current) ? current : [];
          const seen = new Set(cur.map((x: any) => String(x).toUpperCase()));
          const next = [...cur];
          for (const s of add) {
            if (!seen.has(s)) {
              seen.add(s);
              next.push(s);
            }
          }
          return next;
        };

        if (existing) {
          const nextSymbols = dedupeAppend(existing.state?.symbols, incoming);
          const maxZ = prev.reduce((m, w) => Math.max(m, w.z), 0);
          return prev.map((m) =>
            m.id === existing.id
              ? {
                  ...m,
                  z: maxZ + 1,
                  state: {
                    ...(m.state ?? {}),
                    symbols: nextSymbols,
                    page: 0,
                    range: (m.state ?? {})?.range ?? "5D",
                    resolution: (m.state ?? {})?.resolution ?? "1h",
                    indicators: {
                      rsi: true,
                      macd: true,
                      sma50: !!(m.state ?? {})?.indicators?.sma50,
                      sma200: !!(m.state ?? {})?.indicators?.sma200,
                    },
                  },
                }
              : m
          );
        }

        // No existing grid modal: open a new one seeded with the incoming symbols.
        const id =
          (globalThis.crypto as any)?.randomUUID?.() ||
          `grid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const maxZ = prev.reduce((m, w) => Math.max(m, w.z), 0);
        const seeded = Array.from(new Set(incoming));

        return [
          ...prev,
          {
            id,
            type: "analysisGrid",
            title: "Pre-trade Grid",
            position: { x: 140, y: 140 },
            size: { w: 980, h: 700 },
            z: maxZ + 1,
            state: {
              symbols: seeded,
              page: 0,
              range: "5D",
              resolution: "1h",
              indicators: {
                rsi: true,
                macd: true,
                sma50: false,
                sma200: false,
              },
              source: "addSymbols",
            },
          } as ModalWindow,
        ];
      });
    };

    window.addEventListener("tp:analysisGrid:addSymbols", onAddSymbols as any);
    return () => window.removeEventListener("tp:analysisGrid:addSymbols", onAddSymbols as any);
  }, []);

  const closeModal = useCallback((id: string) => {
    setModals((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const updateModal = useCallback(
    (id: string, patch: Partial<Pick<ModalWindow, "position" | "size" | "title" | "state">>) => {
      setModals((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    },
    []
  );

  const value = useMemo<ModalManager>(
    () => ({ modals, openModal, closeModal, bringToFront, updateModal }),
    [modals, openModal, closeModal, bringToFront, updateModal]
  );

  return <ModalManagerContext.Provider value={value}>{children}</ModalManagerContext.Provider>;
}

export default function AppShell({ children }: { children: ReactNode }) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <UserPreferencesProvider>
      <ModalManagerProvider>
        <div className="min-h-screen">
          <header className="flex h-14 items-center justify-between border-b border-neutral-800 px-4">
          <div className="flex items-baseline gap-3">
            <div className="text-lg font-semibold tracking-tight">TraderPro</div>
            <div className="text-xs text-neutral-400">
              Analysis platform (no execution)
            </div>
          </div>

          <ProviderStatusIndicator />
          
          <nav className="flex items-center gap-3 text-xs text-neutral-300">
            <span className="rounded border border-neutral-800 px-2 py-1">
              Desktop Shell
            </span>

            <button
              type="button"
              className="rounded border border-neutral-800 px-2 py-1 text-[10px] text-neutral-300 hover:text-neutral-100"
              onClick={() => {
                const id =
                  (globalThis.crypto as any)?.randomUUID?.() ||
                  `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                window.dispatchEvent(
                  new CustomEvent("tp:modal:open", {
                    detail: {
                      id,
                      type: "chart",
                      title: "Dev Modal (stub)",
                      position: { x: 120, y: 120 },
                      size: { w: 720, h: 480 },
                      state: {
                        target: { kind: "SYMBOL", symbol: "QQQ" },
                        range: "1D",
                        resolution: "5m",
                        indicators: {
                          rsi: true,
                          macd: true,
                          sma50: false,
                          sma200: false,
                        },
                        source: "devButton",
                      },
                    },
                  })
                );
              }}
            >
              Dev Modal
            </button>

            <button
              type="button"
              className="rounded border border-neutral-800 px-2 py-1 text-[10px] text-neutral-300 hover:text-neutral-100"
              onClick={() => {
                const id =
                  (globalThis.crypto as any)?.randomUUID?.() ||
                  `grid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                window.dispatchEvent(
                  new CustomEvent("tp:modal:open", {
                    detail: {
                      id,
                      type: "analysisGrid",
                      title: "Pre-trade Grid",
                      position: { x: 140, y: 140 },
                      size: { w: 980, h: 700 },
                      state: {
                        symbols: [],
                        page: 0,
                        range: "5D",
                        resolution: "1h",
                        indicators: {
                          rsi: true,
                          macd: true,
                          sma50: false,
                          sma200: false,
                        },
                        source: "headerButton",
                      },
                    },
                  })
                );
              }}
            >
              Analysis Grid
            </button>

            <button
              type="button"
              className="rounded border border-neutral-800 px-2 py-1 text-[10px] text-neutral-300 hover:text-neutral-100"
              onClick={() => setSettingsOpen(true)}
            >
              Settings
            </button>

            <a className="text-neutral-400 underline" href="/api/health">
              health
            </a>
          </nav>
        </header>

        <ModalHost />
        <UserSettingsOverlay open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <main>{children}</main>
        </div>
      </ModalManagerProvider>
    </UserPreferencesProvider>
  );
}