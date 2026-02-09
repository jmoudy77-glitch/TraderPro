"use client";

import RailPanelFrame from "@/components/RailPanelFrame";
import { useEffect, useMemo, useState } from "react";

export type ObjectiveStatus = "draft" | "active" | "closed";
export type ObjectiveMode = "read" | "edit";

export type ObjectiveViewModel = {
  id: string;
  objectiveText: string;

  participationModes?: Array<"intraday" | "swing" | "position" | "observe">;
  primaryHorizon?: "intraday" | "swing" | "position" | "mixed";
  riskPosture?: "conservative" | "balanced" | "aggressive";

  successOrientationText?: string;
  failureGuardrailsText?: string;

  status: ObjectiveStatus;

  createdAt?: string;
  activatedAt?: string;
  closedAt?: string;
};

export type ObjectiveDraftPayload = {
  objectiveText: string;
  participationModes?: ObjectiveViewModel["participationModes"];
  primaryHorizon?: ObjectiveViewModel["primaryHorizon"];
  riskPosture?: ObjectiveViewModel["riskPosture"];
  successOrientationText?: string;
  failureGuardrailsText?: string;
};

type Props = {
  objective: ObjectiveViewModel | null;
  mode: ObjectiveMode; // controlled by parent
  status: ObjectiveStatus; // controlled by parent
  readonly?: boolean;

  onRequestEdit: () => void;
  onCancelEdit: () => void;
  onSaveDraft: (next: ObjectiveDraftPayload) => void;
  onActivate: (next: ObjectiveDraftPayload) => void;
  onClose: (objectiveId: string) => void;
};

export default function ObjectivePanel(props: Props) {
  const { objective, status, readonly, mode } = props;

  // Local edit buffer for UI (parent controls mode/status; panel controls field editing UI).
  const [draft, setDraft] = useState<ObjectiveDraftPayload | null>(null);

  const draftSeed = useMemo<ObjectiveDraftPayload>(() => {
    if (!objective) {
      return {
        objectiveText: "",
        participationModes: [],
      };
    }
    return {
      objectiveText: objective.objectiveText ?? "",
      participationModes: objective.participationModes ?? [],
      primaryHorizon: objective.primaryHorizon,
      riskPosture: objective.riskPosture,
      successOrientationText: objective.successOrientationText,
      failureGuardrailsText: objective.failureGuardrailsText,
    };
  }, [objective]);

  useEffect(() => {
    if (mode !== "edit") {
      setDraft(null);
      return;
    }
    setDraft((prev) => prev ?? draftSeed);
  }, [mode, draftSeed]);

  return (
    <RailPanelFrame
      title="Objective"
      subtitle="Trader identity & participation frame"
      rightSlot={
        <div className="flex items-center gap-2">
          <div className="text-[11px] tracking-wide text-neutral-400">
            {status.toUpperCase()}
          </div>

          {mode === "edit" ? (
            <button
              type="button"
              disabled={readonly}
              onClick={props.onCancelEdit}
              className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 disabled:opacity-40"
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              disabled={readonly || (!objective && status !== "draft")}
              onClick={props.onRequestEdit}
              className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 disabled:opacity-40"
            >
              Edit
            </button>
          )}
        </div>
      }
      scrollBody={false}
    >
      <div className="min-h-0 flex h-full flex-col">
        <div className="mt-1 min-h-0 flex-1">
          {mode === "edit" ? (
            <EditMode
              readonly={readonly}
              draft={draft}
              onChange={setDraft}
              onSaveDraft={props.onSaveDraft}
              onActivate={props.onActivate}
              onCancel={props.onCancelEdit}
            />
          ) : !objective ? (
            <EmptyState disabled={readonly} onCreate={props.onRequestEdit} />
          ) : (
            <ReadMode objective={objective} />
          )}
        </div>
      </div>
    </RailPanelFrame>
  );
}

function EmptyState(props: { disabled?: boolean; onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col justify-center gap-3 rounded-md border border-neutral-800 p-4 text-neutral-300">
      <div className="text-sm font-medium text-neutral-200">No Objective set</div>
      <div className="text-xs leading-relaxed text-neutral-400">
        Create a narrative Objective that describes what kind of trader you are being right now
        (participation frame), not tactics or trade instructions.
      </div>
      <div>
        <button
          type="button"
          disabled={props.disabled}
          onClick={props.onCreate}
          className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-200 disabled:opacity-40"
        >
          Create Objective
        </button>
      </div>
    </div>
  );
}

