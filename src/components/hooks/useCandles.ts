"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChartInstanceState } from "@/components/state/chart-types";

import type {
  CanonicalCandle,
  CandlesWindowMeta,
  CandlesWindowOkResponse,
  CandlesWindowErrorResponse,
  CandlesWindowResponse,
} from "@/lib/market-data/candles/types";




type UseCandlesResult = {
  // Phase 6: truth-preserving candle array (shape depends on contract surface)
  candles: CanonicalCandle[];
  // Number of candles that correspond to the requested range at the requested resolution.
  // The server may return additional lookback candles for indicators.
  visibleCount: number | null;
  meta: CandlesWindowMeta | CandlesWindowErrorResponse | null;
  loading: boolean;
  error: string | null;
};

const OWNER_USER_ID = process.env.NEXT_PUBLIC_DEV_OWNER_USER_ID ?? null;

// Client-side protection against accidental request storms.
// - In-memory TTL cache prevents re-renders from re-fetching the same payload.
// - A minimum fetch interval prevents rapid UI churn from burning provider credits.
// NOTE: This is per-browser-tab (in-memory). Server-side caching still applies separately.

export type CandlesPayload = CandlesWindowOkResponse | CandlesWindowErrorResponse;

type ClientCacheEntry = { expiresAt: number; payload: CandlesPayload };
const CLIENT_CACHE = new Map<string, ClientCacheEntry>();

function clientCacheGet(key: string): CandlesPayload | null {
  const hit = CLIENT_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    CLIENT_CACHE.delete(key);
    return null;
  }
  return hit.payload;
}

function clientCacheSet(key: string, payload: CandlesPayload, ttlMs: number) {
  CLIENT_CACHE.set(key, { payload, expiresAt: Date.now() + ttlMs });
}

export const TP_CANDLES_CACHE_SEEDED_EVENT = "tp:candles-cache-seeded";

export function notifyCandlesCacheSeeded(requestKey: string) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent(TP_CANDLES_CACHE_SEEDED_EVENT, {
        detail: { requestKey },
      })
    );
  } catch {
    // ignore
  }
}

export type CandlesCacheSeedInput = {
  target: "SYMBOL" | "IXIC" | "WATCHLIST_COMPOSITE";
  symbol?: string;
  watchlistKey?: string;
  range: string;
  // Canonical name (matches /api/market/candles/window)
  res: string;
  // Back-compat (older schedulers)
  resolution?: string;
  // Optional explicit ownerUserId for cases where the env var is not present.
  ownerUserId?: string | null;
};

// Builds the same requestKey format that `useCandles()` uses so external schedulers
// can seed the in-memory client cache and allow watchlists to hydrate without refetching.
export function buildCandlesRequestKeyFromSeed(input: CandlesCacheSeedInput): string {
  let tKey = "UNKNOWN";
  if (input.target === "SYMBOL") tKey = `SYMBOL:${input.symbol ?? ""}`;
  if (input.target === "IXIC") tKey = "SYMBOL:QQQ"; // legacy alias
  if (input.target === "WATCHLIST_COMPOSITE") tKey = `WATCHLIST_COMPOSITE:${input.watchlistKey ?? ""}`;

  const ownerKey =
    input.target === "WATCHLIST_COMPOSITE" ? (OWNER_USER_ID ?? input.ownerUserId ?? "") : "";

  const r = input.res ?? input.resolution ?? "";
  return `${tKey}|${input.range}|${r}|${ownerKey}`;
}

export function seedCandlesClientCacheFromScheduler(
  input: CandlesCacheSeedInput,
  payload: CandlesPayload,
  ttlMs: number = 30_000
): string {
  const key = buildCandlesRequestKeyFromSeed(input);
  clientCacheSet(key, payload, ttlMs);
  notifyCandlesCacheSeeded(key);
  return key;
}

function stableTargetKey(instance: ChartInstanceState): string {
  const t = instance.target;
  if (t.type === "SYMBOL") return `SYMBOL:${t.symbol}`;
  if (t.type === "IXIC") return `SYMBOL:QQQ`; // legacy alias
  if (t.type === "WATCHLIST_COMPOSITE") return `WATCHLIST_COMPOSITE:${t.watchlistKey}`;
  return String((t as any).type ?? "UNKNOWN");
}

