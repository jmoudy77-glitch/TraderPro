"use client";
import { useEffect, useMemo, useState } from "react";
import RailPanelFrame from "@/components/RailPanelFrame";
import { createSupabaseBrowser } from "@/lib/supabase/browser";

type StrategyEligibilityState = "READY" | "STALE" | "EXPIRED" | "INVALID";

type ObjectiveFrameRow = {
  id: string;
  status: "draft" | "active" | "closed";
};

type StrategyFrameRow = {
  id: string;
  owner_user_id: string;
  objective_frame_id: string | null;
  ratified_objective_frame_id: string | null;
  ratified_session_key_et: string | null;
  ratified_at: string | null;
  ratified_by: string | null;
  status: "DRAFT" | "ACTIVE" | "EXPIRED" | "ARCHIVED";
  activated_at: string | null;
  active_version_id: string | null;
  current_session_key_et: string;
  is_session_expired: boolean;
};

function getEtSessionKey(): string {
  // Canon: Market session authority is ET. Use ET calendar date as YYYY-MM-DD.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const y = get("year");
  const m = get("month");
  const d = get("day");
  return `${y}-${m}-${d}`;
}

function deriveEligibilityState(args: {
  activeObjectiveId: string | null;
  strategyObjectiveId: string | null;
  lastRatifiedObjectiveId: string | null;
  lastRatifiedSessionKey: string | null;
  isStrategyComplete: boolean;
}): {
  state: StrategyEligibilityState;
  statusText: string;
  reasonText?: string;
  tooltipWhenDisabled?: string;
} {
  const {
    activeObjectiveId,
    strategyObjectiveId,
    lastRatifiedObjectiveId,
    lastRatifiedSessionKey,
    isStrategyComplete,
  } = args;

  if (!activeObjectiveId) {
    return {
      state: "INVALID",
      statusText: "Status: NOT ELIGIBLE",
      reasonText: "No ACTIVE Objective is set.",
      tooltipWhenDisabled: "An ACTIVE Objective is required.",
    };
  }

  if (!isStrategyComplete) {
    return {
      state: "INVALID",
      statusText: "Status: NOT ELIGIBLE",
      reasonText: "Strategy is incomplete.",
      tooltipWhenDisabled: "Complete the strategy before activating.",
    };
  }

  // If the strategy is explicitly tied to a different Objective than the current ACTIVE Objective,
  // it is stale and must be reviewed before activation.
  if (strategyObjectiveId && strategyObjectiveId !== activeObjectiveId) {
    return {
      state: "STALE",
      statusText: "Status: OBJECTIVE CHANGED",
      reasonText: "Objective has changed since last activation.",
      tooltipWhenDisabled: "Objective changed — review and activate again.",
    };
  }

  // If we have a prior ratification record, and it was for a different Objective than the current ACTIVE Objective,
  // treat as stale as well.
  if (lastRatifiedObjectiveId && lastRatifiedObjectiveId !== activeObjectiveId) {
    return {
      state: "STALE",
      statusText: "Status: OBJECTIVE CHANGED",
      reasonText: "Objective has changed since last activation.",
      tooltipWhenDisabled: "Objective changed — review and activate again.",
    };
  }

  const currentSessionKey = getEtSessionKey();

  // If a strategy was ratified in a prior session, it is expired (session-scoped).
  if (lastRatifiedSessionKey && lastRatifiedSessionKey !== currentSessionKey) {
    return {
      state: "EXPIRED",
      statusText: "Status: SESSION EXPIRED",
      reasonText: "Strategy must be activated for today’s session.",
      tooltipWhenDisabled: "New trading session — activation required.",
    };
  }

  return {
    state: "READY",
    statusText: "Status: READY",
  };
}

