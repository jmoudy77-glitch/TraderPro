"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type {
  IndustryPostureItem,
  RelToIndex,
  Trend5d,
} from "./industry-posture-types";

import { useModalManager } from "../shell/AppShell";

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

type PressureDir = "UP" | "DOWN" | "FLAT";

type IndustryPressure = {
  dir: PressureDir;
  mag: number; // 0..1
  symbolsOk: number;
  symbolsTotal: number;
};

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function normalizeItems(input: any): IndustryPostureItem[] {
  const arr: any[] = Array.isArray(input)
    ? input
    : Array.isArray(input?.items)
      ? input.items
      : [];

  return (arr ?? [])
    .filter(Boolean)
    .map((x: any): IndustryPostureItem => ({
      industryCode: String(x.industryCode ?? "").trim(),
      industryAbbrev: String(x.industryAbbrev ?? x.industryCode ?? "").trim(),
      dayChangePct: Number(x.dayChangePct ?? 0),
      // New posture card contract fields
      pct5d: Number.isFinite(Number(x.pct5d)) ? Number(x.pct5d) : undefined,
      rotation10d:
        Array.isArray(x.rotation10d) && x.rotation10d.length >= 10
          ? x.rotation10d
              .slice(-10)
              .map((v: any) => Number(v))
              .map((v: number) => (Number.isFinite(v) ? v : 0))
          : undefined,
      volumes10d:
        Array.isArray(x.volumes10d) && x.volumes10d.length >= 10
          ? x.volumes10d
              .slice(-10)
              .map((v: any) => Number(v))
              .map((v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0))
          : undefined,
      volRel: Number(x.volRel ?? 0.5),
      trend5d:
        x.trend5d === "UP" || x.trend5d === "DOWN" || x.trend5d === "FLAT"
          ? x.trend5d
          : "FLAT",
      relToIndex:
        x.relToIndex === "OUTPERFORM" ||
        x.relToIndex === "UNDERPERFORM" ||
        x.relToIndex === "INLINE"
          ? x.relToIndex
          : "INLINE",
      hasNews: !!x.hasNews,
      symbols: Array.isArray(x.symbols)
        ? x.symbols
            .map((s: any) => String(s ?? "").trim().toUpperCase())
            .filter(Boolean)
        : undefined,
    }))
    .filter((x: IndustryPostureItem) => !!x.industryCode);
}

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

function fmtPct(pct: number) {
  const n = Number(pct);
  const v = Number.isFinite(n) ? n : 0;
  const digits = Math.abs(v) >= 1 ? 1 : 2;
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function getRotation10d(item: any): number[] | null {
  const arr = item?.rotation10d;
  if (Array.isArray(arr) && arr.length >= 10) {
    const out = arr
      .slice(-10)
      .map((x: any) => Number(x))
      .map((v: number) => (Number.isFinite(v) ? v : 0));
    return out;
  }
  return null;
}

function getVolumes10d(item: any): number[] | null {
  const arr = item?.volumes10d;
  if (Array.isArray(arr) && arr.length >= 10) {
    const out = arr
      .slice(-10)
      .map((x: any) => Number(x))
      .map((v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0));
    return out;
  }
  return null;
}

function percentile(values: number[], p: number) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return 1;
  const idx = Math.max(0, Math.min(xs.length - 1, Math.floor((p / 100) * (xs.length - 1))));
  return xs[idx] || 1;
}

function volumeHeightsNormalized(vols: number[]) {
  const vHi = Math.max(1e-9, percentile(vols, 90));
  return vols.map((v) => clamp01(v / vHi));
}

function RotationStrip({ values }: { values: number[] | null }) {
  // values are daily % change for last 10 sessions.
  // No gaps; use inner borders for separation.
  const clampMag = (pct: number) => clamp01(Math.min(1, Math.abs(pct) / 2.5)); // clamp around 2.5% daily

  const xs = Array.isArray(values) ? values.slice(-10) : null;

  return (
    <div
      className="flex h-3 w-full overflow-hidden rounded-sm bg-neutral-950"
      title={xs ? "10D daily rotation" : "No daily coverage yet"}
    >
      {(xs ?? new Array(10).fill(0)).map((pct, idx) => {
        const isPlaceholder = xs == null;
        const mag = isPlaceholder ? 0 : clampMag(pct);
        const isUp = pct >= 0;
        const color = isUp ? "rgba(52,211,153," : "rgba(251,113,133,";
        const opacity = isPlaceholder ? 0.18 : 0.18 + 0.62 * mag;

        return (
          <div
            key={idx}
            className={["flex-1", idx === 0 ? "" : "border-l border-neutral-800"].join(" ")}
            style={{ backgroundColor: isPlaceholder ? `rgba(115,115,115,${opacity})` : `${color}${opacity})` }}
            title={isPlaceholder ? "No daily coverage yet" : `D-${9 - idx}: ${fmtPct(pct)}`}
          />
        );
      })}
    </div>
  );
}

