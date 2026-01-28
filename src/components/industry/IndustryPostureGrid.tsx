// src/components/industry/IndustryPostureGrid.tsx
"use client";

import type {
  IndustryPostureItem,
  RelToIndex,
  Trend5d,
} from "./industry-posture-types";

const WIREFRAME_ITEMS: IndustryPostureItem[] = [
  {
    industryCode: "SEMIS",
    industryAbbrev: "SEMIS",
    dayChangePct: 1.2,
    volRel: 0.78,
    trend5d: "UP",
    relToIndex: "OUTPERFORM",
    hasNews: true,
  },
  {
    industryCode: "AI",
    industryAbbrev: "AI",
    dayChangePct: 0.4,
    volRel: 0.55,
    trend5d: "UP",
    relToIndex: "INLINE",
    hasNews: false,
  },
  {
    industryCode: "CLOUD",
    industryAbbrev: "CLOUD",
    dayChangePct: -0.3,
    volRel: 0.42,
    trend5d: "FLAT",
    relToIndex: "UNDERPERFORM",
    hasNews: true,
  },
  {
    industryCode: "BIO",
    industryAbbrev: "BIO",
    dayChangePct: 0.1,
    volRel: 0.48,
    trend5d: "FLAT",
    relToIndex: "INLINE",
    hasNews: false,
  },
  {
    industryCode: "FIN",
    industryAbbrev: "FIN",
    dayChangePct: -0.6,
    volRel: 0.66,
    trend5d: "DOWN",
    relToIndex: "UNDERPERFORM",
    hasNews: false,
  },
  {
    industryCode: "NUKE",
    industryAbbrev: "NUKE",
    dayChangePct: 0.9,
    volRel: 0.73,
    trend5d: "UP",
    relToIndex: "OUTPERFORM",
    hasNews: true,
  },
  {
    industryCode: "QTM",
    industryAbbrev: "QTM",
    dayChangePct: -0.2,
    volRel: 0.35,
    trend5d: "DOWN",
    relToIndex: "UNDERPERFORM",
    hasNews: false,
  },
  {
    industryCode: "CRYPTO",
    industryAbbrev: "CRYPTO",
    dayChangePct: 2.4,
    volRel: 0.92,
    trend5d: "UP",
    relToIndex: "OUTPERFORM",
    hasNews: true,
  },
  {
    industryCode: "IND",
    industryAbbrev: "IND",
    dayChangePct: 0.0,
    volRel: 0.5,
    trend5d: "FLAT",
    relToIndex: "INLINE",
    hasNews: false,
  },
  {
    industryCode: "RE",
    industryAbbrev: "RE",
    dayChangePct: -0.1,
    volRel: 0.58,
    trend5d: "FLAT",
    relToIndex: "INLINE",
    hasNews: false,
  },
];

function selectItems(items: IndustryPostureItem[], limit: number) {
  // Phase 1 selection rules:
  // - Activity-first (volRel desc)
  // - Then magnitude (abs(dayChangePct) desc)
  // - Then stable tie-breakers
  return [...items]
    .sort((a, b) => {
      const vol = b.volRel - a.volRel;
      if (vol !== 0) return vol;

      const mag = Math.abs(b.dayChangePct) - Math.abs(a.dayChangePct);
      if (mag !== 0) return mag;

      const abbrev = a.industryAbbrev.localeCompare(b.industryAbbrev);
      if (abbrev !== 0) return abbrev;

      return a.industryCode.localeCompare(b.industryCode);
    })
    .slice(0, limit);
}

function borderClass(rel: RelToIndex) {
  // Border color reserved exclusively for vs-index semantics.
  if (rel === "OUTPERFORM") return "border-emerald-700";
  if (rel === "UNDERPERFORM") return "border-rose-700";
  return "border-neutral-800";
}

function TrendIcon({ trend }: { trend: Trend5d }) {
  const d =
    trend === "UP"
      ? "M6 14l4-4 4 4 4-6"
      : trend === "DOWN"
        ? "M6 10l4 4 4-4 4 6"
        : "M6 12h12";

  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-neutral-400"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

function VolumeScale({ volRel }: { volRel: number }) {
  // rail height: 44px, midpoint at 50%, dot position from volRel
  const clamped = Math.max(0, Math.min(1, volRel));
  const topPct = (1 - clamped) * 100;

  return (
    <div className="relative h-11 w-3">
      <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-neutral-700" />
      <div className="absolute left-1/2 top-1/2 h-px w-2 -translate-x-1/2 bg-neutral-500" />
      <div
        className="absolute left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-neutral-200"
        style={{ top: `${topPct}%`, transform: "translate(-50%, -50%)" }}
      />
    </div>
  );
}

function NewsIcon({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={[
        "inline-flex h-6 w-6 items-center justify-center rounded-md border bg-neutral-900",
        enabled
          ? "border-neutral-800 text-neutral-300"
          : "border-neutral-900 text-neutral-600",
      ].join(" ")}
      title={enabled ? "Industry news" : "No news"}
      aria-label={enabled ? "Industry news" : "No news"}
    >
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 5h16v14H4z" />
        <path d="M8 9h8" />
        <path d="M8 13h8" />
        <path d="M8 17h5" />
      </svg>
    </span>
  );
}

function Card({ item }: { item: IndustryPostureItem }) {
  const pct = item.dayChangePct;
  const pctStr = `${pct >= 0 ? "+" : ""}${pct.toFixed(Math.abs(pct) >= 1 ? 1 : 2)}%`;

  return (
    <div
      className={[
        "flex h-full flex-col overflow-hidden rounded-md border bg-neutral-950",
        borderClass(item.relToIndex),
      ].join(" ")}
    >
      <div className="flex items-center justify-between border-b border-neutral-800 px-2 py-1">
        <div className="text-[11px] font-medium text-neutral-200">
          {item.industryAbbrev}
        </div>
        <div className="flex items-center gap-2">
          <TrendIcon trend={item.trend5d} />
          <NewsIcon enabled={!!item.hasNews} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-between gap-2 px-2 py-2">
        <VolumeScale volRel={item.volRel} />

        <div className="min-w-0 flex-1">
          <div
            className={[
              "text-sm font-semibold tabular-nums",
              pct >= 0 ? "text-emerald-300" : "text-rose-300",
            ].join(" ")}
          >
            {pctStr}
          </div>
          <div className="mt-0.5 text-[10px] text-neutral-500">
            vol • % • 5d • vs idx
          </div>
        </div>
      </div>
    </div>
  );
}

export default function IndustryPostureGrid() {
  const items = selectItems(WIREFRAME_ITEMS, 10);

  return (
    <section className="flex flex-none flex-col rounded-lg border border-neutral-800 bg-neutral-950">
      <div className="border-b border-neutral-800 px-3 py-2 text-sm font-medium">
        Industry Posture
      </div>

      <div className="p-3">
        <div className="grid grid-cols-5 grid-rows-2 gap-px rounded-md bg-neutral-800 p-px">
          {items.map((item) => (
            <Card key={item.industryCode} item={item} />
          ))}
        </div>
      </div>
    </section>
  );
}