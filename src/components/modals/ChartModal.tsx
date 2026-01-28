import { useEffect, useState } from "react";
import { useChartState } from "@/components/state/ChartStateProvider";
import type { ChartKey } from "@/components/state/chart-keys";
import { ChartPanel } from "@/components/charts/PrimaryChartPanel";

type ChartModalProps = {
  modal: {
    id: string;
    title: string;
    state?: any;
  };
};

export default function ChartModal({ modal }: ChartModalProps) {
  const {
    allocateModalKey,
    releaseModalKey,
    setTarget,
    setRange,
    setResolution,
    setIndicators,
  } = useChartState();

  const [chartKey, setChartKey] = useState<ChartKey | null>(null);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    const key = allocateModalKey();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChartKey(key);
    setApplied(false);
    return () => {
      releaseModalKey(key);
    };
  }, [allocateModalKey, releaseModalKey]);

  useEffect(() => {
    // Support both shapes:
    //  - modal.state = { target, range, resolution, indicators }
    //  - modal.state = { state: { target, ... } } (nested)
    const s = (modal.state && (modal.state as any).state) ? (modal.state as any).state : modal.state;
    if (!s) return;
    if (!chartKey) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setApplied(false);

    // Normalize legacy payloads (target.kind) and current payloads (target.type)
    const t = (s as any).target;

    // Prefer current payload shape: { type: ... }
    if (t && typeof t === "object" && typeof (t as any).type === "string") {
      const type = String((t as any).type);
      if (type === "SYMBOL" && typeof (t as any).symbol === "string") {
        setTarget(chartKey, {
          type: "SYMBOL",
          symbol: String((t as any).symbol).toUpperCase(),
        } as any);
      } else {
        setTarget(chartKey, t as any);
      }
    } else if (t && typeof t === "object" && typeof (t as any).kind === "string") {
      // Legacy payload shape: { kind: ... }
      const kind = String((t as any).kind);
      if (kind === "SYMBOL" && typeof (t as any).symbol === "string") {
        setTarget(chartKey, {
          type: "SYMBOL",
          symbol: String((t as any).symbol).toUpperCase(),
        } as any);
      } else if (kind === "IXIC") {
        setTarget(chartKey, { type: "IXIC" } as any);
      } else {
        // Best-effort passthrough for other legacy kinds
        setTarget(chartKey, { type: kind } as any);
      }
    } else if (typeof modal.title === "string" && modal.title.trim()) {
      // Last-resort fallback: if no target was provided, treat the modal title as the symbol.
      setTarget(chartKey, {
        type: "SYMBOL",
        symbol: modal.title.trim().toUpperCase(),
      } as any);
    } else {
      // Ensure we never leave a reused modal key with a stale target.
      setTarget(chartKey, { type: "EMPTY" } as any);
    }

    if (typeof (s as any).range === "string") {
      setRange(chartKey, (s as any).range as any);
    }

    if (typeof (s as any).resolution === "string") {
      setResolution(chartKey, (s as any).resolution as any);
    }

    if ((s as any).indicators && typeof (s as any).indicators === "object") {
      setIndicators(chartKey, (s as any).indicators as any);
    }

    // Delay "applied" until the next animation frame so chart state updates land
    // before ChartPanel mounts (prevents stale/default targets from flashing).
    requestAnimationFrame(() => {
      setApplied(true);
    });
  }, [modal.state, modal.title, modal.id, chartKey, setTarget, setRange, setResolution, setIndicators]);

  return !chartKey || !applied ? (
    <div className="flex h-full w-full items-center justify-center text-xs text-neutral-400">
      Initializing chart...
    </div>
  ) : (
    <div className="h-full w-full p-2">
      <ChartPanel chartKey={chartKey} title={modal.title} />
    </div>
  );
}
