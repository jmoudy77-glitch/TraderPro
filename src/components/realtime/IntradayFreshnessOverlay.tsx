"use client";

export default function IntradayFreshnessOverlay({
  meta,
  candlesCount,
}: {
  meta: any | null;
  candlesCount: number;
}) {
  // ok=false envelope is renderable truth
  if (meta?.ok === false) {
    return (
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        <div className="rounded-md border border-neutral-800 bg-neutral-950/80 px-2 py-1 text-[11px] text-neutral-200">
          upstream:{String(meta?.error?.upstream ?? "fly")} •{" "}
          {String(meta?.error?.code ?? "ERROR")}
        </div>
      </div>
    );
  }

  if (!meta) return null;

  const isStale = !!meta.is_stale;
  const cacheStatus = meta.cache_status ?? "";
  const lastUpdate = meta.last_update_ts ?? null;
  const isEmpty = candlesCount === 0;

  // Only show overlay for stale OR empty
  if (!isStale && !isEmpty) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-start justify-end p-2">
      <div className="rounded-md border border-neutral-800 bg-neutral-950/80 px-2 py-1 text-[11px] text-neutral-200">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{isStale ? "stale" : "fresh"}</span>
          {cacheStatus ? (
            <span className="text-neutral-400">cache:{String(cacheStatus)}</span>
          ) : null}
        </div>
        <div className="text-neutral-400">lastUpdate:{String(lastUpdate)}</div>
        {isEmpty ? <div className="text-neutral-400">candles:0</div> : null}
      </div>
    </div>
  );
}