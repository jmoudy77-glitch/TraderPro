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