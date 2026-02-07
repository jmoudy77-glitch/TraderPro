// src/components/industry/industry-posture-types.ts

export type RelToIndex = "OUTPERFORM" | "INLINE" | "UNDERPERFORM";
export type Trend5d = "UP" | "FLAT" | "DOWN";

export type IndustryPostureItem = {
  industryCode: string;
  industryAbbrev: string;

  // Aggregate posture metrics (card contract)
  // - Header uses 5D % change (pct5d)
  // - Body uses 10 trading-day daily series (rotation10d + volumes10d)
  dayChangePct: number;

  // Header summary (5 trading sessions cumulative, close-to-close)
  pct5d?: number;

  // Daily rotation memory (last 10 trading sessions)
  // One entry per day: raw daily % change (not relative-to-index)
  rotation10d?: number[];

  // Daily volumes aligned to rotation10d (one entry per day)
  volumes10d?: number[];

  volRel: number; // 0..1, where 0.5 is midpoint
  trend5d: Trend5d;
  relToIndex: RelToIndex;

  // Affordance only (no modal yet)
  hasNews?: boolean;

  // Optional: used later when clicking card to seed Analysis Grid
  symbols?: string[];
};