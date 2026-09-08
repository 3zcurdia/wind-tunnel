"use client";

import { useEffect } from "react";
import { Panel } from "@/components/ui/Panel";
import { Slider } from "@/components/ui/Slider";
import { ParticleCountSlider } from "@/components/controls/ParticleCountSlider";
import { PressureLegend } from "@/components/controls/PressureLegend";
import { SmokeControls } from "@/components/controls/SmokeControls";
import { useSimulationContext } from "@/lib/sim/SimulationContext";
import {
  AIR_PRESSURE_RANGE,
  DEFAULT_CHAR_LEN_M,
  VISCOSITY_COEF_RANGE,
  WIND_SPEED_RANGE,
  derivedValues,
  viscosityCoefToPas,
  viscosityPasToCoef,
  type FlowConditions,
} from "@/lib/sim/conditions";
import { formatRe } from "@/lib/sim/types";

/**
 * Transport controls (F018 contract shape — `SimulationContext.transport`
 * provides this object; `page.tsx` wires it through).
 */
export interface TransportApi {
  readonly running: boolean;
  toggleRun(): void;
  resetFlow(): void;
  resetAll(): void;
}

export interface ControlPanelProps {
  /** Controlled slider state (F019: `context.conditions`). */
  readonly conditions: FlowConditions;
  /** Commit a new operating point (F019: `context.setConditions`, debounced). */
  readonly setConditions: (next: FlowConditions) => void;
  /** Run/pause/reset controls (F019: `context.transport`). */
  readonly transport: TransportApi;
  /** True while wasm loads or no model is present (transport stays live). */
  readonly controlsDisabled: boolean;
  /** True when the last committed point needed τ clamping (ARCH §6 warning). */
  readonly conditionsUnstable: boolean;
  /** Last backend failure, if any (cleared on the next success). */
  readonly engineError: string | null;
}

function SectionTitle({ children }: { readonly children: string }) {
  return (
    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
      {children}
    </h3>
  );
}

function DerivedCell({
  label,
  value,
  title,
}: {
  readonly label: string;
  readonly value: string;
  readonly title: string;
}) {
  return (
    <div title={title}>
      <p className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
        {label}
      </p>
      <p className="text-sm tabular-nums text-neutral-100">{value}</p>
    </div>
  );
}

/** Scientific notation with 3 significant digits, `+`-stripped like `formatRe`. */
function formatNu(nuM2S: number): string {
  if (!Number.isFinite(nuM2S)) return "—";
  return nuM2S.toExponential(2).replace("e+", "e");
}

/**
 * Heatmap visibility + legend (F015's toggle + legend, fed by
 * `SimulationContext` since F019: the 4 Hz readout carries the same anchors
 * the deleted bridge pushed — full layer toggles remain F020's job).
 */
function LayersSection() {
  const { heatmapEnabled, setHeatmapEnabled, readout } =
    useSimulationContext();
  const anchors = readout ?? { pMinPa: 0, pMaxPa: 0, qRefPa: 0 };

  return (
    <section>
      <SectionTitle>Layers</SectionTitle>
      <label
        htmlFor="heatmap-toggle"
        className="mb-2 flex cursor-pointer items-center gap-2 text-xs font-medium text-neutral-300"
      >
        <input
          id="heatmap-toggle"
          type="checkbox"
          checked={heatmapEnabled}
          onChange={(event) => {
            setHeatmapEnabled(event.target.checked);
          }}
          className="accent-blue-500"
        />
        Surface pressure
      </label>
      <PressureLegend
        pMinPa={anchors.pMinPa}
        pMaxPa={anchors.pMaxPa}
        qRefPa={anchors.qRefPa}
      />
    </section>
  );
}

/**
 * Wind-tunnel instrument panel (F018): Flow sliders, Derived readouts,
 * Transport buttons, plus the relocated Particles / Smoke / Layers sections.
 *
 * Controlled component — slider state lives in the parent (F019's context);
 * every change commits through `setConditions` immediately for the UI while
 * the parent debounces the wasm backend. All form controls except Transport
 * disable via the surrounding fieldset when `controlsDisabled` holds.
 */
