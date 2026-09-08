"use client";

import { useState } from "react";
import {
  PARTICLE_COUNT_MAX,
  PARTICLE_COUNT_MIN,
  PARTICLE_COUNT_STEP,
} from "@/lib/sim/SimEngine";
import { useSimulationContext } from "@/lib/sim/SimulationContext";

/**
 * Particle-count slider (F014 §3; owned by `SimulationContext` since F019).
 * 5k–100k in 5k steps → context `setParticleCount` (engine
 * `spawn_particles` + loop top-up target). Signature unchanged.
 */
export function ParticleCountSlider() {
  const { particleCount, setParticleCount } = useSimulationContext();
  const [failed, setFailed] = useState(false);

  function handleChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const next = Number(event.target.value);
    setFailed(false);
    try {
      setParticleCount(next);
    } catch {
      setFailed(true);
    }
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
          {(particleCount / 1000).toFixed(0)}k
        </span>
      </div>
      <input
        id="particle-count"
        type="range"
        min={PARTICLE_COUNT_MIN}
        max={PARTICLE_COUNT_MAX}
        step={PARTICLE_COUNT_STEP}
        value={particleCount}
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
