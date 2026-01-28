import type { ChartTarget } from "@/components/state/chart-types";

export function canPromoteTarget(target: ChartTarget): target is { type: "SYMBOL"; symbol: string } {
  return target.type === "SYMBOL" && !!target.symbol && target.symbol !== "—";
}