export function ControlPanel({
  conditions,
  setConditions,
  transport,
  controlsDisabled,
  conditionsUnstable,
  engineError,
}: ControlPanelProps) {
  const derived = derivedValues(
    conditions.uMps,
    conditions.pressureKpa,
    conditions.viscosityPas,
    DEFAULT_CHAR_LEN_M,
  );

  // Space toggles run/pause from anywhere except editable elements (spec §1).
  // Focused buttons are skipped: native space-activation already clicks them,
  // and a custom toggle on top would double-fire into a no-op.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.code !== "Space" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target !== null) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          tag === "BUTTON" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      event.preventDefault();
      transport.toggleRun();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [transport]);

  return (
    <Panel title="Tunnel controls">
      <fieldset
        disabled={controlsDisabled}
        className="m-0 min-w-0 space-y-5 border-0 p-0"
      >
        <section>
          <SectionTitle>Flow</SectionTitle>
          <div className="space-y-3">
            <Slider
              label="Wind speed"
              min={WIND_SPEED_RANGE.min}
              max={WIND_SPEED_RANGE.max}
              step={WIND_SPEED_RANGE.step}
              value={conditions.uMps}
              onChange={(uMps) => {
                setConditions({ ...conditions, uMps });
              }}
              unit="m/s"
              format={(v) => v.toFixed(1)}
            />
            <Slider
              label="Air pressure"
              min={AIR_PRESSURE_RANGE.min}
              max={AIR_PRESSURE_RANGE.max}
              step={AIR_PRESSURE_RANGE.step}
              value={conditions.pressureKpa}
              onChange={(pressureKpa) => {
                setConditions({ ...conditions, pressureKpa });
              }}
              unit="kPa"
              format={(v) => v.toFixed(1)}
            />
            <Slider
              label="Dynamic viscosity"
              min={VISCOSITY_COEF_RANGE.min}
              max={VISCOSITY_COEF_RANGE.max}
              step={VISCOSITY_COEF_RANGE.step}
              value={viscosityPasToCoef(conditions.viscosityPas)}
              onChange={(coef) => {
                setConditions({
                  ...conditions,
                  viscosityPas: viscosityCoefToPas(coef),
                });
              }}
              unit="×10⁻⁵ Pa·s"
              format={(v) => v.toFixed(2)}
            />
          </div>
        </section>
        <section>
          <SectionTitle>Derived</SectionTitle>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <DerivedCell
              label="Density ρ"
              value={`${derived.rhoKgM3.toFixed(3)} kg/m³`}
              title="Air density ρ = P/(R·T) at 20 °C (display math mirrors F009)"
            />
            <DerivedCell
              label="Viscosity ν"
              value={`${formatNu(derived.nuM2S)} m²/s`}
              title="Kinematic viscosity ν = μ/ρ (display math mirrors F009)"
            />
            <DerivedCell
              label="q ref"
              value={`${derived.qRefPa.toFixed(1)} Pa`}
              title="Stagnation reference q = ½·ρ·U² (the heatmap normalizer)"
            />
            <DerivedCell
              label="Re"
              value={formatRe(derived.re)}
              title="Reynolds number Re = U·L/ν, L = 0.25 m model length"
            />
          </div>
          {conditionsUnstable ? (
            <p className="mt-2 rounded-md border border-amber-800 bg-amber-950 px-2 py-1 text-[11px] text-amber-300">
              Operating point is outside the stable envelope (τ clamped) —
              expect unphysical flow until auto-recovery lands in F019.
            </p>
          ) : null}
        </section>
        <section>
          <SectionTitle>Particles</SectionTitle>
          <ParticleCountSlider />
        </section>
        <section>
          <SectionTitle>Smoke</SectionTitle>
          <SmokeControls />
        </section>
        <LayersSection />
      </fieldset>
      <section className="mt-5">
        <SectionTitle>Transport</SectionTitle>
        <button
          type="button"
          onClick={transport.toggleRun}
          aria-label={transport.running ? "Pause simulation" : "Run simulation"}
          className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-100 hover:bg-neutral-700"
        >
          {transport.running ? "⏸ Pause" : "▶ Run"}
        </button>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={transport.resetFlow}
            className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-100 hover:bg-neutral-700"
          >
            ↺ Reset flow
          </button>
          <button
            type="button"
            onClick={transport.resetAll}
            className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-100 hover:bg-neutral-700"
          >
            ↺↺ Reset all
          </button>
        </div>
        {engineError !== null ? (
          <p role="alert" className="mt-2 text-[11px] text-red-400">
            {engineError}
          </p>
        ) : null}
      </section>
    </Panel>
  );
}