export default function StrategyPanel() {
  /**
   * NOTE (Dev Plane — Strategy Ratification & Eligibility Enforcement):
   * This component must derive eligibility deterministically at render.
   * Wiring of real inputs (Objective + Strategy persistence) will replace the TODO placeholders below.
   */

  const supabase = useMemo(() => createSupabaseBrowser(), []);

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }

  async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
    const token = await getAccessToken();
    const headers = new Headers(init.headers);

    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    return fetch(input, { ...init, headers });
  }

  const [objectiveFrame, setObjectiveFrame] = useState<ObjectiveFrameRow | null>(null);
  const [objectiveLoading, setObjectiveLoading] = useState(true);
  const [objectiveError, setObjectiveError] = useState<string | null>(null);

  const [strategyFrame, setStrategyFrame] = useState<StrategyFrameRow | null>(null);
  const [strategyLoading, setStrategyLoading] = useState(true);
  const [strategyError, setStrategyError] = useState<string | null>(null);

  async function refreshObjectiveFrame() {
    setObjectiveError(null);
    try {
      const res = await authedFetch("/api/objective/frame", { method: "GET" });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error ?? "Failed to load objective");
      }
      const frame: ObjectiveFrameRow | null = json.frame ?? null;
      setObjectiveFrame(frame);
    } catch (e: any) {
      setObjectiveError(e?.message ?? "Failed to load objective");
      setObjectiveFrame(null);
    }
  }

  async function refreshStrategyFrame() {
    setStrategyError(null);
    try {
      const res = await authedFetch("/api/strategy/frame", { method: "GET" });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error ?? "Failed to load strategy");
      }
      const frame: StrategyFrameRow | null = json.frame ?? null;
      setStrategyFrame(frame);
    } catch (e: any) {
      setStrategyError(e?.message ?? "Failed to load strategy");
      setStrategyFrame(null);
    }
  }

  useEffect(() => {
    (async () => {
      setObjectiveLoading(true);
      setStrategyLoading(true);
      await Promise.all([refreshObjectiveFrame(), refreshStrategyFrame()]);
      setObjectiveLoading(false);
      setStrategyLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let intervalId: any = null;

    const refresh = async () => {
      // Do not toggle the initial loading flags on subsequent refreshes;
      // keep this lightweight so UI doesn't flicker.
      await Promise.all([refreshObjectiveFrame(), refreshStrategyFrame()]);
    };

    const onFocus = () => {
      void refresh();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    // Dev convenience: lightweight polling so Objective activation changes are reflected
    // immediately without requiring a full page refresh.
    if (process.env.NODE_ENV === "development") {
      intervalId = setInterval(() => {
        void refresh();
      }, 4000);
    }

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      if (intervalId) clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ACTIVE Objective id is derived from the DB-backed Objective frame.
  const activeObjectiveId: string | null =
    objectiveFrame?.status === "active" ? objectiveFrame.id : null;

  // Strategy objective binding (optional) + last ratification record are derived from the DB-backed Strategy frame.
  const strategyObjectiveId: string | null = strategyFrame?.objective_frame_id ?? null;

  const lastRatifiedObjectiveId: string | null =
    strategyFrame?.ratified_objective_frame_id ?? null;

  const lastRatifiedSessionKey: string | null =
    strategyFrame?.ratified_session_key_et ?? null;

  // Minimal completeness predicate for this plane: a strategy frame exists.
  // (Deeper completeness rules can be introduced later once Strategy content editing/validation is implemented.)
  const isStrategyComplete = Boolean(strategyFrame);

  const eligibility = deriveEligibilityState({
    activeObjectiveId,
    strategyObjectiveId,
    lastRatifiedObjectiveId,
    lastRatifiedSessionKey,
    isStrategyComplete,
  });

  // TODO (Checklist: Activate gating): enable/disable Activate based on eligibility state.
  // For now, keep disabled until wiring is completed, but drive status/tooltip deterministically.
  const activateDisabled = true;

  const activateTitle = activateDisabled
    ? eligibility.tooltipWhenDisabled ?? "Activation unavailable."
    : "Activate";

  return (
    <RailPanelFrame
      title="Strategy"
      rightSlot={<div className="text-xs text-neutral-500">Canonical contract</div>}
    >
      <div className="flex h-full flex-col gap-3 rounded border border-dashed border-neutral-800 p-3">
        <div className="text-xs text-neutral-500">
          Strategy panel placeholder. Structured, validate → activate.
        </div>

        {objectiveLoading ? (
          <div className="text-[11px] text-neutral-500">Loading objective…</div>
        ) : null}

        {objectiveError ? (
          <div className="text-[11px] text-red-300">{objectiveError}</div>
        ) : null}

        {strategyLoading ? (
          <div className="text-[11px] text-neutral-500">Loading strategy…</div>
        ) : null}

        {strategyError ? (
          <div className="text-[11px] text-red-300">{strategyError}</div>
        ) : null}

        <div className="mt-auto flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <div className="text-[11px] text-neutral-500">{eligibility.statusText}</div>
            {activateDisabled && eligibility.reasonText ? (
              <div className="text-[11px] text-neutral-500">{eligibility.reasonText}</div>
            ) : null}
          </div>

          <button
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 disabled:opacity-50"
            type="button"
            disabled={activateDisabled}
            title={activateTitle}
          >
            Activate
          </button>
        </div>
      </div>
    </RailPanelFrame>
  );
}