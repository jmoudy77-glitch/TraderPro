"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Candle } from "@/lib/market-data/types";
import type { ChartInstanceState } from "@/components/state/chart-types";

type UseCandlesResult = {
  candles: Candle[];
  // Number of candles that correspond to the requested range at the requested resolution.
  // The server may return additional lookback candles for indicators.
  visibleCount: number | null;
  meta: any | null;
  loading: boolean;
  error: string | null;
};

const OWNER_USER_ID = process.env.NEXT_PUBLIC_DEV_OWNER_USER_ID ?? null;

// Client-side protection against accidental request storms.
// - In-memory TTL cache prevents re-renders from re-fetching the same payload.
// - A minimum fetch interval prevents rapid UI churn from burning provider credits.
// NOTE: This is per-browser-tab (in-memory). Server-side caching still applies separately.

export type CandlesPayload = {
  candles?: Candle[];
  visibleCount?: number;
  meta?: any;
  // Server may return structured errors with 200 OK (e.g., CACHE_MISS)
  ok?: boolean;
  error?: string;
  message?: string;
  retryAfterMs?: number;
};

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
  resolution: string;
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

  return `${tKey}|${input.range}|${input.resolution}|${ownerKey}`;
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
  const [candles, setCandles] = useState<Candle[]>([]);
  const [visibleCount, setVisibleCount] = useState<number | null>(null);
  const [meta, setMeta] = useState<any | null>(null);
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

      setCandles(cached.candles ?? []);
      setVisibleCount(typeof cached.visibleCount === "number" ? cached.visibleCount : null);
      setMeta(cached.meta ?? null);
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
        setCandles(cached.candles ?? []);
        setVisibleCount(typeof cached.visibleCount === "number" ? cached.visibleCount : null);
        setMeta(cached.meta ?? null);
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

      const isLegacyIxic = instance.target.type === "IXIC";
      const targetParam = isLegacyIxic ? "SYMBOL" : instance.target.type;

      const params = new URLSearchParams({
        target: targetParam,
        range: instance.range,
        resolution: instance.resolution,
      });

      if (targetParam === "SYMBOL") {
        // If it's the legacy IXIC target, force QQQ as the proxy symbol.
        params.set("symbol", isLegacyIxic ? "QQQ" : (instance.target as any).symbol);
      }

      if (instance.target.type === "WATCHLIST_COMPOSITE") {
        const watchlistKey = instance.target.watchlistKey;
        params.set("watchlistKey", watchlistKey);
        if (OWNER_USER_ID) params.set("ownerUserId", OWNER_USER_ID);

        // Cache-driven by default: do not allow UI-driven warming.
        // Sentinel is the exception: it is allowed to warm the server cache on page load.
        if ((watchlistKey as string) !== "SENTINEL") {
          params.set("cacheOnly", "1");
        }
      }

      const url = `/api/market/candles?${params.toString()}`;

      try {
        const res = await fetch(url);

        // If server returned a structured error, surface it.
        if (!res.ok) {
          let message = `HTTP ${res.status}`;
          try {
            const errJson = await res.json();
            if (errJson?.message) message = String(errJson.message);
            else if (errJson?.error) message = String(errJson.error);
          } catch {
            // ignore json parse errors
          }
          throw new Error(message);
        }

        const json = (await res.json()) as CandlesPayload;

        // Some endpoints intentionally return structured errors with 200 OK (e.g., CACHE_MISS).
        // CACHE_MISS is a *soft* miss: do not surface as an error and do not clear existing UI state.
        // Also cache the miss briefly to prevent re-render storms from re-requesting the miss repeatedly.
        if (json && json.ok === false) {
          if (json.error === "CACHE_MISS") {
            if (!cancelled) {
              // Keep existing candles/meta; just stop loading.
              setError(null);
              setLoading(false);

              // Respect server-provided retry timing (or a small fallback) without poisoning the client cache.
              const retryMs = typeof json.retryAfterMs === "number" && json.retryAfterMs > 0 ? json.retryAfterMs : 2_000;
              const ttlMs = Math.min(CLIENT_CACHE_TTL_MS, retryMs);
              nextAllowedAtRef.current[requestKey] = Date.now() + ttlMs;
            }
            return;
          }

          const msg = json.message || json.error || "Request failed";
          const e = new Error(String(msg));
          (e as any).code = json.error;
          (e as any).retryAfterMs = typeof json.retryAfterMs === "number" ? json.retryAfterMs : undefined;
          throw e;
        }

        if (!cancelled) {
          setCandles(json.candles ?? []);
          setVisibleCount(typeof json.visibleCount === "number" ? json.visibleCount : null);
          setMeta(json.meta ?? null);

          lastFetchAtRef.current[requestKey] = Date.now();
          nextAllowedAtRef.current[requestKey] = 0;

          // Populate client cache to avoid refetch storms.
          clientCacheSet(requestKey, json, CLIENT_CACHE_TTL_MS);
        }
      } catch (err: any) {
        if (!cancelled) {
          const code = err?.code ? String(err.code) : null;

          if (code === "CACHE_MISS") {
            // Soft miss: keep existing state; do not show an error.
            setError(null);
            const retryMs = typeof err?.retryAfterMs === "number" && err.retryAfterMs > 0 ? err.retryAfterMs : 2_000;
            const ttlMs = Math.min(CLIENT_CACHE_TTL_MS, retryMs);
            nextAllowedAtRef.current[requestKey] = Date.now() + ttlMs;
            return;
          }

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