/**
 * Stats-bar display mode (F029): simple hero numbers vs the full instrument row.
 *
 * Pure module — no React, no three.js, no wasm. Safe to import anywhere,
 * including Node (`node --test`, see `statsMode.test.mjs`).
 *
 * Structure mirrors `quality.ts` (F021) so the storage hygiene stays
 * identical: lazy `localStorage` reads, try/catch on every access, corrupt
 * values fall back to the default with no throw.
 *
 * Kept free of non-erasable TS syntax (like `quality.ts` / `conditions.ts`)
 * so the `node --test` harness can import it directly.
 */

/** Stats-bar density (F029 interface contract). */
export type StatsMode = "simple" | "advanced";

/** First-visit default: hero numbers for non-experts. */
export const DEFAULT_STATS_MODE: StatsMode = "simple";

/** localStorage key (F029 §1). */
export const STATS_MODE_STORAGE_KEY = "wt.statsMode";

/** True for exactly the two known mode keys (F029 §1 validation). */
export function isStatsMode(value: unknown): value is StatsMode {
  return value === "simple" || value === "advanced";
}

function readStorage(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(STATS_MODE_STORAGE_KEY);
  } catch {
    // Storage unavailable (SSR, privacy mode) — behave as first visit.
    return null;
  }
}

/**
 * Load the persisted mode (F029 interface contract). Anything but a known
 * key — missing, corrupt, or storage unavailable — falls back to Simple
 * with no throw, so boot never crashes on a poisoned value.
 */
export function loadStoredStatsMode(): StatsMode {
  const raw = readStorage();
  return isStatsMode(raw) ? raw : DEFAULT_STATS_MODE;
}

/** Persist the mode (F029 interface contract). Never throws. */
export function storeStatsMode(mode: StatsMode): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STATS_MODE_STORAGE_KEY, mode);
  } catch {
    // Quota/privacy failures must not break the simulation.
  }
}
