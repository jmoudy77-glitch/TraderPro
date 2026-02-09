

// /Users/joshmoudy/dev/traderpro/src/app/api/strategy/activate/route.ts
import { NextResponse } from "next/server";
import {
  createSupabaseServerAnon,
  createSupabaseServerWithJwt,
  createSupabaseServiceRole,
} from "@/lib/supabase/server";

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

type ActivatePayload = {
  strategyId: string;
  strategyVersionId: string;
};

export async function POST(req: Request) {
  const actor = await resolveActor(req);
  if (!actor.ok) {
    return json(false, { error: "Unauthorized" }, 401);
  }

  let payload: ActivatePayload;
  try {
    payload = await req.json();
  } catch {
    return json(false, { error: "Invalid JSON body" }, 400);
  }

  const { strategyId, strategyVersionId } = payload;
  if (!strategyId || !strategyVersionId) {
    return json(false, { error: "Missing required fields" }, 400);
  }

  // Load ACTIVE Objective (authoritative)
  const { data: activeObjective, error: objErr } = await actor.supabase
    .from("objective_frames")
    .select("id")
    .eq("owner_user_id", actor.uid)
    .eq("status", "active")
    .maybeSingle();

  if (objErr) {
    return json(false, { error: objErr.message }, 500);
  }
  if (!activeObjective) {
    return json(false, { error: "No ACTIVE Objective" }, 400);
  }

  // Load Strategy + validate ownership
  const { data: strategy, error: stratErr } = await actor.supabase
    .from("strategies")
    .select("id, status")
    .eq("id", strategyId)
    .eq("owner_user_id", actor.uid)
    .maybeSingle();

  if (stratErr) {
    return json(false, { error: stratErr.message }, 500);
  }
  if (!strategy) {
    return json(false, { error: "Strategy not found" }, 404);
  }
  if (strategy.status === "ARCHIVED") {
    return json(false, { error: "Strategy is archived" }, 400);
  }

  // Validate StrategyVersion belongs to Strategy
  const { data: version, error: verErr } = await actor.supabase
    .from("strategy_versions")
    .select("id")
    .eq("id", strategyVersionId)
    .eq("strategy_id", strategyId)
    .maybeSingle();

  if (verErr) {
    return json(false, { error: verErr.message }, 500);
  }
  if (!version) {
    return json(false, { error: "Strategy version not found" }, 400);
  }

  const sessionKeyEt = getEtSessionKeyISO();
  const now = new Date().toISOString();

  // Activate (single transaction semantics; DB enforces uniqueness)
  const { error: updErr } = await actor.supabase
    .from("strategies")
    .update({
      status: "ACTIVE",
      objective_frame_id: activeObjective.id,
      ratified_objective_frame_id: activeObjective.id,
      ratified_session_key_et: sessionKeyEt,
      ratified_at: now,
      ratified_by: actor.mode === "dev" ? "DEV_OWNER" : "USER",
      activated_at: now,
      active_version_id: strategyVersionId,
    })
    .eq("id", strategyId);

  if (updErr) {
    // Unique index violation -> conflict
    return json(false, { error: updErr.message }, 409);
  }

  // Emit activation event
  await actor.supabase.from("strategy_version_events").insert({
    strategy_id: strategyId,
    strategy_version_id: strategyVersionId,
    event_type: "ACTIVATED",
    meta: { reason: "ACTIVATE" },
  });

  return json(true, {
    frame: {
      id: strategyId,
      status: "ACTIVE",
      ratified_session_key_et: sessionKeyEt,
      activated_at: now,
      active_version_id: strategyVersionId,
    },
  });
}