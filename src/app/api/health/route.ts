import { NextResponse } from "next/server";
import { createSupabaseServerAnon } from "@/lib/supabase/server";

export async function GET() {
  const supabase = createSupabaseServerAnon();

  const probe = await supabase
    .from("watchlists")
    .select("id")
    .limit(1);

  return NextResponse.json({
    ok: true,
    dbReachable: true,
    watchlistsQuery: {
      ok: !probe.error,
      error: probe.error?.message ?? null,
    },
    note:
      "RLS failures are expected until auth exists. This confirms wiring only.",
  });
}