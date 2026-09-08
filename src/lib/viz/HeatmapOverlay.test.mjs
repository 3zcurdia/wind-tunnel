/**
 * Unit checks for `HeatmapOverlay.ts` (F015 test plan — the optional
 * `normalizePressure` pure-function tests, plus attach/update/clear behavior
 * on real three.js geometries).
 *
 * Run with Node's built-in runner — no framework install needed:
 *   node --test src/lib/viz/HeatmapOverlay.test.mjs
 *
 * Why the transpile harness below: `colormaps.test.mjs` imports its source
 * with an explicit `.ts` extension, which works because `colormaps.ts` is
 * import-free. `HeatmapOverlay.ts` legitimately imports `./colormaps` and
 * `../sim/types` with extensionless (TS-idiomatic) specifiers, which plain
 * Node cannot resolve. So this file transpiles the three real sources
 * in-memory with the repo's own `typescript` devDependency, rewrites the two
 * relative specifiers to the local transpiled copies (mechanical string
 * replacement — no logic is copied or stubbed), and imports the result.
 * Everything asserted on is the real implementation; the temp dir is removed
 * in `after()`.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BoxGeometry, BufferAttribute, BufferGeometry } from "three";

const HERE = new URL(".", import.meta.url).pathname;
let tmpDir = null;

/**
 * Transpile the real TS sources and import them. The temp dir lives inside
 * the viz folder so the bare `three` import keeps resolving via the repo's
 * node_modules; all outputs land in that one dir, so the two relative
 * specifiers are rewritten to local names (mechanical replacement — no logic
 * is copied or stubbed). Everything asserted on is the real implementation.
 */
async function loadRealModule() {
  const { default: ts } = await import("typescript");
  const dir = mkdtempSync(join(HERE, ".tmp-heatmap-"));
  tmpDir = dir;
  try {
    const sources = {
      "HeatmapOverlay.mjs": "HeatmapOverlay.ts",
      "colormaps.mjs": "colormaps.ts",
      "types.mjs": "../sim/types.ts",
    };
    for (const [out, src] of Object.entries(sources)) {
      const text = readFileSync(join(HERE, src), "utf8");
      const js = ts.transpileModule(text, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;
      const fixed = js
        .split('from "../sim/types"')
        .join('from "./types.mjs"')
        .split('from "./colormaps"')
        .join('from "./colormaps.mjs"');
      writeFileSync(join(dir, out), fixed);
    }
    return await import(pathToFileURL(join(dir, "HeatmapOverlay.mjs")).href);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    tmpDir = null;
    throw err;
  }
}

let HeatmapOverlay;
let buildStoredIndexMap;
let normalizePressure;
let pressureColorInto;
let DOMAIN;

before(async () => {
  const mod = await loadRealModule();
  HeatmapOverlay = mod.HeatmapOverlay;
  buildStoredIndexMap = mod.buildStoredIndexMap;
  normalizePressure = mod.normalizePressure;
  const colormaps = await import("./colormaps.ts");
  pressureColorInto = colormaps.pressureColorInto;
  const types = await import("../sim/types.ts");
  DOMAIN = types.DOMAIN;
});

after(() => {
  if (tmpDir !== null) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

const ANCHORS = { pMinPa: -100, pMaxPa: 200, qRefPa: 135.46 };

/** Read one RGB triple out of a color attribute array. */
function triple(array, offset) {
  return [array[offset], array[offset + 1], array[offset + 2]];
}

function closeTo(actual, expected, eps = 1e-6) {
  assert.strictEqual(actual.length, expected.length);
  for (let i = 0; i < actual.length; i += 1) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) < eps,
      `channel ${i}: ${actual[i]} !~= ${expected[i]}`,
    );
  }
}

