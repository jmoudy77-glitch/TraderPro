"use client";

import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase/browser";
import ObjectivePanel, {
  ObjectiveDraftPayload,
  ObjectiveMode,
  ObjectiveStatus,
  ObjectiveViewModel,
} from "./ObjectivePanel";

/**
 * ObjectivePanelController
 * - Owns controlled state: objective, mode, status
 * - Maintains a local edit buffer (draft) separate from committed snapshot
 * - Persists and hydrates Objective via API routes (DB-backed source of truth)
 *
 * NOTE: ObjectivePanel implements empty-state, read mode, and edit mode UI.
 */

type PendingAction = "activating" | "closing" | null;

type ObjectiveFrameRow = {
  id: string;
  owner_user_id: string;

  objective_text: string;
  participation_modes: string[] | null;
  primary_horizon: string | null;
  risk_posture: string | null;

  success_orientation_text: string | null;
  failure_guardrails_text: string | null;

  status: "draft" | "active" | "closed";
  activated_at: string | null;
  closed_at: string | null;

  created_at: string;
  updated_at: string;
};

function rowToViewModel(row: ObjectiveFrameRow): ObjectiveViewModel {
  return {
    id: row.id,
    objectiveText: row.objective_text,
    participationModes: (row.participation_modes ?? []) as any,
    primaryHorizon: (row.primary_horizon ?? undefined) as any,
    riskPosture: (row.risk_posture ?? undefined) as any,
    successOrientationText: row.success_orientation_text ?? undefined,
    failureGuardrailsText: row.failure_guardrails_text ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    activatedAt: row.activated_at ?? undefined,
    closedAt: row.closed_at ?? undefined,
  };
}

function draftToPayload(next: ObjectiveDraftPayload, id?: string) {
  return {
    id,
    objectiveText: next.objectiveText,
    participationModes: next.participationModes ?? [],
    primaryHorizon: next.primaryHorizon,
    riskPosture: next.riskPosture,
    successOrientationText: next.successOrientationText,
    failureGuardrailsText: next.failureGuardrailsText,
  };
}

