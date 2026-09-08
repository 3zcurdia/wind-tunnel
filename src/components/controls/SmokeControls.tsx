"use client";

import {
  SMOKE_HALF_WIDTH_MAX,
  SMOKE_HALF_WIDTH_MIN,
  SMOKE_HISTORY_DEFAULT,
  SMOKE_HISTORY_MAX,
  SMOKE_HISTORY_MIN,
  SMOKE_RAKE_Y_MAX,
  SMOKE_RAKE_Y_MIN,
} from "@/lib/sim/SimEngine";
import { useSimulationContext } from "@/lib/sim/SimulationContext";

/**
 * Smoke-tracer controls (F016 §2; owned by `SimulationContext` since F019).
 * Toggle + rake-height / rake-width sliders + trail-length input, all routed
 * live through the context (the loop applies rake/history to the live rake;
 * the toggle gates the frame update). Signature unchanged.
 */
export function SmokeControls() {
  const {
    smokeEnabled,
    setSmokeEnabled,
    smokeRake,
    setSmokeRake,
    smokeHistoryLen,
    setSmokeHistoryLen,
  } = useSimulationContext();

  function handleRakeHeight(event: React.ChangeEvent<HTMLInputElement>): void {
    const y = Number(event.target.value);
    setSmokeRake(y, smokeRake.zCenter, smokeRake.halfWidth);
  }

  function handleRakeWidth(event: React.ChangeEvent<HTMLInputElement>): void {
    const halfWidth = Number(event.target.value);
    setSmokeRake(smokeRake.yCenter, smokeRake.zCenter, halfWidth);
  }

  function handleHistoryLen(
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    const n = Number(event.target.value);
    if (!Number.isFinite(n)) {
      setSmokeHistoryLen(SMOKE_HISTORY_DEFAULT);
      return;
    }
    setSmokeHistoryLen(n);
  }

  return (
    <div>
      <label
        htmlFor="smoke-toggle"
        className="mb-2 flex cursor-pointer items-center gap-2 text-xs font-medium text-neutral-300"
      >
        <input
          id="smoke-toggle"
          type="checkbox"
          checked={smokeEnabled}
          onChange={(event) => {
            setSmokeEnabled(event.target.checked);
          }}
          className="accent-blue-500"
        />
        Smoke tracers
      </label>
      <div className="mb-1 flex items-center justify-between">
        <label
          htmlFor="smoke-rake-height"
          className="text-xs font-medium text-neutral-300"
        >
          Rake height
        </label>
        <span className="text-xs text-neutral-500">
          y&nbsp;=&nbsp;{smokeRake.yCenter.toFixed(0)}
        </span>
      </div>
      <input
        id="smoke-rake-height"
        type="range"
        min={SMOKE_RAKE_Y_MIN}
        max={SMOKE_RAKE_Y_MAX}
        step={1}
        value={Math.round(smokeRake.yCenter)}
        onChange={handleRakeHeight}
        className="w-full accent-blue-500"
      />
      <div className="mb-1 mt-2 flex items-center justify-between">
        <label
          htmlFor="smoke-rake-width"
          className="text-xs font-medium text-neutral-300"
        >
          Rake width
        </label>
        <span className="text-xs text-neutral-500">
          ±&nbsp;{smokeRake.halfWidth.toFixed(0)}
        </span>
      </div>
      <input
        id="smoke-rake-width"
        type="range"
        min={SMOKE_HALF_WIDTH_MIN}
        max={SMOKE_HALF_WIDTH_MAX}
        step={1}
        value={Math.round(smokeRake.halfWidth)}
        onChange={handleRakeWidth}
        className="w-full accent-blue-500"
      />
      <div className="mb-1 mt-2 flex items-center justify-between">
        <label
          htmlFor="smoke-trail-length"
          className="text-xs font-medium text-neutral-300"
        >
          Trail length
        </label>
        <input
          id="smoke-trail-length"
          type="number"
          min={SMOKE_HISTORY_MIN}
          max={SMOKE_HISTORY_MAX}
          step={1}
          value={smokeHistoryLen}
          onChange={handleHistoryLen}
          className="w-20 rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-right text-xs text-neutral-300"
        />
      </div>
    </div>
  );
}
