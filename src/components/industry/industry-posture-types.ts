// src/components/industry/industry-posture-types.ts

export type RelToIndex = "OUTPERFORM" | "INLINE" | "UNDERPERFORM";
export type Trend5d = "UP" | "FLAT" | "DOWN";

export type IndustryPostureItem = {
  industryCode: string;
  industryAbbrev: string;

  // Aggregate posture metrics (wireframe placeholders for now)
  dayChangePct: number;
  volRel: number; // 0..1, where 0.5 is midpoint
  trend5d: Trend5d;
  relToIndex: RelToIndex;

  // Affordance only (no modal yet)
  hasNews?: boolean;

  // Optional: used later when clicking card to seed Analysis Grid
  symbols?: string[];
};