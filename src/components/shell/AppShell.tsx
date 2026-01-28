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
import {
  seedCandlesClientCacheFromScheduler,
  type CandlesPayload,
} from "../hooks/useCandles";
import ChartModal from "../modals/ChartModal";
import AnalysisGridModal from "../modals/AnalysisGridModal";

// -------------------- Modal Manager (minimal v1) --------------------
type ModalType = "chart" | "analysisGrid";

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
        className="absolute bottom-1 right-1 h-4 w-4 touch-none cursor-se-resize rounded-sm border border-neutral-700 bg-neutral-900/60"
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
  // ---------------------------------------------
  // V1 single-user market data scheduler
  // - Day open: QQQ 6M/1D then QQQ 5D/1h (one per minute, first two minutes)
  // - After day open: 5-minute rotation
  //   - min 1: QQQ 1D/5m + held 1D/5m
  //   - min 2: Sentinel 1D/5m
  //   - min 3: Launch Leaders 1D/5m
  //   - min 4: High Velocity Multipliers 1D/5m
  //   - min 5: Slow Burners 1D/5m
  // - No other background warming; long ranges for individual symbols are on-demand from the primary chart.
  // ---------------------------------------------

  const minuteSlotRef = useRef<number>(0);
  const runningRef = useRef<boolean>(false);

  // Enforce: run the schedule at most once per wall-clock minute (guards refresh/visibility churn).
  const lastScheduleMinuteRef = useRef<number>(-1);

  // V1: market proxy symbol used by the schedule (Twelve Data does not support Yahoo-style index tickers like ^IXIC)
  const INDEX_SYMBOLS: string[] = ["QQQ"];

  const DEV_OWNER_USER_ID = process.env.NEXT_PUBLIC_DEV_OWNER_USER_ID;

  const WATCHLIST_ROTATION: Array<{ key: string; range: string; resolution: string }> = [
    { key: "SENTINEL", range: "1D", resolution: "5m" },
    { key: "LAUNCH_LEADERS", range: "1D", resolution: "5m" },
    { key: "HIGH_VELOCITY_MULTIPLIERS", range: "1D", resolution: "5m" },
    { key: "SLOW_BURNERS", range: "1D", resolution: "5m" },
  ];

  const HELD_1M_CAP = 15;
  const HELD_RANGE = "1D";
  const HELD_RESOLUTION = "5m";

  // Day-open warm (index only)
  const DAYOPEN_RANGE_1 = "6M";
  const DAYOPEN_RESOLUTION_1 = "1d";
  const DAYOPEN_RANGE_2 = "5D";
  const DAYOPEN_RESOLUTION_2 = "1h";

  const TICK_MS = 60_000;

  function buildUrl(params: Record<string, string>) {
    const usp = new URLSearchParams(params);
    return `/api/market/candles?${usp.toString()}`;
  }

  function buildSectorTickUrl(params: Record<string, string>) {
    const usp = new URLSearchParams(params);
    return `/api/scheduler/tick?${usp.toString()}`;
  }

  function claimScheduleMinute(): boolean {
    const minuteStamp = Math.floor(Date.now() / 60_000);
    if (lastScheduleMinuteRef.current === minuteStamp) return false;
    lastScheduleMinuteRef.current = minuteStamp;
    return true;
  }

  async function prewarmWatchlistComposite(watchlistKey: string, range: string, resolution: string) {
    const res = await fetch(
      buildUrl({
        target: "WATCHLIST_COMPOSITE",
        watchlistKey,
        range,
        resolution,
        scheduler: "1",
        ...(DEV_OWNER_USER_ID ? { ownerUserId: DEV_OWNER_USER_ID } : {}),
      }),
      { cache: "no-store" }
    );

    // Sector enrichment: run alongside the scheduled watchlist warm.
    // Scope: ONLY this watchlist; the server tick will only hydrate DB-null/expired sectors.
    if (DEV_OWNER_USER_ID) {
      try {
        void fetch(
          buildSectorTickUrl({
            ownerUserId: DEV_OWNER_USER_ID,
            watchlistKey,
            max: "5",
          }),
          { cache: "no-store" }
        );
      } catch {
        // ignore
      }
    }

    // Scheduler is resilient; ignore errors (server will enforce breaker/disable).
    // If we got a successful payload, seed the same client cache key that `useCandles()` uses,
    // so watchlist panels can hydrate without issuing their own refetch.
    try {
      const json = (await res.json()) as CandlesPayload;
      if (json && (json as any).ok !== false) {
        seedCandlesClientCacheFromScheduler(
          {
            target: "WATCHLIST_COMPOSITE",
            watchlistKey,
            range,
            resolution,
            ownerUserId: DEV_OWNER_USER_ID ?? null,
          },
          json,
          600_000
        );
      }
    } catch {
      // ignore
    }
  }

  async function prewarmSymbol(symbol: string, range: string, resolution: string) {
    const res = await fetch(
      buildUrl({
        target: "SYMBOL",
        symbol,
        range,
        resolution,
        scheduler: "1",
      }),
      { cache: "no-store" }
    );
    void res;
  }

  function shouldWarmStartToday(storageKey: string): boolean {
    try {
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const last = localStorage.getItem(storageKey);
      if (last === stamp) return false;
      localStorage.setItem(storageKey, stamp);
      return true;
    } catch {
      return false;
    }
  }

  function getHeldSymbols(): string[] {
    try {
      // 1) Optional window global (set by your app if/when available)
      const winAny = window as any;
      const fromWindow = winAny?.__TP_HELD_SYMBOLS__;
      if (Array.isArray(fromWindow)) {
        return Array.from(
          new Set(
            fromWindow
              .filter((s: any) => typeof s === "string" && s.trim().length > 0)
              .map((s: string) => s.trim().toUpperCase())
          )
        );
      }

      // 2) Optional localStorage (set by your app if/when available)
      const raw =
        localStorage.getItem("tp:heldSymbols:v1") ||
        localStorage.getItem("tp:heldSymbols");
      if (!raw) return [];

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      return Array.from(
        new Set(
          parsed
            .filter((s: any) => typeof s === "string" && s.trim().length > 0)
            .map((s: string) => s.trim().toUpperCase())
        )
      );
    } catch {
      return [];
    }
  }

  useEffect(() => {
    let stopped = false;

    const runTick = async () => {
      if (stopped) return;
      if (document.hidden) return;
      if (runningRef.current) return;

      runningRef.current = true;
      try {
        // Guard: execute at most once per wall-clock minute
        if (!claimScheduleMinute()) return;

        // Day-open warm (index only): minute 1 -> 6M/1D, minute 2 -> 5D/1h
        // Stored in localStorage so refresh does not restart day-open warm.
        const dayOpenKey = "tp:scheduler:dayopen:v1";
        const d = new Date();
        const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

        let dayOpenPhase = 0; // 0 = none, 1 = did 6M/1D, 2 = did 5D/1h
        try {
          const raw = localStorage.getItem(dayOpenKey);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed?.stamp === stamp && typeof parsed?.phase === "number") {
              dayOpenPhase = parsed.phase;
            }
          }
        } catch {
          // ignore
        }

        if (dayOpenPhase < 1) {
          // Minute 1: IXIC 6M/1D
          await prewarmSymbol(INDEX_SYMBOLS[0], DAYOPEN_RANGE_1, DAYOPEN_RESOLUTION_1);
          try {
            localStorage.setItem(dayOpenKey, JSON.stringify({ stamp, phase: 1 }));
          } catch {
            // ignore
          }
          return;
        }

        if (dayOpenPhase < 2) {
          // Minute 2: IXIC 5D/1h
          await prewarmSymbol(INDEX_SYMBOLS[0], DAYOPEN_RANGE_2, DAYOPEN_RESOLUTION_2);
          try {
            localStorage.setItem(dayOpenKey, JSON.stringify({ stamp, phase: 2 }));
          } catch {
            // ignore
          }
          return;
        }

        // After day-open: rotate minute slot 1..5
        minuteSlotRef.current = (minuteSlotRef.current % 5) + 1;
        const slot = minuteSlotRef.current;

        // min 1: IXIC 1D/5m + held 1D/5m
        if (slot === 1) {
          await prewarmSymbol(INDEX_SYMBOLS[0], "1D", "5m");

          const heldSymbols = getHeldSymbols();
          const heldBatch = heldSymbols.slice(0, HELD_1M_CAP);
          for (const sym of heldBatch) {
            await prewarmSymbol(sym, HELD_RANGE, HELD_RESOLUTION);
          }
          return;
        }

        // min 2..5: one watchlist composite 1D/5m
        const wl = WATCHLIST_ROTATION[slot - 2]; // slot 2..5 => index 0..3
          if (!wl) return;
          await prewarmWatchlistComposite(wl.key, wl.range, wl.resolution);
      } finally {
        runningRef.current = false;
      }
    };

    // Kick immediately, then every minute
    runTick();
    const id = window.setInterval(runTick, TICK_MS);

    const onVis = () => {
      if (!document.hidden) runTick();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      stopped = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <ModalManagerProvider>
      <div className="min-h-screen">
        <header className="flex h-14 items-center justify-between border-b border-neutral-800 px-4">
        <div className="flex items-baseline gap-3">
          <div className="text-lg font-semibold tracking-tight">TraderPro</div>
          <div className="text-xs text-neutral-400">
            Analysis platform (no execution)
          </div>
        </div>

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

          <a className="text-neutral-400 underline" href="/api/health">
            health
          </a>
        </nav>
      </header>

      <ModalHost />
      <main>{children}</main>
      </div>
    </ModalManagerProvider>
  );
}