"use client";

import { useState } from "react";
import {
  PARTICLE_COUNT_DEFAULT,
  PARTICLE_COUNT_MAX,
  PARTICLE_COUNT_MIN,
  PARTICLE_COUNT_STEP,
  setParticleCount,
} from "@/lib/sim/voxelBridge";

/**
 * TEMPORARY particle-count slider (F014 §3; relocated by F018/F019).
 * 5k–100k in 5k steps → `voxelBridge.setParticleCount` (wasm
 * `spawn_particles` + driver top-up target). Deleted in F019.
 */
export function ParticleCountSlider() {
  const [value, setValue] = useState(PARTICLE_COUNT_DEFAULT);
  const [failed, setFailed] = useState(false);

  function handleChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const next = Number(event.target.value);
    setValue(next);
    setFailed(false);
    void setParticleCount(next).then(
      (actual) => {
        setValue(actual);
      },
      () => {
        setFailed(true);
      },
    );
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label
          htmlFor="particle-count"
          className="text-xs font-medium text-neutral-300"
        >
          Particles
        </label>
        <span className="text-xs text-neutral-500">
          {(value / 1000).toFixed(0)}k
        </span>
      </div>
      <input
        id="particle-count"
        type="range"
        min={PARTICLE_COUNT_MIN}
        max={PARTICLE_COUNT_MAX}
        step={PARTICLE_COUNT_STEP}
        value={value}
        onChange={handleChange}
        className="w-full accent-blue-500"
      />
      {failed ? (
        <p className="mt-1 text-[11px] text-red-400">
          Count change failed — engine unavailable, retry shortly.
        </p>
      ) : null}
    </div>
  );
}