describe("normalizePressure", () => {
  it("maps p_min→0, p_max→1, midpoint→0.5", () => {
    assert.strictEqual(normalizePressure(-100, ANCHORS), 0);
    assert.strictEqual(normalizePressure(200, ANCHORS), 1);
    assert.strictEqual(normalizePressure(50, ANCHORS), 0.5);
  });

  it("clamps outside the anchor range", () => {
    assert.strictEqual(normalizePressure(-1000, ANCHORS), 0);
    assert.strictEqual(normalizePressure(1000, ANCHORS), 1);
  });

  it("uses the q_ref × 0.25 denominator floor before spin-up", () => {
    // Zero field, developed reference: span 0 < floor 33.865.
    const anchors = { pMinPa: 0, pMaxPa: 0, qRefPa: 135.46 };
    assert.strictEqual(normalizePressure(0, anchors), 0);
    assert.strictEqual(normalizePressure(33.865, anchors), 1);
    assert.strictEqual(normalizePressure(100, anchors), 1);
  });

  it("returns mid-gray (0.5) with no data", () => {
    // No mesh / no conditions: zero span AND zero reference.
    assert.strictEqual(
      normalizePressure(0, { pMinPa: 0, pMaxPa: 0, qRefPa: 0 }),
      0.5,
    );
    assert.strictEqual(
      normalizePressure(5, { pMinPa: 0, pMaxPa: 0, qRefPa: 0 }),
      0.5,
    );
  });

  it("returns mid-gray (0.5) for non-finite inputs", () => {
    assert.strictEqual(normalizePressure(Number.NaN, ANCHORS), 0.5);
    assert.strictEqual(normalizePressure(Infinity, ANCHORS), 0.5);
    assert.strictEqual(
      normalizePressure(10, { pMinPa: Number.NaN, pMaxPa: 1, qRefPa: 1 }),
      0.5,
    );
    assert.strictEqual(
      normalizePressure(10, { pMinPa: 0, pMaxPa: 1, qRefPa: Infinity }),
      0.5,
    );
  });
});

describe("buildStoredIndexMap", () => {
  it("maps soup order to sorted stored order", () => {
    // Soup: x = 2, 0, 1 → stored (sorted): 0, 1, 2.
    const lattice = new Float32Array([2, 0, 0, 0, 0, 0, 1, 0, 0]);
    assert.deepStrictEqual(Array.from(buildStoredIndexMap(lattice)), [2, 0, 1]);
  });

  it("collapses duplicates onto one stored row", () => {
    const lattice = new Float32Array([1, 0, 0, 1, 0, 0, 0, 0, 0]);
    assert.deepStrictEqual(Array.from(buildStoredIndexMap(lattice)), [1, 1, 0]);
  });

  it("handles empty input", () => {
    assert.deepStrictEqual(
      Array.from(buildStoredIndexMap(new Float32Array(0))),
      [],
    );
  });
});

