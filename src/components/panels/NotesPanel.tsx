export default function NotesPanel() {
  return (
    <section className="flex h-full min-h-0 flex-col rounded-lg border border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <div className="text-sm font-medium">Notes</div>
        <div className="text-xs text-neutral-500">Human cognition</div>
      </div>

      <div className="min-h-0 flex-1 p-3">
        <div className="h-full rounded border border-dashed border-neutral-800 p-3 text-xs text-neutral-500">
          Notes editor placeholder. Unstructured, not enforceable.
        </div>
      </div>
    </section>
  );
}