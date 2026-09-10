"use client";

import { useState } from "react";
import { useSimulationContext } from "@/lib/sim/SimulationContext";
import {
  QUALITY_LEVELS,
  QUALITY_PRESETS,
  type QualityLevel,
} from "@/lib/sim/quality";

function SectionTitle({ children }: { readonly children: string }) {
  return (
    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
      {children}
    </h3>
  );
}

/**
 * Quality switch (F021 §3): segmented Low/Medium/High control. Picking a
 * different tier stages it as pending and shows the inline confirm ("Changes
 * grid — re-simulates from scratch. [Apply] [Cancel]") — Apply commits via
 * `context.setQuality` (engine re-init, no reload), Cancel drops the pending
 * pick without touching wasm. Lives outside the disabled fieldset (like
 * Transport): switching with no model loaded is a valid empty-tunnel re-init.
 */
export function QualitySection() {
  const { ready, quality, setQuality } = useSimulationContext();
  const [pending, setPending] = useState<QualityLevel | null>(null);
  const [applying, setApplying] = useState(false);
  const [failed, setFailed] = useState(false);

  const staged = pending !== null && pending !== quality;
  const active = pending ?? quality;
  const spec = QUALITY_PRESETS[active] ?? QUALITY_PRESETS.medium;
  const disabled = !ready || applying;

  async function handleApply(): Promise<void> {
    if (pending === null || pending === quality) {
      setPending(null);
      return;
    }
    const target = pending;
    setApplying(true);
    setFailed(false);
    try {
      await setQuality(target);
    } finally {
      setPending(null);
      setApplying(false);
    }
  }

  function handleCancel(): void {
    if (!applying) {
      setPending(null);
      setFailed(false);
    }
  }

  return (
    <section>
      <SectionTitle>Quality</SectionTitle>
      <div
        role="group"
        aria-label="Simulation quality"
        className="flex gap-1 rounded-md border border-neutral-800 bg-neutral-900 p-1"
      >
        {QUALITY_LEVELS.map((level) => {
          const selected = level === quality && pending === null;
          const stagedHere = level === pending;
          return (
            <button
              key={level}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => {
                setFailed(false);
                setPending(level === quality ? null : level);
              }}
              className={`flex-1 rounded px-2 py-1 text-xs font-medium ${
                selected
                  ? "bg-blue-600 text-white"
                  : stagedHere
                    ? "bg-amber-600 text-white"
                    : "bg-transparent text-neutral-300 hover:bg-neutral-800"
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {QUALITY_PRESETS[level]?.label ?? level}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-[11px] text-neutral-500">
        {spec.grid.nx}×{spec.grid.ny}×{spec.grid.nz} ·{" "}
        {(spec.particles / 1000).toFixed(0)}k particles · {spec.smokeTracers}{" "}
        smoke — {spec.note}
      </p>
      {staged ? (
        <div className="mt-2 rounded-md border border-amber-800 bg-amber-950 px-2 py-1.5">
          <p className="text-[11px] text-amber-300">
            Changes grid — re-simulates from scratch.
          </p>
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                void handleApply().catch(() => {
                  setFailed(true);
                });
              }}
              className="flex-1 rounded-md border border-amber-700 bg-amber-800 px-2 py-1 text-[11px] font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {applying ? "Applying…" : "Apply"}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={handleCancel}
              className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1 text-[11px] font-medium text-neutral-100 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {failed ? (
        <p role="alert" className="mt-1 text-[11px] text-red-400">
          Quality change failed — engine unavailable, retry shortly.
        </p>
      ) : null}
    </section>
  );
}
