/**
 * Unit checks for the F021 `quality.ts` preset table, persistence, and
 * auto-probe (F021 test plan).
 *
 * Run with Node's built-in runner — no framework install needed:
 *   node --test src/lib/sim/quality.test.mjs
 *
 * Same `.mjs`-imports-`.ts` wrapper pattern as `conditions.test.mjs`:
 * explicit extension satisfies both Node's type stripping and `tsc`, so
 * `quality.ts` stays free of non-erasable syntax.
 *
 * `localStorage` is stubbed per-test on `globalThis` (in-memory Map): the
 * module reads storage lazily at call time, so no import tricks are needed,
 * and the "storage unavailable" path is covered by deleting the stub.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_QUALITY,
  PROBE_BUDGET_MS,
  PROBE_GRID_SCALE,
  QUALITY_LEVELS,
  QUALITY_PRESETS,
  QUALITY_STORAGE_KEY,
  hasStoredQuality,
  isQualityLevel,
  loadStoredQuality,
  probeQuality,
  storeQuality,
} from "./quality.ts";

function installMemoryStorage(seed) {
  const store = new Map(Object.entries(seed ?? {}));
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? (store.get(key) ?? null) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
  return store;
}

const hadStorage = "localStorage" in globalThis;
const realStorage = globalThis.localStorage;

beforeEach(() => {
  installMemoryStorage();
});

afterEach(() => {
  if (hadStorage) {
    globalThis.localStorage = realStorage;
  } else {
    delete globalThis.localStorage;
  }
});

describe("preset table integrity (F021 §1 normative values)", () => {
  it("exposes exactly low / medium / high in order", () => {
    assert.deepStrictEqual([...QUALITY_LEVELS], ["low", "medium", "high"]);
    assert.deepStrictEqual(
      Object.keys(QUALITY_PRESETS).sort(),
      ["high", "low", "medium"],
    );
  });

  it("pins the Low tier (64×24×24, 10k particles, 12 smoke)", () => {
    assert.deepStrictEqual(QUALITY_PRESETS.low, {
      level: "low",
      label: "Low",
      grid: { nx: 64, ny: 24, nz: 24 },
      particles: 10000,
      smokeTracers: 12,
      note: QUALITY_PRESETS.low.note,
    });
  });

  it("pins the Medium tier (96×36×36, 30k particles, 25 smoke)", () => {
    assert.deepStrictEqual(QUALITY_PRESETS.medium.grid, {
      nx: 96,
      ny: 36,
      nz: 36,
    });
    assert.strictEqual(QUALITY_PRESETS.medium.particles, 30000);
    assert.strictEqual(QUALITY_PRESETS.medium.smokeTracers, 25);
  });

  it("pins the High tier (128×48×48, 60k particles, 40 smoke)", () => {
    assert.deepStrictEqual(QUALITY_PRESETS.high.grid, {
      nx: 128,
      ny: 48,
      nz: 48,
    });
    assert.strictEqual(QUALITY_PRESETS.high.particles, 60000);
    assert.strictEqual(QUALITY_PRESETS.high.smokeTracers, 40);
  });

  it("keeps the 8:3:3 aspect on every tier (uniform rescale across tiers)", () => {
    for (const level of QUALITY_LEVELS) {
      const { nx, ny, nz } = QUALITY_PRESETS[level].grid;
      assert.strictEqual(nx / 8, ny / 3, `${level}: nx/8 != ny/3`);
      assert.strictEqual(ny, nz, `${level}: ny != nz`);
    }
    // Low is exactly 1/2 of High per axis; Medium exactly 3/4.
    for (const [axis, low, med, high] of [
      ["nx", 64, 96, 128],
      ["ny", 24, 36, 48],
      ["nz", 24, 36, 48],
    ]) {
      assert.strictEqual(QUALITY_PRESETS.low.grid[axis], low);
      assert.strictEqual(QUALITY_PRESETS.medium.grid[axis], med);
      assert.strictEqual(QUALITY_PRESETS.high.grid[axis], high);
    }
  });

  it("pins the probe scale factor: High holds exactly 8× Low's cells", () => {
    const cells = (g) => g.nx * g.ny * g.nz;
    assert.strictEqual(
      cells(QUALITY_PRESETS.high.grid) / cells(QUALITY_PRESETS.low.grid),
      PROBE_GRID_SCALE,
    );
    assert.strictEqual(PROBE_GRID_SCALE, 8);
    assert.strictEqual(PROBE_BUDGET_MS, 12);
  });

  it("defaults to Medium", () => {
    assert.strictEqual(DEFAULT_QUALITY, "medium");
  });
});

describe("persistence round-trip + corrupt fallback (F021 §2)", () => {
  it("round-trips every tier through the wt.quality key", () => {
    assert.strictEqual(QUALITY_STORAGE_KEY, "wt.quality");
    for (const level of QUALITY_LEVELS) {
      storeQuality(level);
      assert.strictEqual(loadStoredQuality(), level);
      assert.strictEqual(hasStoredQuality(), true);
    }
  });

  it("falls back to Medium with no crash when nothing is stored", () => {
    assert.strictEqual(hasStoredQuality(), false);
    assert.strictEqual(loadStoredQuality(), "medium");
  });

  it("falls back to Medium on a corrupted value", () => {
    for (const garbage of [
      "ultra",
      "",
      "HIGH",
      "null",
      "low ",
      "medium,high",
    ]) {
      globalThis.localStorage.setItem(QUALITY_STORAGE_KEY, garbage);
      assert.strictEqual(hasStoredQuality(), false, `stored: ${garbage}`);
      assert.strictEqual(loadStoredQuality(), "medium", `stored: ${garbage}`);
    }
  });

  it("stores the exact key (no prefix drift)", () => {
    storeQuality("high");
    assert.strictEqual(
      globalThis.localStorage.getItem("wt.quality"),
      "high",
    );
  });

  it("behaves as first visit when storage is unavailable (no throw)", () => {
    delete globalThis.localStorage;
    assert.strictEqual(hasStoredQuality(), false);
    assert.strictEqual(loadStoredQuality(), "medium");
    assert.doesNotThrow(() => {
      storeQuality("low");
    });
  });
});

describe("isQualityLevel validation", () => {
  it("accepts exactly the three known keys", () => {
    assert.strictEqual(isQualityLevel("low"), true);
    assert.strictEqual(isQualityLevel("medium"), true);
    assert.strictEqual(isQualityLevel("high"), true);
  });

  it("rejects everything else", () => {
    for (const bad of [
      "Low",
      "",
      null,
      undefined,
      0,
      {},
      [],
      "low ",
      "medium ",
    ]) {
      assert.strictEqual(isQualityLevel(bad), false, `input: ${String(bad)}`);
    }
  });
});

describe("probe thresholds (F021 §1: last×8 > 12 ms → Low else Medium)", () => {
  it("picks Medium at the exact 12 ms boundary (strict `>`)", () => {
    // 1.5 ms × 8 = 12 ms exactly — not greater, so Medium.
    assert.strictEqual(probeQuality(1.5), "medium");
  });

  it("picks Low just above the boundary and Medium just below", () => {
    assert.strictEqual(probeQuality(1.5000001), "low");
    assert.strictEqual(probeQuality(1.4999999), "medium");
  });

  it("picks Low for clearly slow devices, Medium for fast ones", () => {
    assert.strictEqual(probeQuality(100), "low");
    assert.strictEqual(probeQuality(5), "low");
    assert.strictEqual(probeQuality(0.001), "medium");
    assert.strictEqual(probeQuality(0.5), "medium");
  });

  it("falls back to Medium on broken timer readings (never strands on Low)", () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY * 0,
      0,
      -1,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ]) {
      assert.strictEqual(probeQuality(bad), "medium", `input: ${bad}`);
    }
  });
});
