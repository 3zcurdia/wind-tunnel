"use client";

import { UploadPanel } from "@/components/controls/UploadPanel";
import { Panel } from "@/components/ui/Panel";
import { WasmProbe } from "@/components/ui/WasmProbe";
import ViewportMount from "@/components/viewport/ViewportMount";
import { useModelPipeline } from "@/lib/hooks/useModelPipeline";
import { ModelProvider } from "@/lib/sim/ModelContext";

function ModelPipelineHost() {
  useModelPipeline();
  return null;
}

export default function Home() {
  return (
    <ModelProvider>
      <ModelPipelineHost />
      <div className="flex h-screen flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
          <h1 className="text-sm font-semibold tracking-wide">Wind Tunnel</h1>
          <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
            ※ demo placeholder
          </span>
        </header>
        <main className="flex flex-1 gap-4 p-4">
          <Panel title="Controls" className="w-80 shrink-0">
            <div className="space-y-4">
              <p className="text-xs text-neutral-500">
                Upload + tuning controls wire in F004 / F018.
              </p>
              <UploadPanel />
              <WasmProbe />
            </div>
          </Panel>
          <div className="min-h-[70vh] flex-1 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900">
            <ViewportMount />
          </div>
        </main>
        <footer className="h-28 shrink-0 border-t border-neutral-800 p-4">
          <Panel title="Stats" className="h-full">
            <p className="text-xs text-neutral-500">
              Live stats wire in F017.
            </p>
          </Panel>
        </footer>
      </div>
    </ModelProvider>
  );
}
