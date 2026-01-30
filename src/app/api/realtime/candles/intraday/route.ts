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

  // Forward query params exactly (no validation, no reshape).
  const upstreamUrl = new URL(UPSTREAM_BASE);
  url.searchParams.forEach((value, key) => {
    upstreamUrl.searchParams.set(key, value);
  });

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

    // Non-2xx from upstream: canonical error envelope.
    return jsonResponse(
      {
        ok: false,
        error: {
          code: "UPSTREAM_ERROR",
          message: "Upstream error",
          upstream: "fly",
          status: res.status ?? null,
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