export function useCandles(instance: ChartInstanceState): UseCandlesResult {
  const [candles, setCandles] = useState<CanonicalCandle[]>([]);
  const [visibleCount, setVisibleCount] = useState<number | null>(null);
  const [meta, setMeta] = useState<CandlesWindowMeta | CandlesWindowErrorResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tKey = stableTargetKey(instance);
  // OWNER_USER_ID matters for WATCHLIST_COMPOSITE only.
  const ownerKey =
    instance.target.type === "WATCHLIST_COMPOSITE" ? (OWNER_USER_ID ?? "") : "";

  const requestKey = useMemo(() => {
    return `${tKey}|${instance.range}|${instance.resolution}|${ownerKey}`;
  }, [tKey, instance.range, instance.resolution, ownerKey]);

  useEffect(() => {
    // When the scheduler seeds the client cache, notify matching chart instances to hydrate.
    if (typeof window === "undefined") return;

    const onSeeded = (e: Event) => {
      const seededKey = (e as any)?.detail?.requestKey as string | undefined;
      if (!seededKey || seededKey !== requestKey) return;

      const cached = clientCacheGet(requestKey);
      if (!cached) return;

      if ((cached as CandlesWindowOkResponse).ok === true) {
        setCandles((cached as CandlesWindowOkResponse).candles ?? []);
        setVisibleCount((cached as CandlesWindowOkResponse).meta?.expectedBars ?? null);
        setMeta((cached as CandlesWindowOkResponse).meta ?? null);
      } else {
        setCandles([]);
        setVisibleCount(null);
        setMeta(cached as CandlesWindowErrorResponse);
      }
      setError(null);
      setLoading(false);
    };

    window.addEventListener(TP_CANDLES_CACHE_SEEDED_EVENT, onSeeded as any);
    return () => {
      window.removeEventListener(TP_CANDLES_CACHE_SEEDED_EVENT, onSeeded as any);
    };
  }, [requestKey]);

  // Track last fetch time per requestKey to prevent hammering on rapid UI churn.
  const lastFetchAtRef = useRef<Record<string, number>>({});
  // For CACHE_MISS (soft miss), respect server-provided retry timing without poisoning the client cache.
  const nextAllowedAtRef = useRef<Record<string, number>>({});

  // Defaults tuned to protect external credits.
  const MIN_FETCH_INTERVAL_MS = 30_000;
  const CLIENT_CACHE_TTL_MS = 30_000;

  useEffect(() => {
    let cancelled = false;

    async function fetchCandles() {
      try {
        // EMPTY targets are inert and must never hit the market API.
        if (instance.target.type === "EMPTY") {
          setCandles([]);
          setVisibleCount(null);
          setMeta(null);
          setLoading(false);
          setError(null);
          return;
        }

        // Serve from client cache when available (prevents re-render storms from refetching).
        const cached = clientCacheGet(requestKey);
        if (cached) {
          if ((cached as CandlesWindowOkResponse).ok === true) {
            setCandles((cached as CandlesWindowOkResponse).candles ?? []);
            setVisibleCount((cached as CandlesWindowOkResponse).meta?.expectedBars ?? null);
            setMeta((cached as CandlesWindowOkResponse).meta ?? null);
          } else {
            setCandles([]);
            setVisibleCount(null);
            setMeta(cached as CandlesWindowErrorResponse);
          }
          setLoading(false);
          setError(null);
          return;
        }

        const now = Date.now();

        // Respect server-provided retry cadence for CACHE_MISS without blocking scheduled retries longer than needed.
        const nextAllowedAt = nextAllowedAtRef.current[requestKey] ?? 0;
        if (now < nextAllowedAt) {
          setLoading(false);
          return;
        }

        // Throttle repeated requests for the same key (primarily protects non-cache-only symbol fetches).
        const lastAt = lastFetchAtRef.current[requestKey] ?? 0;
        if (lastAt > 0 && now - lastAt < MIN_FETCH_INTERVAL_MS) {
          // Too soon to refetch; keep existing state and avoid burning credits.
          setLoading(false);
          return;
        }

        setLoading(true);
        setError(null);

        // Phase 6: canonical candles hydration from a single endpoint.
        const targetType = instance.target.type;
        const isLegacyIxic = targetType === "IXIC";

        const symbol = isLegacyIxic
          ? "QQQ"
          : targetType === "SYMBOL"
            ? String((instance.target as any).symbol ?? "").trim().toUpperCase()
            : "";

        const watchlistKey =
          targetType === "WATCHLIST_COMPOSITE"
            ? String((instance.target as any).watchlistKey ?? "").trim()
            : "";

        const ownerUserId = targetType === "WATCHLIST_COMPOSITE" ? (OWNER_USER_ID ?? "") : "";

        const resRaw = String(instance.resolution ?? "").trim().toLowerCase();

        // Normalize resolution values across UI and API callers.
        // We tolerate multiple aliases so charts still hydrate even if the UI emits a different token.
        function normalizeResolution(raw: string): { ok: boolean; res: string } {
          const r = raw.trim().toLowerCase();

          // Canonical intraday resolutions
          if (r === "1m" || r === "5m" || r === "15m" || r === "30m") {
            return { ok: true, res: r };
          }

          // Canonical durable resolutions
          if (r === "1h" || r === "60m" || r === "60" || r === "1hour" || r === "hour") {
            return { ok: true, res: "1h" };
          }

          if (r === "4h" || r === "240m" || r === "240" || r === "4hour" || r === "4hours") {
            return { ok: true, res: "4h" };
          }

          if (r === "1d" || r === "d" || r === "day" || r === "daily" || r === "1day") {
            return { ok: true, res: "1d" };
          }

          return { ok: false, res: r };
        }

        const norm = normalizeResolution(resRaw);

        const isComposite = targetType === "WATCHLIST_COMPOSITE";
        const missingCompositeParams = isComposite && (!watchlistKey || !ownerUserId);
        const missingSymbolParams = !isComposite && !symbol;

        if (!norm.ok || missingSymbolParams || missingCompositeParams) {
          // Unsupported target/range/resolution under Phase 6.
          setCandles([]);
          setVisibleCount(null);
          setMeta({
            ok: false,
            error: {
              code: "UNSUPPORTED",
              message: "Unsupported candles request under Phase 6 contract",
              upstream: "fly",
              status: null,
            },
          });
          setLoading(false);
          setError(null);
          return;
        }

        let json: CandlesWindowResponse | null = null;

        // Canonical session selection.
        // Default to extended so 1D charts start at premarket when session is relevant.
        const rawSession = String(
          (instance as any)?.session ?? (instance as any)?.candleSession ?? "extended"
        )
          .trim()
          .toLowerCase();
        const session = rawSession === "regular" ? "regular" : "extended";

        // Single canonical endpoint: /api/market/candles/window
        const url = new URL("/api/market/candles/window", window.location.origin);

        if (isComposite) {
          url.searchParams.set("target", "WATCHLIST_COMPOSITE");
          url.searchParams.set("watchlistKey", watchlistKey);
          url.searchParams.set("ownerUserId", ownerUserId);
        } else {
          url.searchParams.set("target", "SYMBOL");
          url.searchParams.set("symbol", symbol);
        }

        url.searchParams.set("range", String(instance.range ?? "1D"));
        url.searchParams.set("res", norm.res);
        url.searchParams.set("session", session);

        const resp = await fetch(url.toString(), { method: "GET", cache: "no-store" });
        json = (await resp.json()) as CandlesWindowResponse;

        // Proxy guarantee: either {candles, meta} or {ok:false, error:{...}}
        if (json && json.ok === false) {
          // Treat as renderable truth, not an exception.
          if (!cancelled) {
            setCandles([]);
            setVisibleCount(null);
            setMeta(json);
            setError(null);

            lastFetchAtRef.current[requestKey] = Date.now();
            nextAllowedAtRef.current[requestKey] = 0;

            clientCacheSet(requestKey, json as CandlesWindowErrorResponse, CLIENT_CACHE_TTL_MS);
          }
          return;
        }

        if (!cancelled) {
          const okJson = json as CandlesWindowOkResponse;
          const normalized = Array.isArray(okJson.candles) ? okJson.candles : [];

          console.log("[useCandles->setCandles]", {
            requestKey,
            target: instance.target,
            range: instance.range,
            resolution: instance.resolution,
            normalizedLen: normalized.length,
            firstMs: normalized[0]?.time,
            lastMs: normalized[normalized.length - 1]?.time,
            firstIso: normalized[0]?.time ? new Date(normalized[0].time).toISOString() : null,
            lastIso: normalized[normalized.length - 1]?.time
              ? new Date(normalized[normalized.length - 1].time).toISOString()
              : null,
            serverRange: okJson?.meta?.range ?? null,
            session: okJson?.meta?.session ?? null,
            source: okJson?.meta?.source ?? null,
          });

          // Dev-only diagnostics: warn when the returned window is materially undersupplied.
          if (process.env.NODE_ENV !== "production") {
            const expectedBars = typeof okJson?.meta?.expectedBars === "number" ? okJson.meta.expectedBars : null;
            const receivedBars =
              typeof okJson?.meta?.receivedBars === "number" ? okJson.meta.receivedBars : normalized.length;

            if (expectedBars && receivedBars < expectedBars * 0.6) {
              const w = okJson?.meta?.window ?? null;
              console.warn("[useCandles][UNDERSUPPLIED_WINDOW]", {
                requestKey,
                expectedBars,
                receivedBars,
                window: w,
                range: okJson?.meta?.range ?? instance.range,
                res: okJson?.meta?.res ?? norm.res,
                session: okJson?.meta?.session ?? session,
                source: okJson?.meta?.source ?? null,
              });
            }
          }

          setCandles(normalized);
          const expectedBars = typeof okJson?.meta?.expectedBars === "number" ? okJson.meta.expectedBars : null;
          setVisibleCount(expectedBars);
          setMeta(okJson?.meta ?? null);

          lastFetchAtRef.current[requestKey] = Date.now();
          nextAllowedAtRef.current[requestKey] = 0;

          // Populate client cache to avoid refetch storms.
          clientCacheSet(requestKey, okJson, CLIENT_CACHE_TTL_MS);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message ?? "Failed to fetch candles");
          setCandles([]);
          setVisibleCount(null);
          setMeta(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchCandles();

    return () => {
      cancelled = true;
    };
  }, [requestKey]);

  return { candles, visibleCount, meta, loading, error };
}
