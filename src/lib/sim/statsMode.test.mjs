/**
 * Unit checks for the F029 `statsMode.ts` validation + persistence.
 *
 * Run with Node's built-in runner — no framework install needed:
 *   node --test src/lib/sim/statsMode.test.mjs
 *
 * Same `.mjs`-imports-`.ts` wrapper pattern as `quality.test.mjs`:
 * explicit extension satisfies both Node's type stripping and `tsc`, so
 * `statsMode.ts` stays free of non-erasable syntax.
 *
 * `localStorage` is stubbed per-test on `globalThis` (in-memory Map): the
 * module reads storage lazily at call time, so no import tricks are needed,
 * and the "storage unavailable" path is covered by deleting the stub.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STATS_MODE,
  STATS_MODE_STORAGE_KEY,
  isStatsMode,
  loadStoredStatsMode,
  storeStatsMode,
} from "./statsMode.ts";

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

describe("isStatsMode truth table (F029 §1)", () => {
  it("accepts exactly simple and advanced", () => {
    assert.strictEqual(isStatsMode("simple"), true);
    assert.strictEqual(isStatsMode("advanced"), true);
  });

  it("rejects everything else", () => {
    for (const bad of [
      "Simple",
      "ADVANCED",
      "turbo",
      "",
      "simple ",
      " advanced",
      null,
      undefined,
      0,
      {},
      [],
    ]) {
      assert.strictEqual(isStatsMode(bad), false, `input: ${String(bad)}`);
    }
  });
});

describe("loadStoredStatsMode fallback (F029 test plan)", () => {
  it("defaults to simple", () => {
    assert.strictEqual(DEFAULT_STATS_MODE, "simple");
  });

  it("pins the storage key", () => {
    assert.strictEqual(STATS_MODE_STORAGE_KEY, "wt.statsMode");
  });

  it("falls back to simple with no crash when nothing is stored", () => {
    assert.strictEqual(loadStoredStatsMode(), "simple");
  });

  it("falls back to simple on a corrupted value", () => {
    for (const garbage of [
      "turbo",
      "",
      "SIMPLE",
      "null",
      "simple ",
      "simple,advanced",
    ]) {
      globalThis.localStorage.setItem(STATS_MODE_STORAGE_KEY, garbage);
      assert.strictEqual(loadStoredStatsMode(), "simple", `stored: ${garbage}`);
    }
  });

  it("behaves as first visit when storage is unavailable (no throw)", () => {
    delete globalThis.localStorage;
    assert.strictEqual(loadStoredStatsMode(), "simple");
    assert.doesNotThrow(() => {
      storeStatsMode("advanced");
    });
  });
});

describe("storeStatsMode round-trip (F029 test plan)", () => {
  it("round-trips both modes through the wt.statsMode key", () => {
    for (const mode of ["simple", "advanced"]) {
      storeStatsMode(mode);
      assert.strictEqual(loadStoredStatsMode(), mode);
    }
  });

  it("stores the exact key (no prefix drift)", () => {
    storeStatsMode("advanced");
    assert.strictEqual(
      globalThis.localStorage.getItem("wt.statsMode"),
      "advanced",
    );
  });
});
