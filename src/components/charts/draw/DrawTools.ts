import type { ISeriesApi } from "lightweight-charts";

export type HorizontalLevel = {
  id: string;
  price: number;
  label?: string;
  color?: string;
  lineWidth?: number;
  lineStyle?: number;
  axisLabelVisible?: boolean;
};

const DEFAULTS = {
  color: "rgba(250,204,21,0.75)",
  lineWidth: 1,
  lineStyle: 0,
  axisLabelVisible: true,
};

export function upsertHorizontalLevels(
  candleSeries: ISeriesApi<"Candlestick">,
  levels: HorizontalLevel[],
  handlesById: Record<string, any>
) {
  if (!candleSeries) return;

  const keep = new Set(levels.map((l) => l.id));

  // Remove deleted
  for (const id of Object.keys(handlesById)) {
    if (!keep.has(id)) {
      try {
        candleSeries.removePriceLine?.(handlesById[id]);
      } catch {
        // ignore
      }
      delete handlesById[id];
    }
  }

  // Create / update
  for (const lvl of levels) {
    if (!lvl?.id) continue;
    if (!Number.isFinite(lvl.price)) continue;

    const existing = handlesById[lvl.id];

    const opts = {
      price: lvl.price,
      color: lvl.color ?? DEFAULTS.color,
      lineWidth: lvl.lineWidth ?? DEFAULTS.lineWidth,
      lineStyle: lvl.lineStyle ?? DEFAULTS.lineStyle,
      axisLabelVisible: lvl.axisLabelVisible ?? DEFAULTS.axisLabelVisible,
      title: lvl.label ?? "",
    };

    if (!existing) {
      try {
        const line = candleSeries.createPriceLine?.(opts as any);
        if (line) handlesById[lvl.id] = line;
      } catch {
        // ignore
      }
    } else {
      try {
        existing.applyOptions?.({ price: lvl.price, title: lvl.label ?? "" });
      } catch {
        // ignore
      }
    }
  }
}

export function clearHorizontalLevels(
  candleSeries: ISeriesApi<"Candlestick">,
  handlesById: Record<string, any>
) {
  if (!candleSeries) return;

  for (const id of Object.keys(handlesById)) {
    try {
      candleSeries.removePriceLine?.(handlesById[id]);
    } catch {
      // ignore
    }
    delete handlesById[id];
  }
}