export default function ObjectivePanelController(props: { readonly?: boolean }) {
  const readonly = props.readonly ?? false;

  const supabase = useMemo(() => createSupabaseBrowser(), []);

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }

  async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
    const token = await getAccessToken();

    const headers = new Headers(init.headers);

    // Attach Authorization only when a real session token exists.
    // In dev mode (no auth plane yet), routes can fall back to TRADERPRO_DEV_OWNER_USER_ID.
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    // Preserve caller-provided content type when present; set JSON when body exists and no content type is set.
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    return fetch(input, { ...init, headers });
  }

  // Committed snapshot used for read mode rendering.
  const [objectiveCommitted, setObjectiveCommitted] =
    useState<ObjectiveViewModel | null>(null);

  // Local edit buffer (exists only while mode === "edit").
  const [objectiveDraft, setObjectiveDraft] =
    useState<ObjectiveDraftPayload | null>(null);

  // Controlled UI state.
  const [mode, setMode] = useState<ObjectiveMode>("read");
  const [status, setStatus] = useState<ObjectiveStatus>("draft");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  const [confirmActivateOpen, setConfirmActivateOpen] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);

  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Derived "objective" passed into ObjectivePanel.
  const objective = useMemo(() => {
    // In later steps, edit mode may render from objectiveDraft instead.
    return objectiveCommitted;
  }, [objectiveCommitted]);

  // Keep status aligned with committed objective when present.
  useEffect(() => {
    if (!objectiveCommitted) return;
    if (objectiveCommitted.status !== status) {
      setStatus(objectiveCommitted.status);
    }
  }, [objectiveCommitted, status]);

  async function refreshFromServer() {
    setErrorMsg(null);
    try {
      const res = await authedFetch("/api/objective/frame", { method: "GET" });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error ?? "Failed to load objective");
      }
      const frame: ObjectiveFrameRow | null = json.frame ?? null;
      if (!frame) {
        setObjectiveCommitted(null);
        setStatus("draft");
        return;
      }
      const vm = rowToViewModel(frame);
      setObjectiveCommitted(vm);
      setStatus(vm.status);
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Failed to load objective");
    }
  }

  useEffect(() => {
    // Hydrate Objective from DB-backed API on mount.
    (async () => {
      setLoading(true);
      await refreshFromServer();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function initDraftFromCommitted() {
    if (!objectiveCommitted) {
      setObjectiveDraft({
        objectiveText: "",
        participationModes: [],
      });
      return;
    }
    setObjectiveDraft({
      objectiveText: objectiveCommitted.objectiveText ?? "",
      participationModes: objectiveCommitted.participationModes ?? [],
      primaryHorizon: objectiveCommitted.primaryHorizon,
      riskPosture: objectiveCommitted.riskPosture,
      successOrientationText: objectiveCommitted.successOrientationText,
      failureGuardrailsText: objectiveCommitted.failureGuardrailsText,
    });
  }

  function handleRequestEdit() {
    if (readonly) return;
    initDraftFromCommitted();
    setMode("edit");
    if (!objectiveCommitted) setStatus("draft");
  }

  function handleCancelEdit() {
    if (readonly) return;
    setObjectiveDraft(null);
    setPendingAction(null);
    setErrorMsg(null);
    setMode("read");
  }

  async function handleSaveDraft(next: ObjectiveDraftPayload) {
    if (readonly) return;

    setErrorMsg(null);
    try {
      const payload = draftToPayload(next, objectiveCommitted?.id);
      const res = await authedFetch("/api/objective/frame", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error ?? "Failed to save draft");
      }

      const frame: ObjectiveFrameRow = json.frame;
      const vm = rowToViewModel(frame);
      setObjectiveCommitted(vm);
      setStatus(vm.status);
      setObjectiveDraft(null);
      setPendingAction(null);
      setMode("read");
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Failed to save draft");
    }
  }

  async function handleActivate(next: ObjectiveDraftPayload) {
    if (readonly) return;

    setErrorMsg(null);

    try {
      // Ensure the frame exists in DB and we have an id for activation.
      const payload = draftToPayload(next, objectiveCommitted?.id);
      const res = await authedFetch("/api/objective/frame", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error ?? "Failed to prepare activation");
      }

      const frame: ObjectiveFrameRow = json.frame;
      const vm = rowToViewModel(frame);

      // Keep committed in sync with the saved draft, and keep a draft buffer for the modal narrative.
      setObjectiveCommitted(vm);
      setStatus(vm.status);
      setObjectiveDraft({
        objectiveText: vm.objectiveText,
        participationModes: vm.participationModes ?? [],
        primaryHorizon: vm.primaryHorizon,
        riskPosture: vm.riskPosture,
        successOrientationText: vm.successOrientationText,
        failureGuardrailsText: vm.failureGuardrailsText,
      });

      setPendingAction("activating");
      setConfirmActivateOpen(true);
      setMode("edit");
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Failed to prepare activation");
    }
  }

  function handleClose(objectiveId: string) {
    if (readonly) return;
    if (!objectiveCommitted || objectiveCommitted.id !== objectiveId) return;

    setPendingAction("closing");
    setConfirmCloseOpen(true);
  }

  function cancelActivate() {
    if (readonly) return;
    setConfirmActivateOpen(false);
    setPendingAction(null);
    // Stay in edit mode with draft intact for further revision.
    setMode("edit");
  }

  function cancelClose() {
    if (readonly) return;
    setConfirmCloseOpen(false);
    setPendingAction(null);
    setMode("read");
  }

  async function confirmActivate() {
    if (readonly) return;

    const frameId = objectiveCommitted?.id;
    if (!frameId) return;

    setErrorMsg(null);

    try {
      const res = await authedFetch("/api/objective/activate", {
        method: "POST",
        body: JSON.stringify({ frameId }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error ?? "Failed to activate objective");
      }

      // Prefer returned frame, then refresh for safety.
      const frame: ObjectiveFrameRow | null = json.frame ?? null;
      if (frame) {
        const vm = rowToViewModel(frame);
        setObjectiveCommitted(vm);
        setStatus(vm.status);
      } else {
        await refreshFromServer();
      }

      setObjectiveDraft(null);
      setPendingAction(null);
      setConfirmActivateOpen(false);
      setMode("read");
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Failed to activate objective");
    }
  }

  async function confirmClose() {
    if (readonly) return;

    const frameId = objectiveCommitted?.id;
    if (!frameId) return;

    setErrorMsg(null);

    try {
      const res = await authedFetch("/api/objective/close", {
        method: "POST",
        body: JSON.stringify({ frameId }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error ?? "Failed to close objective");
      }

      // Prefer returned frame, then refresh for safety.
      const frame: ObjectiveFrameRow | null = json.frame ?? null;
      if (frame) {
        const vm = rowToViewModel(frame);
        setObjectiveCommitted(vm);
        setStatus(vm.status);
      } else {
        await refreshFromServer();
      }

      setObjectiveDraft(null);
      setPendingAction(null);
      setConfirmCloseOpen(false);
      setMode("read");
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Failed to close objective");
    }
  }

  return (
    <>
      {loading ? (
        <div className="text-[11px] text-neutral-500">Loading objective…</div>
      ) : null}

      {errorMsg ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-[11px] text-red-300">
          {errorMsg}
        </div>
      ) : null}

      <ObjectivePanel
        objective={objective}
        mode={mode}
        status={status}
        readonly={readonly}
        onRequestEdit={handleRequestEdit}
        onCancelEdit={handleCancelEdit}
        onSaveDraft={handleSaveDraft}
        onActivate={handleActivate}
        onClose={handleClose}
      />

      {confirmActivateOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={cancelActivate}
          />
          <div className="relative w-[520px] max-w-[92vw] rounded-lg border border-neutral-800 bg-neutral-950 p-4 shadow-xl">
            <div className="text-sm font-medium text-neutral-100">
              Activate this Objective?
            </div>
            <div className="mt-2 text-xs leading-relaxed text-neutral-400">
              Activating sets this Objective as your current cognition frame. This does not place trades or modify strategy.
            </div>

            <div className="mt-3 rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
              <div className="text-[11px] uppercase tracking-wide text-neutral-500">
                Narrative
              </div>
              <div className="mt-2 whitespace-pre-wrap text-sm text-neutral-100">
                {objectiveDraft?.objectiveText ?? ""}
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={cancelActivate}
                className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmActivate}
                className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-100"
              >
                Confirm Activate
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmCloseOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={cancelClose} />
          <div className="relative w-[520px] max-w-[92vw] rounded-lg border border-neutral-800 bg-neutral-950 p-4 shadow-xl">
            <div className="text-sm font-medium text-neutral-100">
              Close this Objective?
            </div>
            <div className="mt-2 text-xs leading-relaxed text-neutral-400">
              Closing archives this Objective. It will no longer be active. This does not place trades or modify strategy.
            </div>

            <div className="mt-3 rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
              <div className="text-[11px] uppercase tracking-wide text-neutral-500">
                Narrative
              </div>
              <div className="mt-2 whitespace-pre-wrap text-sm text-neutral-100">
                {objectiveCommitted?.objectiveText ?? ""}
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={cancelClose}
                className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmClose}
                className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-100"
              >
                Confirm Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}