function ReadMode({ objective }: { objective: ObjectiveViewModel }) {
  return (
    <div className="flex min-h-0 flex-col gap-3">
      {/* Narrative (primary) */}
      <div className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-100">
        {objective.objectiveText}
      </div>

      {/* Orientation fields (tertiary; quiet) */}
      <div className="flex flex-wrap gap-2 text-[11px] text-neutral-400">
        {objective.participationModes?.length ? (
          <Tag label={`Modes: ${objective.participationModes.join(", ")}`} />
        ) : null}
        {objective.primaryHorizon ? <Tag label={`Horizon: ${objective.primaryHorizon}`} /> : null}
        {objective.riskPosture ? <Tag label={`Risk: ${objective.riskPosture}`} /> : null}
      </div>

      {/* Broad success / guardrails (quaternary; quiet, no metric emphasis) */}
      {(objective.successOrientationText || objective.failureGuardrailsText) ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-3 text-xs text-neutral-300">
          {objective.successOrientationText ? (
            <div className="mb-2">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500">
                Success orientation
              </div>
              <div className="whitespace-pre-wrap">{objective.successOrientationText}</div>
            </div>
          ) : null}

          {objective.failureGuardrailsText ? (
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500">
                Failure guardrails
              </div>
              <div className="whitespace-pre-wrap">{objective.failureGuardrailsText}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Tag({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-neutral-800 bg-neutral-900/50 px-2 py-1">
      {label}
    </span>
  );
}

function EditMode(props: {
  readonly?: boolean;
  draft: ObjectiveDraftPayload | null;
  onChange: (next: ObjectiveDraftPayload | null) => void;
  onSaveDraft: (next: ObjectiveDraftPayload) => void;
  onActivate: (next: ObjectiveDraftPayload) => void;
  onCancel: () => void;
}) {
  const d =
    props.draft ??
    ({
      objectiveText: "",
      participationModes: [],
    } as ObjectiveDraftPayload);

  function update<K extends keyof ObjectiveDraftPayload>(key: K, value: ObjectiveDraftPayload[K]) {
    props.onChange({ ...d, [key]: value });
  }

  const canSubmit = d.objectiveText.trim().length > 0;

  return (
    <div className="flex min-h-0 h-full flex-col gap-3">
      <div className="text-[11px] uppercase tracking-wide text-neutral-500">
        Editing Objective
      </div>

      <div className="min-h-0 flex-1">
        <label className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-500">
          Narrative
        </label>
        <textarea
          value={d.objectiveText}
          onChange={(e) => update("objectiveText", e.target.value)}
          disabled={props.readonly}
          rows={8}
          className="h-full w-full resize-none rounded-md border border-neutral-800 bg-neutral-950 p-3 text-sm text-neutral-100 outline-none disabled:opacity-50"
          placeholder="Describe your participation frame and philosophy. Avoid tactics."
        />
      </div>

      <div className="flex flex-wrap gap-2 text-[11px] text-neutral-400">
        <select
          disabled={props.readonly}
          value={d.primaryHorizon ?? ""}
          onChange={(e) =>
            update("primaryHorizon", (e.target.value || undefined) as ObjectiveDraftPayload["primaryHorizon"])
          }
          className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-200 disabled:opacity-50"
        >
          <option value="">Primary horizon…</option>
          <option value="intraday">Intraday</option>
          <option value="swing">Swing</option>
          <option value="position">Position</option>
          <option value="mixed">Mixed</option>
        </select>

        <select
          disabled={props.readonly}
          value={d.riskPosture ?? ""}
          onChange={(e) =>
            update("riskPosture", (e.target.value || undefined) as ObjectiveDraftPayload["riskPosture"])
          }
          className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-200 disabled:opacity-50"
        >
          <option value="">Risk posture…</option>
          <option value="conservative">Conservative</option>
          <option value="balanced">Balanced</option>
          <option value="aggressive">Aggressive</option>
        </select>
      </div>

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          disabled={props.readonly}
          onClick={props.onCancel}
          className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-200 disabled:opacity-40"
        >
          Cancel
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={props.readonly || !canSubmit}
            onClick={() => props.onSaveDraft(d)}
            className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-200 disabled:opacity-40"
            title={!canSubmit ? "Narrative is required" : undefined}
          >
            Save Draft
          </button>

          <button
            type="button"
            disabled={props.readonly || !canSubmit}
            onClick={() => props.onActivate(d)}
            className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-100 disabled:opacity-40"
            title={!canSubmit ? "Narrative is required" : undefined}
          >
            Activate
          </button>
        </div>
      </div>

      <div className="text-[11px] text-neutral-500">
        Activation requires confirmation (handled by the parent controller).
      </div>
    </div>
  );
}