"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChartInstanceState } from "@/components/state/chart-types";
import { realtimeState, type IntradayResolution } from "@/lib/realtime/realtimeState";

type UseCandlesResult = {
  // Phase 6: truth-preserving candle array (shape depends on contract surface)
  candles: any[];
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

export type CandlesPayload =
  | {
      candles: any[];
      meta: any;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        upstream: "fly";
        status: number | null;
      };
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
  const [candles, setCandles] = useState<any[]>([]);
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

      setCandles((cached as any).candles ?? []);
      setVisibleCount(null);
      setMeta((cached as any).meta ?? null);
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
        setCandles((cached as any).candles ?? []);
        setVisibleCount(null);
        setMeta((cached as any).meta ?? null);
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

      // Phase 6: candles are sourced only from realtime-ws via the Vercel proxy.
      // This hook currently supports SYMBOL/IXIC targets only under the Phase 6 contract.
      const isLegacyIxic = instance.target.type === "IXIC";
      const symbol = isLegacyIxic
        ? "QQQ"
        : instance.target.type === "SYMBOL"
          ? String((instance.target as any).symbol ?? "").trim().toUpperCase()
          : "";

      const res = String(instance.resolution ?? "").trim() as IntradayResolution;
      const isSupportedRes = res === "1m" || res === "5m" || res === "30m";

      if (!symbol || !isSupportedRes) {
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

      try {
        // Ensure central realtime state is started (idempotent) and fetch intraday candles.
        realtimeState.start();

        const json = (await realtimeState.fetchIntradayCandles(symbol, res, undefined)) as any;

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

            clientCacheSet(requestKey, json as any, CLIENT_CACHE_TTL_MS);
          }
          return;
        }

        if (!cancelled) {
          setCandles(Array.isArray(json?.candles) ? json.candles : []);
          setVisibleCount(null);
          setMeta(json?.meta ?? null);

          lastFetchAtRef.current[requestKey] = Date.now();
          nextAllowedAtRef.current[requestKey] = 0;

          // Populate client cache to avoid refetch storms.
          clientCacheSet(requestKey, json as any, CLIENT_CACHE_TTL_MS);
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