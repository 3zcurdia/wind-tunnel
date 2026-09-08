"use client";

import { Panel } from "@/components/ui/Panel";
import { SAMPLES } from "@/lib/mesh/samples";
import { useModel } from "@/lib/sim/ModelContext";

/**
 * Built-in sample models (F023): procedural bodies that flow the moment
 * they're clicked. Uploads and samples converge in `useSimulation` at
 * "normalized geometry ready" — `ModelContext` keeps them mutually
 * exclusive, so picking a file deselects the gallery automatically.
 */
export function SampleGallery() {
  const { sample: activeSample, loadSample } = useModel();

  return (
    <Panel title="Samples">
      <p className="mb-2 text-xs text-neutral-500">
        No file on hand? Start with a built-in body.
      </p>
      <div className="space-y-2">
        {SAMPLES.map((def) => {
          const active = def.id === activeSample;
          return (
            <button
              key={def.id}
              type="button"
              onClick={() => loadSample(def.id)}
              aria-pressed={active}
              className={[
                "w-full rounded-md border p-2 text-left transition-colors",
                active
                  ? "border-blue-500/60 bg-blue-500/10"
                  : "border-neutral-800 bg-neutral-950 hover:border-neutral-600",
              ].join(" ")}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-neutral-100">
                  {def.label}
                </span>
                {active ? (
                  <span className="shrink-0 rounded-full border border-blue-500/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-300">
                    active
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 block text-xs text-neutral-400">
                {def.description}
              </span>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}
