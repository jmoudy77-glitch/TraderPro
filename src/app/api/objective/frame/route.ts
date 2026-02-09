// /Users/joshmoudy/dev/traderpro/src/app/api/objective/frame/route.ts
import { NextResponse } from "next/server";
import {
  createSupabaseServerAnon,
  createSupabaseServerWithJwt,
  createSupabaseServiceRole,
} from "@/lib/supabase/server";

type DraftPayload = {
  id?: string;
  objectiveText: string;
  participationModes?: Array<"intraday" | "swing" | "position" | "observe">;
  primaryHorizon?: "intraday" | "swing" | "position" | "mixed";
  riskPosture?: "conservative" | "balanced" | "aggressive";
  successOrientationText?: string;
  failureGuardrailsText?: string;
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
  if (!devOwnerId) return { ok: false as const };

  return {
    ok: true as const,
    uid: devOwnerId,
    supabase: createSupabaseServiceRole(),
    mode: "dev" as const,
  };
}

export async function GET(req: Request) {
  const actor = await resolveActor(req);
  if (!actor.ok) return json(false, { error: "UNAUTHENTICATED" }, 401);

  const uid = actor.uid;
  const supabase = actor.supabase;

  // Prefer ACTIVE
  const active = await supabase
    .from("objective_frames")
    .select("*")
    .eq("owner_user_id", uid)
    .eq("status", "active")
    .order("activated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (active.error) return json(false, { error: active.error.message }, 500);
  if (active.data) return json(true, { frame: active.data });

  // Else: most recent by updated_at
  const latest = await supabase
    .from("objective_frames")
    .select("*")
    .eq("owner_user_id", uid)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latest.error) return json(false, { error: latest.error.message }, 500);
  return json(true, { frame: latest.data ?? null });
}

export async function POST(req: Request) {
  const actor = await resolveActor(req);
  if (!actor.ok) return json(false, { error: "UNAUTHENTICATED" }, 401);

  const uid = actor.uid;
  const supabase = actor.supabase;

  let body: DraftPayload;
  try {
    body = (await req.json()) as DraftPayload;
  } catch {
    return json(false, { error: "INVALID_JSON" }, 400);
  }

  if (!body?.objectiveText || body.objectiveText.trim().length === 0) {
    return json(false, { error: "objectiveText is required" }, 400);
  }

  const row = {
    owner_user_id: uid,
    objective_text: body.objectiveText.trim(),
    participation_modes: body.participationModes ?? null,
    primary_horizon: body.primaryHorizon ?? null,
    risk_posture: body.riskPosture ?? null,
    success_orientation_text: body.successOrientationText ?? null,
    failure_guardrails_text: body.failureGuardrailsText ?? null,
    status: "draft" as const,
    activated_at: null,
    closed_at: null,
    updated_at: new Date().toISOString(),
  };

  if (body.id) {
    const updated = await supabase
      .from("objective_frames")
      .update(row)
      .eq("id", body.id)
      .select("*")
      .single();

    if (updated.error) return json(false, { error: updated.error.message }, 500);
    return json(true, { frame: updated.data });
  }

  const inserted = await supabase
    .from("objective_frames")
    .insert(row)
    .select("*")
    .single();

  if (inserted.error) return json(false, { error: inserted.error.message }, 500);
  return json(true, { frame: inserted.data });
}