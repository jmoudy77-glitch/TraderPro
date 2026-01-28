import { NextRequest, NextResponse } from "next/server";
import { softDeleteWatchlist } from "@/app/actions/holdings";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const ownerUserId = String(body?.ownerUserId ?? "");
    const key = String(body?.key ?? "");

    if (!ownerUserId) return NextResponse.json({ ok: false, error: "MISSING_OWNER" }, { status: 400 });
    if (!key) return NextResponse.json({ ok: false, error: "MISSING_KEY" }, { status: 400 });

    await softDeleteWatchlist(ownerUserId, key);

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}