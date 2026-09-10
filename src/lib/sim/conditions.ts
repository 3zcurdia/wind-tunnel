/**
 * Display-side physical conditions for the F018 control panel.
 *
 * Pure module — no React, no three.js, no wasm. Safe to import anywhere,
 * including Node (`node --test`, see `conditions.test.mjs`).
 *
 * `derivedValues` intentionally duplicates F009's (`wasm/src/units.rs`)
 * formulas for responsiveness: the sliders need derived readouts (ρ, ν,
 * q_ref, Re) at input rate without a wasm round-trip per tick. Rust remains
 * authoritative for the simulation itself — `set_conditions` recomputes the
 * same quantities from the same inputs on every committed change, so a drift
 * between this file and `units.rs` would surface immediately as a
 * readout-vs-stats mismatch (the unit test pins the shared operating point).
 *
 * Constants mirror `ARCHITECTURE.md` §4 (ranges/defaults) and F009 §4 (the
 * domain-length default is JS's responsibility).
 */

/** Wind-tunnel operating point in SI units (the F019 `setConditions` shape). */
export interface FlowConditions {
  /** Wind speed [m/s], UI range 1–60. */
  readonly uMps: number;
  /** Static air pressure [kPa], UI range 50–110. */
  readonly pressureKpa: number;
  /** Dynamic viscosity [Pa·s], UI range 0.5–3.0 ×10⁻⁵. */
  readonly viscosityPas: number;
}

/** Slider defaults (F018 §1 — pressure is the 0.5 kPa step nearest sea level). */
export const DEFAULT_CONDITIONS: FlowConditions = {
  uMps: 15,
  pressureKpa: 101.3,
  viscosityPas: 1.81e-5,
};

/** Slider ranges/steps (F018 §1, ARCHITECTURE.md §4). */
export const WIND_SPEED_RANGE = { min: 1, max: 60, step: 0.5 } as const;
export const AIR_PRESSURE_RANGE = { min: 50, max: 110, step: 0.5 } as const;
/** Viscosity slider works in units of 10⁻⁵ Pa·s (displayed `×10⁻⁵ Pa·s`). */
export const VISCOSITY_COEF_RANGE = { min: 0.5, max: 3.0, step: 0.05 } as const;

/** Physical domain length [m] — F009 §4 leaves this default to JS. */
export const DOMAIN_LENGTH_M = 1.0;

/**
 * Obstacle characteristic length [m] feeding Re.
 *
 * Constant (not per-model state): F005's `normalizeToDomain` scales every
 * model so its longest bbox side spans exactly 0.25·nx lattice cells, hence
 * 0.25·L_domain meters — always 0.25 m at the default domain length. F018 §2
 * asks for a `charLengthM` in `ModelContext` meta, but that edit is outside
 * this feature's file list and provably redundant (see DECISIONS.md §F018.2).
 */
export const DEFAULT_CHAR_LEN_M = 0.25;

/** Dry-air gas constant [J/(kg·K)] and fixed temperature [K] (F009). */
const R_SPECIFIC = 287.05;
const TEMPERATURE_K = 293.15;

/** Read-only derived quantities for the "Derived" section. */
export interface DerivedValues {
  /** Air density [kg/m³]. */
  readonly rhoKgM3: number;
  /** Kinematic viscosity [m²/s]. */
  readonly nuM2S: number;
  /** Stagnation reference ½·ρ·U² [Pa]. */
  readonly qRefPa: number;
  /** Reynolds number U·L/ν. */
  readonly re: number;
}

/** Zeroed derived values for degenerate input (mirrors `units.rs` zeroing). */
const ZEROED: DerivedValues = { rhoKgM3: 0, nuM2S: 0, qRefPa: 0, re: 0 };

/**
 * Pure display math mirroring `units.rs::lattice_params` inputs (F009):
 * ρ = P/(R·T), ν = μ/ρ, q_ref = ½·ρ·U², Re = U·L/ν.
 *
 * Total function: degenerate input (non-finite values, P ≤ 0, μ ≤ 0)
 * yields zeros — never NaN — so the panel can render unconditionally (the
 * component maps zeros/non-finite to placeholders). Negative wind speed is
 * clamped to 0 (sliders prevent it; the formula squares U anyway).
 */
