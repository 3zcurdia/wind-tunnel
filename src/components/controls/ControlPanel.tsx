"use client";

import { useEffect, useState } from "react";
import { Panel } from "@/components/ui/Panel";
import { Slider } from "@/components/ui/Slider";
import { ParticleCountSlider } from "@/components/controls/ParticleCountSlider";
import { PressureLegend } from "@/components/controls/PressureLegend";
import { SmokeControls } from "@/components/controls/SmokeControls";
import { getSceneManager } from "@/components/viewport/viewportBridge";
import { useSimulationContext } from "@/lib/sim/SimulationContext";
import {
  QUALITY_LEVELS,
  QUALITY_PRESETS,
  type QualityLevel,
} from "@/lib/sim/quality";
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

/** Single layer checkbox row (F020 §3), styled like the F018 toggles. */
function LayerToggle({
  id,
  label,
  checked,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className="mb-2 flex cursor-pointer items-center gap-2 text-xs font-medium text-neutral-300"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
        className="accent-blue-500"
      />
      {label}
    </label>
  );
}

/**
 * Layer toggles (F020 §3) + the F015 pressure legend. Smoke and heatmap
 * state is applied every frame by the F019 loop; the other two flags are
 * SceneManager-backed and applied by the effect below. Toggles are
 * independent and instant.
 */
function LayersSection() {
  const {
    heatmapEnabled,
    setHeatmapEnabled,
    smokeEnabled,
    setSmokeEnabled,
    particlesVisible,
    setParticlesVisible,
    domainBoxVisible,
    setDomainBoxVisible,
    readout,
  } = useSimulationContext();
  const anchors = readout ?? { pMinPa: 0, pMaxPa: 0, qRefPa: 0 };

  // Push the SceneManager-backed flags on change. Defaults match a fresh
  // SceneManager (particles/domain shown), and the fieldset gates interaction
  // until the engine is ready — long after the viewport registers — so a null
  // manager here is a harmless no-op.
  useEffect(() => {
    const manager = getSceneManager();
    if (!manager) return;
    manager.setLayerVisible("particles", particlesVisible);
    manager.setDomainBoxVisible(domainBoxVisible);
  }, [particlesVisible, domainBoxVisible]);

  return (
    <section>
      <SectionTitle>Layers</SectionTitle>
      <LayerToggle
        id="layer-particles"
        label="Particles"
        checked={particlesVisible}
        onChange={setParticlesVisible}
      />
      <LayerToggle
        id="layer-smoke"
        label="Smoke tracers"
        checked={smokeEnabled}
        onChange={setSmokeEnabled}
      />
      <LayerToggle
        id="heatmap-toggle"
        label="Surface pressure"
        checked={heatmapEnabled}
        onChange={setHeatmapEnabled}
      />
      <LayerToggle
        id="layer-domain-box"
        label="Domain box"
        checked={domainBoxVisible}
        onChange={setDomainBoxVisible}
      />
      <PressureLegend
        pMinPa={anchors.pMinPa}
        pMaxPa={anchors.pMaxPa}
        qRefPa={anchors.qRefPa}
      />
    </section>
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
function QualitySection() {
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
              Stability assist active — real-air viscosity cannot reach a
              stable τ at this grid, so the solver runs on assist viscosity.
              Flow stays visual; effective Re is lower than shown.
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
      <div className="mt-5">
        <QualitySection />
      </div>
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
