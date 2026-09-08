"use client";

import { useState } from "react";
import {
  SMOKE_HALF_WIDTH_MAX,
  SMOKE_HALF_WIDTH_MIN,
  SMOKE_HISTORY_DEFAULT,
  SMOKE_HISTORY_MAX,
  SMOKE_HISTORY_MIN,
  SMOKE_RAKE_Y_MAX,
  SMOKE_RAKE_Y_MIN,
  getSmokeEnabled,
  getSmokeHistoryLen,
  getSmokeRake,
  setSmokeEnabled,
  setSmokeHistoryLen,
  setSmokeRake,
} from "@/lib/sim/voxelBridge";

/**
 * TEMPORARY smoke-tracer controls (F016 §2; relocated by F018/F020).
 * Toggle + rake-height / rake-width sliders + trail-length input, all routed
 * live through the voxelBridge smoke backend (re-seed / rebuild). Deleted in
 * F019.
 */
export function SmokeControls() {
  const [enabled, setEnabled] = useState(getSmokeEnabled);
  const [rake, setRake] = useState(getSmokeRake);
  const [historyLen, setHistoryLen] = useState(getSmokeHistoryLen);

  function handleRakeHeight(event: React.ChangeEvent<HTMLInputElement>): void {
    const y = Number(event.target.value);
    setRake(setSmokeRake(y, rake.zCenter, rake.halfWidth));
  }

  function handleRakeWidth(event: React.ChangeEvent<HTMLInputElement>): void {
    const halfWidth = Number(event.target.value);
    setRake(setSmokeRake(rake.yCenter, rake.zCenter, halfWidth));
  }

  function handleHistoryLen(
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    const n = Number(event.target.value);
    if (!Number.isFinite(n)) {
      setHistoryLen(SMOKE_HISTORY_DEFAULT);
      return;
    }
    setHistoryLen(setSmokeHistoryLen(n));
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
          checked={enabled}
          onChange={(event) => {
            const on = event.target.checked;
            setEnabled(on);
            setSmokeEnabled(on);
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
          y&nbsp;=&nbsp;{rake.yCenter.toFixed(0)}
        </span>
      </div>
      <input
        id="smoke-rake-height"
        type="range"
        min={SMOKE_RAKE_Y_MIN}
        max={SMOKE_RAKE_Y_MAX}
        step={1}
        value={Math.round(rake.yCenter)}
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
          ±&nbsp;{rake.halfWidth.toFixed(0)}
        </span>
      </div>
      <input
        id="smoke-rake-width"
        type="range"
        min={SMOKE_HALF_WIDTH_MIN}
        max={SMOKE_HALF_WIDTH_MAX}
        step={1}
        value={Math.round(rake.halfWidth)}
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
          value={historyLen}
          onChange={handleHistoryLen}
          className="w-20 rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-right text-xs text-neutral-300"
        />
      </div>
    </div>
  );
}