export function derivedValues(
  uMps: number,
  pressureKpa: number,
  viscosityPas: number,
  charLenM: number,
): DerivedValues {
  if (
    !Number.isFinite(uMps) ||
    !Number.isFinite(pressureKpa) ||
    !Number.isFinite(viscosityPas) ||
    !Number.isFinite(charLenM) ||
    pressureKpa <= 0 ||
    viscosityPas <= 0 ||
    charLenM < 0
  ) {
    return { ...ZEROED };
  }
  const rhoKgM3 = (pressureKpa * 1000) / (R_SPECIFIC * TEMPERATURE_K);
  const nuM2S = viscosityPas / rhoKgM3;
  const u = Math.max(0, uMps);
  return {
    rhoKgM3,
    nuM2S,
    qRefPa: 0.5 * rhoKgM3 * u * u,
    re: (u * charLenM) / nuM2S,
  };
}

/** Viscosity slider coefficient (10⁻⁵ Pa·s units) → Pa·s for the ABI. */
export function viscosityCoefToPas(coef: number): number {
  return coef * 1e-5;
}

/** Pa·s → slider coefficient (inverse of `viscosityCoefToPas`). */
export function viscosityPasToCoef(pas: number): number {
  return pas * 1e5;
}

/** 15 → "54 km/h" (round to integer). */
export function formatKmh(uMps: number): string {
  return `${Math.round(uMps * 3.6)} km/h`;
}

/**
 * ISA altitude from station pressure: h = 44330·(1 − (kPa/101.325)^0.1903),
 * clamped to ≥ 0, rounded to the nearest 100 m.
 * 101.3 → "sea level"; otherwise "≈ 1,900 m altitude" (en-US grouping).
 * Returns "sea level" whenever the computed altitude rounds to 0 m.
 */
export function formatAltitude(pressureKpa: number): string {
  const h = 44330 * (1 - Math.pow(pressureKpa / 101.325, 0.1903));
  const rounded = Math.round(Math.max(0, h) / 100) * 100;
  if (rounded === 0) return "sea level";
  return `≈ ${rounded.toLocaleString("en-US")} m altitude`;
}

/**
 * One-click real-world scenario (F026 §1).
 *
 * Every preset lives inside the solver's honest envelope (subsonic, 1–60 m/s,
 * 50–110 kPa — ARCHITECTURE.md §3/§4). There is deliberately no jet or
 * supersonic preset: this LBM cannot represent shocks or compressibility.
 */
export interface FlowPreset {
  readonly id: "breeze" | "city" | "race" | "mountain";
  /** Button text. */
  readonly label: string;
  /** One line under the grid while this preset is active. */
  readonly caption: string;
  readonly conditions: FlowConditions;
}

/**
 * Scenario table (F026 §1, values fixed by the spec — do not retune). The
 * viscosity is the F018 default coefficient 1.81, which is intentionally off
 * the 0.05-coefficient grid (see DECISIONS.md §F026).
 */
export const FLOW_PRESETS: readonly FlowPreset[] = [
  {
    id: "breeze",
    label: "Breeze",
    caption: "A stiff sea breeze — gentle, attached flow.",
    conditions: { uMps: 8, pressureKpa: 101.5, viscosityPas: 1.81e-5 },
  },
  {
    id: "city",
    label: "City drive",
    caption: "≈50 km/h at sea level — the everyday car case.",
    conditions: { uMps: 14, pressureKpa: 101.5, viscosityPas: 1.81e-5 },
  },
  {
    id: "race",
    label: "Race car",
    caption: "≈200 km/h — watch the wake grow and drag climb.",
    conditions: { uMps: 55, pressureKpa: 101.5, viscosityPas: 1.81e-5 },
  },
  {
    id: "mountain",
    label: "High altitude",
    caption: "≈4,000 m up — thinner air, same speed, less drag.",
    conditions: { uMps: 25, pressureKpa: 61.5, viscosityPas: 1.81e-5 },
  },
] as const;

/**
 * Active-preset matcher (F026 §2): the id of the preset whose three values
 * all match `c` within 1e-9 absolute tolerance, else `null` — so moving any
 * slider after a preset click deselects it. Pure.
 */
export function matchPreset(c: FlowConditions): FlowPreset["id"] | null {
  for (const preset of FLOW_PRESETS) {
    const p = preset.conditions;
    if (
      Math.abs(c.uMps - p.uMps) <= 1e-9 &&
      Math.abs(c.pressureKpa - p.pressureKpa) <= 1e-9 &&
      Math.abs(c.viscosityPas - p.viscosityPas) <= 1e-9
    ) {
      return preset.id;
    }
  }
  return null;
}
