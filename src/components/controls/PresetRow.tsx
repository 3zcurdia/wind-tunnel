"use client";

import {
  FLOW_PRESETS,
  matchPreset,
  type FlowConditions,
} from "@/lib/sim/conditions";

/**
 * Scenario preset buttons (F026 §3): a 2×2 grid of one-click conditions.
 * Clicking a button just calls `setConditions` with a copy of the preset's
 * values — the F019 context owns debounce and the viscosity soft-restart.
 *
 * The active (exactly matched) preset renders blue; any slider nudge changes
 * `conditions`, the matcher returns null, and the caption falls back to the
 * "Custom conditions" line. The subsonic-envelope note is always visible.
 */
export function PresetRow({
  conditions,
  setConditions,
}: {
  readonly conditions: FlowConditions;
  readonly setConditions: (next: FlowConditions) => void;
}) {
  const activeId = matchPreset(conditions);
  const active = FLOW_PRESETS.find((preset) => preset.id === activeId) ?? null;

  return (
    <div>
      <div className="grid grid-cols-2 gap-1">
        {FLOW_PRESETS.map((preset) => {
          const selected = preset.id === activeId;
          return (
            <button
              key={preset.id}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setConditions({ ...preset.conditions });
              }}
              className={`rounded-md border border-neutral-800 px-2 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
                selected
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] text-neutral-400">
        {active !== null
          ? active.caption
          : "Custom conditions — pick a scenario or keep tuning."}
      </p>
      <p className="mt-2 text-[11px] text-neutral-600">
        Why no jet or supersonic? This tunnel simulates subsonic air only —
        shock waves and compressibility are beyond its physics, so we won&apos;t
        pretend.
      </p>
    </div>
  );
}
