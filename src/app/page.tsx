import AppShell from "@/components/shell/AppShell";
import HeldChartsGrid from "@/components/charts/HeldChartsGrid";
import IndustryPostureGrid from "@/components/industry/IndustryPostureGrid";
import WatchlistsPanel from "@/components/watchlists/WatchlistsPanel";
import NotesPanel from "@/components/panels/NotesPanel";
import StrategyPanel from "@/components/panels/StrategyPanel";
import ObjectivePanelController from "@/components/panels/ObjectivePanelController";
import { ChartStateProvider } from "@/components/state/ChartStateProvider";

export default function Home() {
  return (
    <ChartStateProvider>
      <AppShell>
        <div className="grid h-[calc(100vh-56px)] min-h-0 grid-cols-12 grid-rows-[minmax(0,1fr)] gap-3 p-3 pb-6">
          <div className="col-span-3 flex min-h-0 flex-col">
            <WatchlistsPanel />
          </div>

          <div className="col-span-6 flex min-h-0 flex-col gap-3">
            <div className="flex-none">
              <IndustryPostureGrid />
            </div>
            <div className="min-h-0 flex-1">
              <HeldChartsGrid />
            </div>
          </div>

          <div className="col-span-3 flex min-h-0 flex-col gap-3">
            <div className="min-h-0 flex-1">
              <ObjectivePanelController />
            </div>
            <div className="min-h-0 flex-1">
              <StrategyPanel />
            </div>
            <div className="min-h-0 flex-1">
              <NotesPanel />
            </div>
          </div>
        </div>
      </AppShell>
    </ChartStateProvider>
  );
}