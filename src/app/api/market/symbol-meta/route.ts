import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return true;
  return t <= Date.now();
}

function computeSectorCode(sector: string | null): string | null {
  if (!sector) return null;
  const s = String(sector).trim();
  if (!s) return null;
  const parts = s
    .split(/[^A-Za-z0-9]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0].slice(0, 3).toUpperCase();
  return parts
    .slice(0, 3)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}

function getAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  if (!serviceKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

function parseSymbolsParam(v: string | null): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 500);
}

/**
 * Global, authoritative symbol classification lookup (DB-only).
 *
 * GET /api/market/symbol-meta?symbols=NVDA,MSFT
 *
 * Returns:
 * {
 *   ok: true,
 *   meta: {
 *     NVDA: { sector: "Technology", sectorCode: "TEC", industry: "Semiconductors", expiresAt: "..." }
 *   }
 * }
 *
 * NOTE: This endpoint MUST NOT call upstream providers (e.g., Twelve Data).
 * Upstream hydration/backfill is performed by the scheduled hydrator to avoid rate-limit bursts.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbols = parseSymbolsParam(searchParams.get("symbols"));
  const debug = searchParams.get("debug") === "1";

  if (symbols.length === 0) {
    return NextResponse.json({ ok: true, meta: {} });
  }

  const supabase = getAdmin();

  // DB-only lookup (Phase 2 schema). No upstream calls here.
  const { data: scData, error: scError } = await supabase
    .from("symbol_classification")
    .select("symbol, sector, industry, updated_at")
    .in("symbol", symbols);

  if (scError) {
    throw new Error(scError.message);
  }

  const rows: any[] = scData ?? [];

  const meta: Record<
    string,
    {
      sector: string | null;
      sectorCode: string | null;
      industry: string | null;
      industryCode: string | null;
      industryAbbrev: string | null;
      expiresAt: string | null;
    }
  > = {};

  // default all requested symbols to nulls
  for (const sym of symbols) {
    meta[sym] = {
      sector: null,
      sectorCode: null,
      industry: null,
      industryCode: null,
      industryAbbrev: null,
      expiresAt: null,
    };
  }

  // overlay DB rows
  for (const r of rows as any[]) {
    const symbol = String(r.symbol ?? "").toUpperCase();
    if (!symbol) continue;

    meta[symbol] = {
      sector: r.sector ?? null,
      sectorCode: computeSectorCode(r.sector ?? null),
      industry: r.industry ?? null,
      industryCode: null,
      industryAbbrev: null,
      expiresAt: null,
    };
  }

  // expose hydrate needs for the scheduler (no upstream calls here)
  const needsHydrate = symbols.filter((sym) => {
    const m = meta[sym];
    return !m?.sector;
  });

  return NextResponse.json({
    ok: true,
    meta,
    ...(debug ? { debug: { needsHydrate, needsHydrateCount: needsHydrate.length } } : {}),
  });
}