function VolumeLane({ volumes }: { volumes: number[] | null }) {
  // Lane height is provided by the parent (flex-1). Bars fill a % of that lane.
  const minPx = 3;

  const xs = Array.isArray(volumes) ? volumes.slice(-10) : null;
  const hs = xs ? volumeHeightsNormalized(xs) : new Array(10).fill(0);

  return (
    <div
      className="flex h-full w-full items-end"
      title={xs ? "10D daily volume" : "No daily coverage yet"}
    >
      {hs.map((h, idx) => {
        const isPlaceholder = xs == null;
        const FILL = 0.85;

        // Height as % of the available lane height (parent-controlled),
        // with a small minHeight so tiny bars still show.
        const barPct = isPlaceholder ? 0 : clamp01(h) * FILL * 100;

        return (
          <div
            key={idx}
            className={[
              "flex-1 h-full flex items-end",
              idx === 0 ? "" : "border-l border-neutral-950",
            ].join(" ")}
          >
            <div
              className={
                isPlaceholder
                  ? "mx-auto rounded-sm bg-neutral-500/40"
                  : "mx-auto rounded-sm bg-neutral-300/70"
              }
              style={{
                width: "60%",
                height: isPlaceholder ? `${minPx}px` : `${barPct}%`,
                minHeight: `${minPx}px`,
              }}
              title={isPlaceholder ? "No daily coverage yet" : `Vol (norm): ${Math.round(h * 100)}%`}
            />
          </div>
        );
      })}
    </div>
  );
}

function NewsChip({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]",
        enabled
          ? "border-neutral-700 bg-neutral-900 text-neutral-200"
          : "border-neutral-900 bg-neutral-950 text-neutral-600",
      ].join(" ")}
      title={enabled ? "Industry intel" : "No intel"}
      aria-label={enabled ? "Industry intel" : "No intel"}
    >
      <svg
        viewBox="0 0 24 24"
        width="12"
        height="12"
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
      </svg>
      <span>Intel</span>
    </span>
  );
}

function PressureBar({ pressure }: { pressure?: IndustryPressure }) {
  if (!pressure) return null;

  const mag = clamp01(pressure.mag);
  const dir = pressure.dir;
  const halfPct = 50;
  const h = mag * halfPct;

  const hasCoverage = pressure.symbolsTotal > 0;
  const coverage = hasCoverage
    ? clamp01(pressure.symbolsOk / pressure.symbolsTotal)
    : 0;

  // Fade slightly if partial coverage.
  const opacity = coverage >= 0.999 ? 1 : 0.35 + 0.65 * coverage;

  const fillClass =
    dir === "UP"
      ? "bg-emerald-400"
      : dir === "DOWN"
        ? "bg-rose-400"
        : "bg-neutral-500";

  // Deadband: FLAT means no fill.
  const showFill = dir !== "FLAT" && mag > 0;

  const top = dir === "UP" ? `${halfPct - h}%` : `${halfPct}%`;
  const height = `${h}%`;

  return (
    <div
      className="pointer-events-none absolute inset-y-0 left-[2px] z-20 w-[9px]"
      style={{ opacity }}
      aria-hidden="true"
      title={`Intraday pressure: ${dir} (${Math.round(mag * 100)}%), coverage ${pressure.symbolsOk}/${pressure.symbolsTotal}`}
    >
      {/* Always-visible pressure lane + rail + center marker (even when FLAT/0). */}
      <div className="absolute inset-y-0 left-0 w-full bg-neutral-950/35" />
      <div className="absolute inset-y-0 left-[3px] w-[3px] bg-neutral-200/90 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" />
      <div className="absolute left-0 top-1/2 h-[2px] w-full -translate-y-1/2 bg-neutral-200/85" />
      <div className="absolute left-0 top-1/2 h-2 w-full -translate-y-1/2 bg-neutral-200/15" />
      {/* Fill track background (neutral) */}
      <div
        className="absolute left-[2px] top-0 h-full rounded-sm bg-neutral-800/60"
        style={{ width: "6px" }}
      />
      {showFill ? (
        <div
          className={`absolute left-[2px] rounded-sm ${fillClass}`}
          style={{ top, height, width: "6px" }}
        />
      ) : null}
    </div>
  );
}

