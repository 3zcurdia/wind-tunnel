"use client";

import { UploadPanel } from "@/components/controls/UploadPanel";
import { ControlPanel } from "@/components/controls/ControlPanel";
import { StatsPanel } from "@/components/controls/StatsPanel";
import { Toasts } from "@/components/ui/Toast";
import ViewportMount from "@/components/viewport/ViewportMount";
import { useSimulation } from "@/lib/hooks/useSimulation";
import { ModelProvider, useModel } from "@/lib/sim/ModelContext";
import {
  SimulationProvider,
  useSimulationContext,
} from "@/lib/sim/SimulationContext";

/** Runs the F019 frame loop + model pipeline once (null render). */
function SimulationLoopHost() {
  useSimulation();
  return null;
}

function ControlsRail() {
  const sim = useSimulationContext();
  const { file, meta } = useModel();
  const hasModel = file !== null && meta !== undefined;

  return (
    <div className="w-80 shrink-0 space-y-4 overflow-y-auto pr-1">
      <UploadPanel />
      <ControlPanel
        conditions={sim.conditions}
        setConditions={sim.setConditions}
        transport={sim.transport}
        controlsDisabled={!sim.ready || !hasModel}
        conditionsUnstable={sim.conditionsUnstable}
        engineError={sim.error}
      />
    </div>
  );
}

function ViewportPane() {
  const { ready, error } = useSimulationContext();

  return (
    <div className="relative min-h-[70vh] flex-1 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900">
      <ViewportMount />
      {!ready ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-neutral-900/80">
          <span className="flex items-center gap-2 text-xs text-neutral-300">
            <span
              aria-hidden="true"
              className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-500 border-t-transparent"
            />
            Loading engine…
          </span>
          {error !== null ? (
            <p role="alert" className="max-w-sm text-center text-[11px] text-red-400">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Shell() {
  const { toasts, dismissToast } = useSimulationContext();

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
        <h1 className="text-sm font-semibold tracking-wide">Wind Tunnel</h1>
        <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
          ※ demo placeholder
        </span>
      </header>
      <main className="flex min-h-0 flex-1 gap-4 p-4">
        <ControlsRail />
        <ViewportPane />
      </main>
      <footer className="h-16 shrink-0 border-t border-neutral-800 px-4 py-2">
        <StatsPanel />
      </footer>
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export default function Home() {
  return (
    <ModelProvider>
      <SimulationProvider>
        <SimulationLoopHost />
        <Shell />
      </SimulationProvider>
    </ModelProvider>
  );
}
