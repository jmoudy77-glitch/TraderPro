export default function StrategyPanel() {
  return (
    <section className="flex h-full min-h-0 flex-col rounded-lg border border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <div className="text-sm font-medium">Strategy</div>
        <div className="text-xs text-neutral-500">Canonical contract</div>
      </div>

      <div className="min-h-0 flex-1 p-3">
        <div className="flex h-full flex-col gap-3 rounded border border-dashed border-neutral-800 p-3">
          <div className="text-xs text-neutral-500">
            Strategy panel placeholder. Structured, validate → activate.
          </div>

          <div className="mt-auto flex items-center justify-between">
            <div className="text-[11px] text-neutral-500">
              Status: DRAFT (placeholder)
            </div>
            <button
              className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200"
              type="button"
              disabled
              title="Activation wired after validation + auth"
            >
              Activate
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}