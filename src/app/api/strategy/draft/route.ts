// /Users/joshmoudy/dev/traderpro/src/app/api/strategy/draft/route.ts
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

type DraftPayload = {
  strategyText: string;
  strategyJson: any;
  createdBy: "USER" | "AI_DRAFT";
  marketAnchor?: "IXIC";
  regimeLabel?: string;
  objectiveFrameId?: string | null;
};

export async function POST(req: Request) {
  const actor = await resolveActor(req);
  if (!actor.ok) {
    return json(false, { error: "Unauthorized" }, 401);
  }

  let payload: DraftPayload;
  try {
    payload = await req.json();
  } catch {
    return json(false, { error: "Invalid JSON body" }, 400);
  }

  const {
    strategyText,
    strategyJson,
    createdBy,
    marketAnchor = "IXIC",
    regimeLabel,
    objectiveFrameId = null,
  } = payload;

  if (!strategyText || !strategyJson || !createdBy) {
    return json(false, { error: "Missing required fields" }, 400);
  }

  // 1) Ensure a strategies row exists for this owner.
  // We create one if none exists; otherwise reuse the most recent non-ARCHIVED row.
  const { data: existing, error: findErr } = await actor.supabase
    .from("strategies")
    .select("id, status")
    .eq("owner_user_id", actor.uid)
    .neq("status", "ARCHIVED")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (findErr) {
    return json(false, { error: findErr.message }, 500);
  }

  let strategyId: string;

  if (!existing) {
    const { data: created, error: createErr } = await actor.supabase
      .from("strategies")
      .insert({
        owner_user_id: actor.uid,
        trade_date: new Date().toISOString().slice(0, 10), // display-only
        objective_frame_id: objectiveFrameId,
        status: "DRAFT",
      })
      .select("id")
      .single();

    if (createErr || !created) {
      return json(false, { error: createErr?.message ?? "Failed to create strategy" }, 500);
    }

    strategyId = created.id;
  } else {
    strategyId = existing.id;

    // Optionally update objective linkage on draft save if provided
    if (objectiveFrameId) {
      await actor.supabase
        .from("strategies")
        .update({ objective_frame_id: objectiveFrameId })
        .eq("id", strategyId);
    }
  }

  // 2) Determine next version number
  const { data: lastVersion } = await actor.supabase
    .from("strategy_versions")
    .select("version")
    .eq("strategy_id", strategyId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = (lastVersion?.version ?? 0) + 1;

  // 3) Insert strategy version
  const { data: versionRow, error: versionErr } = await actor.supabase
    .from("strategy_versions")
    .insert({
      strategy_id: strategyId,
      version: nextVersion,
      created_by: createdBy,
      strategy_text: strategyText,
      strategy_json: strategyJson,
      market_anchor: marketAnchor,
      regime_label: regimeLabel,
    })
    .select("id, version")
    .single();

  if (versionErr || !versionRow) {
    return json(false, { error: versionErr?.message ?? "Failed to create strategy version" }, 500);
  }

  // 4) Emit CREATED event
  await actor.supabase.from("strategy_version_events").insert({
    strategy_id: strategyId,
    strategy_version_id: versionRow.id,
    event_type: "CREATED",
  });

  return json(true, {
    strategy_id: strategyId,
    strategy_version_id: versionRow.id,
    version: versionRow.version,
  });
}