"use client";

import { useSimulationContext } from "@/lib/sim/SimulationContext";
import {
  DOMAIN,
  READOUT_PLACEHOLDER,
  formatCd,
  formatDragN,
  formatInt,
  formatKPa,
  formatRe,
  formatTriangles,
} from "@/lib/sim/types";

function withUnit(text: string, unit: string): string {
  return text === READOUT_PLACEHOLDER ? text : `${text} ${unit}`;
}

function StatCell({
  label,
  value,
  title,
}: {
  readonly label: string;
  readonly value: string;
  readonly title: string;
}) {
  return (
    <div
      title={title}
      className="flex min-w-0 shrink-0 flex-col justify-center border-l border-neutral-800 px-3 first:border-l-0 first:pl-0"
    >
      <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
        {label}
      </span>
      <span className="truncate text-sm tabular-nums text-neutral-100">
        {value}
      </span>
    </div>
  );
}

/**
 * Live stats bar (F017): FPS, steps/s, drag coefficient + force, pressure
 * extremes, Reynolds number, grid size, particle count, and a stability
 * badge — fed by `SimulationContext` (4 Hz readout assembled by
 * `SimEngine.getReadout()`, model identity filled by the provider).
 * Signature unchanged.
 *
 * SSR-safe: renders placeholders until the first client-side poll resolves.
 */
export function StatsPanel() {
  const { readout, conditionsUnstable } = useSimulationContext();

  // Empty state (spec §4): no model or no run yet → every metric "—" except
  // the grid dims (from DOMAIN) and a gray STABLE badge.
  const modelName = readout?.modelName ?? null;
  const modelTriangles = readout?.modelTriangles ?? null;
  const empty = readout === null || modelName === null;
  const gridDims = readout?.gridDims ?? [DOMAIN.nx, DOMAIN.ny, DOMAIN.nz];
  const stable = readout?.stable ?? true;

  const modelValue =
    modelName === null
      ? READOUT_PLACEHOLDER
      : `${modelName} (${formatTriangles(modelTriangles)} tris)`;

  return (
    <div
      aria-label="Live simulation statistics"
      className="flex h-full items-stretch overflow-x-auto font-mono"
    >
      <StatCell
        label="Model"
        value={modelValue}
        title={
          modelName === null
            ? "No model loaded — upload an OBJ or PLY file"
            : `${modelName} · ${formatTriangles(modelTriangles)} triangles`
        }
      />
      <StatCell
        label="FPS"
        value={empty ? READOUT_PLACEHOLDER : formatInt(readout.fps)}
        title="Display refresh rate in frames per second (not simulation steps)"
      />
      <StatCell
        label="Steps/s"
        value={empty ? READOUT_PLACEHOLDER : formatInt(readout.stepsPerSecond)}
        title="Lattice steps computed per second (FPS × steps-per-frame)"
      />
      <StatCell
        label="Cd (confined)"
        value={empty ? READOUT_PLACEHOLDER : formatCd(readout.cd)}
        title="Drag score for comparing shapes in this tunnel — lower is sleeker. Not comparable to textbook Cd values (walls and coarse grid inflate it)."
      />
      <StatCell
        label="Drag"
        value={
          empty
            ? READOUT_PLACEHOLDER
            : withUnit(formatDragN(readout.dragN), "N")
        }
        title="Drag force in newtons (momentum-exchange, EMA-smoothed)"
      />
      <StatCell
        label="P min"
        value={
          empty
            ? READOUT_PLACEHOLDER
            : withUnit(formatKPa(readout.pMinPa), "kPa")
        }
        title={`Minimum surface pressure (stagnation reference q ≈ ${formatKPa(readout?.qRefPa ?? Number.NaN)} kPa)`}
      />
      <StatCell
        label="P max"
        value={
          empty
            ? READOUT_PLACEHOLDER
            : withUnit(formatKPa(readout.pMaxPa), "kPa")
        }
        title={`Maximum surface pressure (stagnation reference q ≈ ${formatKPa(readout?.qRefPa ?? Number.NaN)} kPa)`}
      />
      <StatCell
        label="Re (nominal)"
        value={empty ? READOUT_PLACEHOLDER : formatRe(readout.re)}
        title={
          conditionsUnstable
            ? "Nominal Reynolds number U·L/ν from the physical conditions. Stability assist is active, so the solver runs on assist viscosity — the effective simulated Re is far lower (laminar regime)."
            : "Nominal Reynolds number U·L/ν from the current physical conditions — the lattice may resolve a lower effective Re."
        }
      />
      <StatCell
        label="Grid"
        value={`${gridDims[0]}×${gridDims[1]}×${gridDims[2]}`}
        title="Lattice grid dimensions in cells (X×Y×Z)"
      />
      <StatCell
        label="Particles"
        value={empty ? READOUT_PLACEHOLDER : formatInt(readout.activeParticles)}
        title="Live particles in the simulation pool"
      />
      <div className="ml-auto flex shrink-0 items-center pl-3">
        {empty || stable ? (
          <span
            title={
              empty
                ? "No model running — showing placeholders"
                : "Solver stable: no NaN or negative-density cells detected"
            }
            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
              empty
                ? "border-neutral-700 text-neutral-500"
                : "border-green-800 bg-green-950 text-green-400"
            }`}
          >
            Stable
          </span>
        ) : (
          <span
            title="The math diverged — the app resets the flow automatically."
            className="animate-pulse rounded-full border border-red-800 bg-red-950 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-400"
          >
            Unstable
          </span>
        )}
      </div>
    </div>
  );
}