function Card({
  item,
  onClick,
  pressure,
}: {
  item: IndustryPostureItem;
  onClick: () => void;
  pressure?: IndustryPressure;
}) {
  const rotation10d = getRotation10d(item);
  const volumes10d = getVolumes10d(item);

  // Prefer API-provided pct5d if present; otherwise fall back to dayChangePct until the route is upgraded.
  const pct5d = Number(item.pct5d ?? item.dayChangePct ?? 0);
  const pct5dStr = fmtPct(pct5d);

  return (
    <div
      className={[
        "relative flex h-full flex-col overflow-hidden rounded-md border bg-neutral-950",
        "cursor-pointer select-none hover:brightness-110",
        borderClass(item.relToIndex),
      ].join(" ")}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
    >
      <PressureBar pressure={pressure} />
      <div className="flex items-center justify-between border-b border-neutral-800 pl-4 pr-2 py-1">
        <div className="text-[11px] font-medium text-neutral-200">
          {item.industryAbbrev}
        </div>
        <div className="flex items-center gap-2">
          <div
            className={[
              "text-[11px] font-semibold tabular-nums",
              pct5d >= 0 ? "text-emerald-300" : "text-rose-300",
            ].join(" ")}
            title="5D % change"
          >
            {pct5dStr}
          </div>
          <NewsChip enabled={!!item.hasNews} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 pl-4 pr-2 py-2">
        {/* Body lane: provide a horizontal gutter to the right of the pressure rail via pl-4. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Segmented rotation bar (10D) */}
          <RotationStrip values={rotation10d} />

          {/* Small padding between segment strip and volume lane */}
          <div className="h-1" />

          {/* Volume lane fills remaining space below segments */}
          <div className="flex-1 min-h-0">
            <VolumeLane volumes={volumes10d} />
          </div>
        </div>
      </div>
    </div>
  );
}


export default function IndustryPostureGrid() {
  const { openModal } = useModalManager();

  const [itemsRaw, setItemsRaw] = useState<IndustryPostureItem[] | null>(null);
  const [pressureByIndustry, setPressureByIndustry] = useState<
    Record<string, IndustryPressure>
  >({});

  const pressureReqSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/market/industry-posture", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP_${res.status}`);
        const json = await res.json();
        const next = normalizeItems(json);
        if (!cancelled) setItemsRaw(next.length ? next : []);
      } catch {
        if (!cancelled) setItemsRaw(null);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  const sourceItems = useMemo<IndustryPostureItem[]>(() => {
    if (itemsRaw === null) return WIREFRAME_ITEMS;
    return itemsRaw.length ? itemsRaw : WIREFRAME_ITEMS;
  }, [itemsRaw]);

  const items = useMemo(() => selectItems(sourceItems, 10), [sourceItems]);


  useEffect(() => {
    let cancelled = false;
    const industries = items
      .map((it) => ({
        industryCode: it.industryCode,
        symbols: (it.symbols ?? []).filter(Boolean),
      }))
      .filter((x) => x.industryCode && x.symbols.length > 0);

    if (!industries.length) {
      setPressureByIndustry({});
      return;
    }

    async function fetchPressureOnce() {
      const seq = ++pressureReqSeq.current;
      try {
        const res = await fetch("/api/realtime/industry-pressure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ res: "5m", industries }),
        });

        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        if (seq !== pressureReqSeq.current) return;
        if (!json?.ok || !json?.byIndustry) return;

        type PressurePayload = {
          dir?: PressureDir;
          mag?: number;
          symbolsOk?: number;
          symbolsTotal?: number;
        };

        const rawByIndustry = json.byIndustry as unknown;
        if (!rawByIndustry || typeof rawByIndustry !== "object") return;

        const byIndustry = rawByIndustry as Record<string, PressurePayload>;

        const next: Record<string, IndustryPressure> = {};
        for (const industryCode of Object.keys(byIndustry)) {
          const v = byIndustry[industryCode];

          const dir: PressureDir =
            v?.dir === "UP" || v?.dir === "DOWN" || v?.dir === "FLAT"
              ? v.dir
              : "FLAT";

          const mag = clamp01(Number(v?.mag ?? 0));
          const symbolsOk = Number(v?.symbolsOk ?? 0);
          const symbolsTotal = Number(v?.symbolsTotal ?? 0);

          next[industryCode] = {
            dir,
            mag,
            symbolsOk: Number.isFinite(symbolsOk) ? symbolsOk : 0,
            symbolsTotal: Number.isFinite(symbolsTotal) ? symbolsTotal : 0,
          };
        }

        setPressureByIndustry(next);
      } catch {
        // Silent fail: pressure is optional and should not create churn.
      }
    }

    fetchPressureOnce();
    const t = window.setInterval(fetchPressureOnce, 30_000);

    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [items]);


  return (
    <section className="flex flex-none flex-col rounded-lg border border-neutral-800 bg-neutral-950 h-[340px]">
      <div className="border-b border-neutral-800 px-3 py-2 text-sm font-medium">
        Industry Posture
      </div>

      <div className="p-3 h-full">
        <div className="grid h-full grid-cols-5 grid-rows-2 gap-px rounded-md bg-neutral-800 p-px">
          {items.map((item) => (
            <Card
              key={item.industryCode}
              item={item}
              pressure={pressureByIndustry[item.industryCode]}
              onClick={() => {
                openModal({
                  id: `industryIntraday:${item.industryCode}:${Date.now()}`,
                  type: "industryIntraday",
                  title: `${item.industryAbbrev} — Intraday`,
                  position: { x: 160, y: 120 },
                  size: { w: 980, h: 620 },
                  state: {
                    industryCode: item.industryCode,
                    industryAbbrev: item.industryAbbrev,
                    relToIndex: item.relToIndex,
                    trend5d: item.trend5d,
                    symbols: item.symbols ?? [],
                  },
                });
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}