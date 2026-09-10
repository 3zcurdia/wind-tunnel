/**
 * Quality presets (F021): low / medium / high grid + particle + smoke tiers.
 *
 * Pure module — no React, no three.js, no wasm. Safe to import anywhere,
 * including Node (`node --test`, see `quality.test.mjs`).
 *
 * Kept free of non-erasable TS syntax (like `conditions.ts` /
 * `HeatmapOverlay.ts`) so the `node --test` harness can import it directly.
 *
 * Grid sizes come from ARCHITECTURE.md §3/§7: High is the original
 * compile-time `DOMAIN` (128×48×48); all three tiers keep the 8:3:3 aspect so
 * a normalized model rescales exactly across tiers (uniform ratio — Low is
 * exactly 1/2 of High per axis, Medium exactly 3/4).
 */

/** Quality tier identifier (F021 interface contract). */
export type QualityLevel = "low" | "medium" | "high";

/** Lattice grid dimensions in cells (runtime replacement for `DOMAIN`). */
export interface GridDims {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

/** One quality tier: grid + particle pool target + smoke rake size. */
export interface QualitySpec {
  readonly level: QualityLevel;
  /** Short UI label, e.g. "Low". */
  readonly label: string;
  /** Lattice grid dimensions in cells. */
  readonly grid: GridDims;
  /** Particle pool target spawned on (re-)init. */
  readonly particles: number;
  /** Smoke tracer rake size. */
  readonly smokeTracers: number;
  /** One-line trade-off note for the control panel. */
  readonly note: string;
}

/** Preset table (F021 §1 — normative values, pinned by `quality.test.mjs`). */
export const QUALITY_PRESETS: Record<QualityLevel, QualitySpec> = {
  low: {
    level: "low",
    label: "Low",
    grid: { nx: 64, ny: 24, nz: 24 },
    particles: 10000,
    smokeTracers: 12,
    note: "Coarse grid — faster, noisier heatmap",
  },
  medium: {
    level: "medium",
    label: "Medium",
    grid: { nx: 96, ny: 36, nz: 36 },
    particles: 30000,
    smokeTracers: 25,
    note: "Balanced",
  },
  high: {
    level: "high",
    label: "High",
    grid: { nx: 128, ny: 48, nz: 48 },
    particles: 60000,
    smokeTracers: 40,
    note: "Fine grid — sharpest, needs a fast machine",
  },
};

/** Tier order for the segmented control (low → high). */
export const QUALITY_LEVELS: readonly QualityLevel[] = [
  "low",
  "medium",
  "high",
];

/** Default tier when nothing is stored or the stored value is corrupt. */
export const DEFAULT_QUALITY: QualityLevel = "medium";

/** localStorage key (F021 §2). */
export const QUALITY_STORAGE_KEY = "wt.quality";

/**
 * Auto-probe budget (F021 §1): the warm-up measures one `step(8)` at the Low
 * grid; the High grid holds exactly 8× the cells
 * (128·48·48 / 64·24·24 = 294912 / 36864 = 8), so `last_step_ms × 8`
 * estimates the High-grid cost. Above 12 ms (the F019 solver budget) the
 * device is too slow for anything above Low.
 *
 * The reading is `last_step_ms` (the per-step cost of that one batch), not
 * the `avg_step_ms` EMA — the EMA is seeded at 0 and only moves 10 % per
 * batch, so a single warm-up batch reads ~10 % of the true cost.
 */
export const PROBE_BUDGET_MS = 12;
export const PROBE_GRID_SCALE = 8;

/** True for exactly the three known tier keys (F021 §2 validation). */
export function isQualityLevel(value: unknown): value is QualityLevel {
  return value === "low" || value === "medium" || value === "high";
}

function readStorage(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(QUALITY_STORAGE_KEY);
  } catch {
    // Storage unavailable (SSR, privacy mode) — behave as first visit.
    return null;
  }
}

/**
 * Load the persisted tier (F021 interface contract). Anything but a known
 * key — missing, corrupt, or storage unavailable — falls back to Medium
 * with no throw, so boot never crashes on a poisoned value.
 */
export function loadStoredQuality(): QualityLevel {
  const raw = readStorage();
  return isQualityLevel(raw) ? raw : DEFAULT_QUALITY;
}

/**
 * True when a valid tier is persisted (false on first visit or corruption).
 * The boot flow probes the device only in that case; a corrupt value is
 * treated like a first visit for probing but still boots safely via
 * `loadStoredQuality`'s Medium fallback if the probe itself fails.
 */
export function hasStoredQuality(): boolean {
  return isQualityLevel(readStorage());
}

/** Persist the tier (F021 interface contract). Never throws. */
export function storeQuality(level: QualityLevel): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(QUALITY_STORAGE_KEY, level);
  } catch {
    // Quota/privacy failures must not break the simulation.
  }
}

/**
 * Pick the first-visit default from a warm-up measurement (F021 interface
 * contract — pure: takes the measured number, does no wasm itself).
 *
 * `warmupStepMs` is `timing().last_step_ms` after one `step(8)` at the Low
 * grid — the last-batch reading, not the EMA, which a single batch leaves at
 * ~10 % of the real cost. `last × 8 > 12 ms` → the device cannot hold High
 * inside the frame budget → Low; otherwise Medium.
 * The probe never auto-picks High (a manual
 * upgrade only). Non-finite or non-positive measurements fall back to Medium
 * (the safe, spec'd default — a broken timer must not strand a fast machine
 * on Low). The 12 ms boundary itself belongs to Medium (`>` is strict).
 */
export function probeQuality(warmupStepMs: number): QualityLevel {
  if (!Number.isFinite(warmupStepMs) || warmupStepMs <= 0) {
    return DEFAULT_QUALITY;
  }
  return warmupStepMs * PROBE_GRID_SCALE > PROBE_BUDGET_MS
    ? "low"
    : DEFAULT_QUALITY;
}
