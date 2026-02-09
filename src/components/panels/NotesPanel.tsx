import RailPanelFrame from "@/components/RailPanelFrame";

export default function NotesPanel() {
  return (
    <RailPanelFrame
      title="Notes"
      rightSlot={<div className="text-xs text-neutral-500">Human cognition</div>}
    >
      <div className="h-full rounded border border-dashed border-neutral-800 p-3 text-xs text-neutral-500">
        Notes editor placeholder. Unstructured, not enforceable.
      </div>
    </RailPanelFrame>
  );
}