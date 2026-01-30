import { NextResponse } from "next/server";

const UPSTREAM = "https://traderpro-realtime-ws.fly.dev/health";
const TIMEOUT_MS = 3000;

function jsonResponse(body: unknown, status = 200) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function GET() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(UPSTREAM, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });

    // Success: return upstream payload verbatim (no reshape / no defaults).
    if (res.ok) {
      const text = await res.text();
      return new NextResponse(text, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    // Failure: canonical envelope (UI must receive JSON every time).
    return jsonResponse(
      {
        ok: false,
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "Realtime service unavailable",
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
          code: "UPSTREAM_UNAVAILABLE",
          message: isAbort
            ? "Realtime service unavailable"
            : "Realtime service unavailable",
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