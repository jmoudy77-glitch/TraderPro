/**
 * DEPRECATED: Historical candle hydration is now served by `/api/market/candles/window`.
 *
 * This route is retained temporarily for rollback / non-UI callers. The UI must not call this.
 * (See Note: “Single Endpoint Transition”.)
 */
import { NextResponse } from "next/server";

const UPSTREAM_BASE = "https://traderpro-realtime-ws.fly.dev/candles/intraday";
const TIMEOUT_MS = 5000;

function jsonResponse(body: unknown, status = 200) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);

  // Map query params to the Fly contract (do not forward unknown params).
  // Fly expects: symbol, res (NOT resolution), optional limit.
  const upstreamUrl = new URL(UPSTREAM_BASE);

  const symbol = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  const resolution = (url.searchParams.get("resolution") || "").trim().toLowerCase();
  const res = (url.searchParams.get("res") || "").trim().toLowerCase();
  const limit = (url.searchParams.get("limit") || "").trim();

  if (symbol) upstreamUrl.searchParams.set("symbol", symbol);

  // Prefer explicit `res`, otherwise translate `resolution` -> `res`.
  const effectiveRes = res || resolution;
  if (effectiveRes) upstreamUrl.searchParams.set("res", effectiveRes);

  // Optional limit passthrough (if provided)
  if (limit) upstreamUrl.searchParams.set("limit", limit);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(upstreamUrl.toString(), {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });

    // Success: return upstream payload verbatim.
    if (res.ok) {
      const text = await res.text();
      return new NextResponse(text, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    // Non-2xx from upstream: canonical error envelope (include upstream body for debugging).
    const upstreamBody = await res.text().catch(() => "");

    return jsonResponse(
      {
        ok: false,
        error: {
          code: "UPSTREAM_ERROR",
          message: "Upstream error",
          upstream: "fly",
          status: res.status ?? null,
          body: upstreamBody || null,
        },
      },
      200
    );
  } catch (err: any) {
    const isAbort =
      err?.name === "AbortError" ||
      String(err?.message ?? "").toLowerCase().includes("aborted");

    return jsonResponse(
      {
        ok: false,
        error: {
          code: isAbort ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR",
          message: isAbort ? "Upstream timeout" : "Upstream error",
          upstream: "fly",
          status: null,
        },
      },
      200
    );
  } finally {
    clearTimeout(timeout);
  }
}