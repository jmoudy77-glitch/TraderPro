"use client";

import type { ChartResolution, ChartTimeRange } from "@/components/state/chart-types";

const RANGES: ChartTimeRange[] = ["1D", "5D", "1M", "3M", "6M", "1Y"];
const RESOLUTIONS: ChartResolution[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

function SegButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded-md border px-2 py-1 text-[11px]",
        active
          ? "border-neutral-600 bg-neutral-800 text-neutral-100"
          : "border-neutral-800 bg-neutral-950 text-neutral-400 hover:text-neutral-200",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export default function ChartControls({
  range,
  resolution,
  onRange,
  onResolution,
}: {
  range: ChartTimeRange;
  resolution: ChartResolution;
  onRange: (r: ChartTimeRange) => void;
  onResolution: (r: ChartResolution) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        {RANGES.map((r) => (
          <SegButton key={r} active={r === range} onClick={() => onRange(r)}>
            {r}
          </SegButton>
        ))}
      </div>

      <div className="mx-1 h-4 w-px bg-neutral-800" />

      <div className="flex items-center gap-1">
        {RESOLUTIONS.map((res) => (
          <SegButton
            key={res}
            active={res === resolution}
            onClick={() => onResolution(res)}
          >
            {res}
          </SegButton>
        ))}
      </div>
    </div>
  );
}