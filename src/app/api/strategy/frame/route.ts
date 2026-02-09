// /Users/joshmoudy/dev/traderpro/src/app/api/strategy/frame/route.ts
import { NextResponse } from "next/server";
import {
  createSupabaseServerAnon,
  createSupabaseServerWithJwt,
  createSupabaseServiceRole,
} from "@/lib/supabase/server";

type StrategyRow = {
  id: string;
  owner_user_id: string;
  objective_frame_id: string | null;
  ratified_objective_frame_id: string | null;
  ratified_session_key_et: string | null; // PostgREST may return date as string
  ratified_at: string | null;
  ratified_by: string | null;
  status: "DRAFT" | "ACTIVE" | "EXPIRED" | "ARCHIVED";
  activated_at: string | null;
  active_version_id: string | null;
};

function json(ok: boolean, data: any, status = 200) {
  return NextResponse.json({ ok, ...data }, { status });
}

function getBearerToken(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
}

function getDevOwnerId() {
  if (process.env.NODE_ENV !== "development") return null;
  if (process.env.TRADERPRO_DEV_OWNER_FALLBACK !== "true") return null;
  return process.env.TRADERPRO_DEV_OWNER_USER_ID || null;
}

function getEtSessionKeyISO(): string {
  // Canon: session authority is ET; use calendar date as YYYY-MM-DD.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function resolveActor(req: Request) {
  const jwt = getBearerToken(req);

  if (jwt) {
    const supabase = createSupabaseServerAnon();
    const { data: auth, error: authErr } = await supabase.auth.getUser(jwt);
    if (authErr || !auth?.user) return { ok: false as const };

    const supabaseBound = createSupabaseServerWithJwt(jwt);

    return {
      ok: true as const,
      uid: auth.user.id,
      supabase: supabaseBound,
      mode: "authed" as const,
    };
  }

  const devOwnerId = getDevOwnerId();
  if (devOwnerId) {
    const supabase = createSupabaseServiceRole();
    return {
      ok: true as const,
      uid: devOwnerId,
      supabase,
      mode: "dev" as const,
    };
  }

  return { ok: false as const };
}

export async function GET(req: Request) {
  const actor = await resolveActor(req);
  if (!actor.ok) {
    return json(false, { error: "Unauthorized" }, 401);
  }

  const currentSessionKeyEt = getEtSessionKeyISO();

  // Read-model: return the current strategy for the current ET session (or null).
  // This is read-time enforcement only; do not mutate status here.
  const { data, error } = await (actor.supabase.from("strategies") as any)
    .select(
      [
        "id",
        "owner_user_id",
        "objective_frame_id",
        "ratified_objective_frame_id",
        "ratified_session_key_et",
        "ratified_at",
        "ratified_by",
        "status",
        "activated_at",
        "active_version_id",
      ].join(",")
    )
    .eq("owner_user_id", actor.uid)
    .neq("status", "ARCHIVED")
    // Read-time enforcement: return the latest (most relevant) strategy row for the user,
    // then compute expiration vs the current ET session key in the response.
    .order("activated_at", { ascending: false })
    .order("ratified_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = (data ?? null) as StrategyRow | null;

  if (error) {
    return json(false, { error: error.message }, 500);
  }

  const isSessionExpired =
    row?.ratified_session_key_et != null &&
    String(row.ratified_session_key_et) !== currentSessionKeyEt;

  const frame = row
    ? {
        id: row.id,
        owner_user_id: row.owner_user_id,
        objective_frame_id: row.objective_frame_id,
        ratified_objective_frame_id: row.ratified_objective_frame_id,
        ratified_session_key_et: row.ratified_session_key_et
          ? String(row.ratified_session_key_et)
          : null,
        ratified_at: row.ratified_at,
        ratified_by: row.ratified_by,
        status: row.status,
        activated_at: row.activated_at,
        active_version_id: row.active_version_id,
        current_session_key_et: currentSessionKeyEt,
        is_session_expired: Boolean(isSessionExpired),
      }
    : null;

  return json(true, { frame });
}