describe("HeatmapOverlay", () => {
  it("attaches a color attribute and paints on the first update", () => {
    const overlay = new HeatmapOverlay();
    const geometry = new BoxGeometry(1, 1, 1);
    assert.strictEqual(geometry.getAttribute("color"), undefined);
    overlay.attach(geometry);
    assert.strictEqual(overlay.attachedGeometry, geometry);
    const color = geometry.getAttribute("color");
    assert.ok(color !== undefined);
    assert.strictEqual(color.count, geometry.getAttribute("position").count);

    // Box has 8 unique corners → 8 stored rows; paint a ramp across them.
    const pressure = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const anchors = { pMinPa: 0, pMaxPa: 7, qRefPa: 4 };
    overlay.update(pressure, anchors);
    const array = color.array;
    for (const v of array) assert.ok(Number.isFinite(v));
    overlay.clear();
    geometry.dispose();
  });

  it("colors each vertex by its own stored row (not soup order)", () => {
    // Two vertices in soup order x = 2, 0; stored order is x = 0, 1.
    // NOTE: these positions are lattice-space, not world-space — attach
    // inverts the world mapping on them, but the inversion is monotonic so
    // the recovered order still matches the lattice order. This isolates the
    // soup-vs-sorted mapping; the world-transform round-trip is pinned by
    // the next test.
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([2, 0, 0, 0, 0, 0]), 3),
    );
    const overlay = new HeatmapOverlay();
    overlay.attach(geometry);

    // Stored rows: row 0 = (0,0,0), row 1 = (2,0,0).
    const pressure = new Float32Array([-1000, 1000]);
    const anchors = { pMinPa: -1000, pMaxPa: 1000, qRefPa: 100 };
    overlay.update(pressure, anchors);
    const array = geometry.getAttribute("color").array;
    const hot = new Float32Array(3);
    const cold = new Float32Array(3);
    pressureColorInto(1, hot, 0);
    pressureColorInto(0, cold, 0);
    // Vertex 0 sits at x = 2 (stored row 1, p = +1000) → hot.
    closeTo(triple(array, 0), Array.from(hot));
    // Vertex 1 sits at x = 0 (stored row 0, p = −1000) → cold.
    closeTo(triple(array, 3), Array.from(cold));
    overlay.clear();
    geometry.dispose();
  });

  it("recovers the map through the world transform", () => {
    // Same two vertices, but stored in world space via the exact
    // lattice→world mapping (scale 0.1 + centering offset from DOMAIN).
    const toWorld = (x, y, z) => [
      x * 0.1 + (-DOMAIN.nx / 2) * 0.1,
      y * 0.1 + (-DOMAIN.ny / 2) * 0.1,
      z * 0.1 + (-DOMAIN.nz / 2) * 0.1,
    ];
    const a = toWorld(2, 0, 0);
    const b = toWorld(0, 0, 0);
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([...a, ...b]), 3),
    );
    const overlay = new HeatmapOverlay();
    overlay.attach(geometry);
    const pressure = new Float32Array([-1000, 1000]);
    const anchors = { pMinPa: -1000, pMaxPa: 1000, qRefPa: 100 };
    overlay.update(pressure, anchors);
    const array = geometry.getAttribute("color").array;
    const hot = new Float32Array(3);
    const cold = new Float32Array(3);
    pressureColorInto(1, hot, 0);
    pressureColorInto(0, cold, 0);
    closeTo(triple(array, 0), Array.from(hot));
    closeTo(triple(array, 3), Array.from(cold));
    overlay.clear();
    geometry.dispose();
  });

  it("paints mid-gray for missing rows and non-finite pressures", () => {
    const geometry = new BoxGeometry(1, 1, 1);
    const overlay = new HeatmapOverlay();
    overlay.attach(geometry);
    // Empty pressure view: every vertex is out of range → t = 0.5.
    overlay.update(new Float32Array(0), ANCHORS);
    const array = geometry.getAttribute("color").array;
    const mid = new Float32Array(3);
    pressureColorInto(0.5, mid, 0);
    const expected = Array.from(mid);
    const count = geometry.getAttribute("position").count;
    for (let i = 0; i < count; i += 1) {
      closeTo(triple(array, i * 3), expected);
    }
    overlay.clear();
    geometry.dispose();
  });

  it("throttles color fills to every 3rd update", () => {
    const geometry = new BoxGeometry(1, 1, 1);
    const overlay = new HeatmapOverlay();
    overlay.attach(geometry);
    const color = geometry.getAttribute("color");
    const low = new Float32Array(8).fill(-100);
    const high = new Float32Array(8).fill(200);
    overlay.update(low, ANCHORS); // call 1: paints
    const first = Array.from(color.array);
    overlay.update(high, ANCHORS); // call 2: skipped
    assert.deepStrictEqual(Array.from(color.array), first);
    overlay.update(high, ANCHORS); // call 3: skipped
    assert.deepStrictEqual(Array.from(color.array), first);
    overlay.update(high, ANCHORS); // call 4: paints
    assert.notDeepStrictEqual(Array.from(color.array), first);
    overlay.clear();
    geometry.dispose();
  });

  it("clear removes the attribute and re-attach swaps cleanly", () => {
    const overlay = new HeatmapOverlay();
    const small = new BoxGeometry(1, 1, 1);
    const big = new BoxGeometry(2, 1, 1);
    overlay.attach(small);
    assert.ok(small.getAttribute("color") !== undefined);
    overlay.update(new Float32Array(8).fill(1), ANCHORS);
    overlay.clear();
    assert.strictEqual(overlay.attachedGeometry, null);
    assert.strictEqual(small.getAttribute("color"), undefined);
    // Re-attach to a different-count geometry: no crash, fresh attribute.
    overlay.attach(big);
    assert.strictEqual(
      big.getAttribute("color").count,
      big.getAttribute("position").count,
    );
    overlay.update(new Float32Array(8).fill(1), ANCHORS);
    for (const v of big.getAttribute("color").array) {
      assert.ok(Number.isFinite(v));
    }
    overlay.clear();
    assert.strictEqual(big.getAttribute("color"), undefined);
    small.dispose();
    big.dispose();
  });

  it("update before attach and double clear are safe no-ops", () => {
    const overlay = new HeatmapOverlay();
    assert.doesNotThrow(() => {
      overlay.update(new Float32Array([1]), ANCHORS);
      overlay.clear();
      overlay.clear();
    });
  });
});
