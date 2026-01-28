import React, { memo, useMemo } from "react";

type Sparkline1DProps = {
  points: number[];           // price samples across 1D range
  baseline?: number | null;   // previous trading day close (price)
  width?: number;             // px
  height?: number;            // px
  positive?: boolean;         // optional override (otherwise derived from points vs baseline/first)
  className?: string;
};

function buildSpark(points: number[], width: number, height: number, baseline?: number | null) {
  const padX = 1;
  const padY = 2;

  if (!points || points.length < 2) {
    const mid = Math.round(height / 2);
    return { polyline: `0,${mid} ${width},${mid}`, baselineY: mid };
  }

  const midY = height / 2;

  // If baseline provided, scale symmetrically around it so baseline sits at midline.
  if (typeof baseline === "number" && Number.isFinite(baseline)) {
    const maxAbs = Math.max(...points.map((p) => Math.abs(p - baseline)));

    // Flat / no movement
    if (!Number.isFinite(maxAbs) || maxAbs === 0) {
      const y = Math.round(midY);
      return { polyline: `0,${y} ${width},${y}`, baselineY: y };
    }

    const xStep = (width - 1 - padX * 2) / (points.length - 1);
    const amp = midY - padY; // available half-height

    const polyline = points
      .map((p, i) => {
        const t = (p - baseline) / maxAbs; // -1..1
        const x = padX + i * xStep;
        const y = midY - t * amp; // above baseline => smaller y
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");

    return { polyline, baselineY: midY };
  }

  // Fallback: min/max scaling (baseline still drawn midline, but not “price-based”)
  const minP = Math.min(...points);
  const maxP = Math.max(...points);

  if (!isFinite(minP) || !isFinite(maxP) || maxP === minP) {
    const y = Math.round(midY);
    return { polyline: `0,${y} ${width},${y}`, baselineY: y };
  }

  const xStep = (width - 1 - padX * 2) / (points.length - 1);

  const polyline = points
    .map((p, i) => {
      const t = (p - minP) / (maxP - minP); // 0..1
      const x = padX + i * xStep;
      const y = padY + (1 - t) * (height - padY * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return { polyline, baselineY: midY };
}

export const Sparkline1D = memo(function Sparkline1D({
  points,
  baseline,
  width = 92,
  height = 28,
  positive,
  className,
}: Sparkline1DProps) {
  const isPositive =
    typeof positive === "boolean"
      ? positive
      : typeof baseline === "number" && Number.isFinite(baseline)
        ? points.length >= 1
          ? points[points.length - 1] >= baseline
          : true
        : points.length >= 2
          ? points[points.length - 1] >= points[0]
          : true;

  const { polyline, baselineY } = useMemo(
    () => buildSpark(points, width, height, baseline),
    [points, width, height, baseline]
  );

  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="1D sparkline"
    >
      <line
        x1="0"
        y1={baselineY}
        x2={width}
        y2={baselineY}
        stroke="currentColor"
        opacity="0.48"
        strokeWidth="2"
        shapeRendering="crispEdges"
      />

      <polyline
        fill="none"
        points={polyline}
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ opacity: 0.95 }}
        className={isPositive ? "text-emerald-500" : "text-orange-500"}
      />
    </svg>
  );
});