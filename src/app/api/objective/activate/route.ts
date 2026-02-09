// /Users/joshmoudy/dev/traderpro/src/app/api/objective/activate/route.ts
import { NextResponse } from "next/server";
import {
  createSupabaseServerAnon,
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

export async function POST(req: Request) {
  let body: { frameId?: string };
  try {
    body = (await req.json()) as { frameId?: string };
  } catch {
    return json(false, { error: "INVALID_JSON" }, 400);
  }

  if (!body.frameId) return json(false, { error: "frameId is required" }, 400);

  const jwt = getBearerToken(req);

  // Path A: Auth present (future login plane)
  if (jwt) {
    const supabase = createSupabaseServerAnon();

    const { data: auth, error: authErr } = await supabase.auth.getUser(jwt);
    if (authErr || !auth?.user) return json(false, { error: "UNAUTHENTICATED" }, 401);

    const { data, error } = await supabase.rpc("activate_objective_frame", {
      p_frame_id: body.frameId,
    });

    if (error) return json(false, { error: error.message }, 500);
    return json(true, { frame: data });
  }

  // Path B: Dev fallback (no login yet)
  const devOwnerId = getDevOwnerId();
  if (!devOwnerId) return json(false, { error: "UNAUTHENTICATED" }, 401);

  const supabase = createSupabaseServiceRole();

  // Use dev-safe function that does not rely on auth.uid()
  const { data, error } = await supabase.rpc("activate_objective_frame_for_user", {
    p_owner_user_id: devOwnerId,
    p_frame_id: body.frameId,
  });

  if (error) return json(false, { error: error.message }, 500);
  return json(true, { frame: data });
}