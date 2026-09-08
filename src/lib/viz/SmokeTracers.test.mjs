/**
 * Unit checks for `SmokeTracers.ts` (F016 test plan — injected fake sampler,
 * no wasm needed).
 *
 * Run with Node's built-in runner — no framework install needed:
 *   node --test src/lib/viz/SmokeTracers.test.mjs
 *
 * Same transpile harness as `HeatmapOverlay.test.mjs`: `SmokeTracers.ts`
 * imports `three` (bare — resolves via the repo's node_modules because the
 * temp dir lives inside the viz folder) and `../sim/types` with an
 * extensionless TS-idiomatic specifier, which plain Node cannot resolve. So
 * this file transpiles the real sources in-memory with the repo's own
 * `typescript` devDependency, rewrites the relative specifier to the local
 * transpiled copy (mechanical string replacement — no logic is copied or
 * stubbed), and imports the result. Everything asserted on is the real
 * implementation; the temp dir is removed in `after()`.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Group } from "three";

const HERE = new URL(".", import.meta.url).pathname;
let tmpDir = null;

async function loadRealModule() {
  const { default: ts } = await import("typescript");
  const dir = mkdtempSync(join(HERE, ".tmp-smoke-"));
  tmpDir = dir;
  try {
    const sources = {
      "SmokeTracers.mjs": "SmokeTracers.ts",
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
        .join('from "./types.mjs"');
      writeFileSync(join(dir, out), fixed);
    }
    return await import(pathToFileURL(join(dir, "SmokeTracers.mjs")).href);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    tmpDir = null;
    throw err;
  }
}

let SmokeTracers;
let DOMAIN;

before(async () => {
  const mod = await loadRealModule();
  SmokeTracers = mod.SmokeTracers;
  const types = await import("../sim/types.ts");
  DOMAIN = types.DOMAIN;
});

after(() => {
  if (tmpDir !== null) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

/** Sampler stubbing a constant velocity everywhere. */
function constantSampler(vx, vy, vz) {
  return (points, out) => {
    for (let i = 0; i < out.length; i += 3) {
      out[i] = vx;
      out[i + 1] = vy;
      out[i + 2] = vz;
    }
  };
}

/** Zero-field sampler (solid interiors read as zero per F011). */
function zeroSampler() {
  return (points, out) => {
    out.fill(0);
  };
}

function closeTo(actual, expected, eps = 1e-5) {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `${actual} !~= ${expected}`,
  );
}

describe("SmokeTracers seeding", () => {
  it("seeds a vertical line at seedX with default rake geometry", () => {
    const layer = new Group();
    const tracers = new SmokeTracers(layer, { tracerCount: 5, historyLen: 8 });
    try {
      assert.strictEqual(tracers.tracerCount, 5);
      assert.strictEqual(tracers.historyLen, 8);
      assert.strictEqual(tracers.head, 0);
      // Even spacing: y = 24−8 .. 24+8 over 5 tracers (ny = 48).
      const expectedY = [16, 20, 24, 28, 32];
      for (let i = 0; i < 5; i += 1) {
        closeTo(tracers.pos[i * 3], 2.0);
        closeTo(tracers.pos[i * 3 + 1], expectedY[i]);
        closeTo(tracers.pos[i * 3 + 2], DOMAIN.nz / 2);
      }
      // Trails start collapsed onto the seeds (no cross-domain streaks).
      for (let i = 0; i < 5; i += 1) {
        for (let s = 0; s < 8; s += 1) {
          const o = (i * 8 + s) * 3;
          closeTo(tracers.trail[o], tracers.pos[i * 3]);
          closeTo(tracers.trail[o + 1], tracers.pos[i * 3 + 1]);
          closeTo(tracers.trail[o + 2], tracers.pos[i * 3 + 2]);
        }
      }
    } finally {
      tracers.dispose();
    }
  });

  it("applies the lattice→world parent transform to the smoke layer", () => {
    const layer = new Group();
    const tracers = new SmokeTracers(layer, {});
    try {
      closeTo(layer.scale.x, 0.1, 1e-9);
      closeTo(layer.position.x, (-DOMAIN.nx / 2) * 0.1, 1e-9);
      closeTo(layer.position.y, (-DOMAIN.ny / 2) * 0.1, 1e-9);
      closeTo(layer.position.z, (-DOMAIN.nz / 2) * 0.1, 1e-9);
    } finally {
      tracers.dispose();
    }
  });
});

describe("SmokeTracers update", () => {
  it("linear field moves tracers at constant velocity (p += v·dt)", () => {
    const layer = new Group();
    const tracers = new SmokeTracers(layer, { tracerCount: 3, historyLen: 8 });
    try {
      const x0 = Array.from({ length: 3 }, (_, i) => tracers.pos[i * 3]);
      tracers.update(1.0, constantSampler(0.1, 0.02, 0));
      for (let i = 0; i < 3; i += 1) {
        closeTo(tracers.pos[i * 3], x0[i] + 0.1);
        closeTo(
          tracers.pos[i * 3 + 1],
          16 + i * 8 + 0.02,
        );
      }
      // Second step advances by the same increment (constant field).
      tracers.update(1.0, constantSampler(0.1, 0.02, 0));
      for (let i = 0; i < 3; i += 1) {
        closeTo(tracers.pos[i * 3], x0[i] + 0.2);
      }
    } finally {
      tracers.dispose();
    }
  });

  it("ring overwrite wraps cleanly after historyLen steps (head math)", () => {
    const layer = new Group();
    const k = 4;
    const tracers = new SmokeTracers(layer, { tracerCount: 2, historyLen: k });
    try {
      const steps = 11;
      for (let n = 0; n < steps; n += 1) {
        tracers.update(1.0, constantSampler(0.1, 0, 0));
        // Head advances by exactly one slot per update, modulo K.
        assert.strictEqual(tracers.head, (n + 1) % k);
      }
      // Newest slot holds the live head position for every tracer.
      for (let i = 0; i < 2; i += 1) {
        const o = (i * k + tracers.head) * 3;
        closeTo(tracers.trail[o], tracers.pos[i * 3]);
        closeTo(tracers.trail[o + 1], tracers.pos[i * 3 + 1]);
        closeTo(tracers.trail[o + 2], tracers.pos[i * 3 + 2]);
      }
      // x travelled exactly steps × 0.1 from the seed plane (nothing lost).
      closeTo(tracers.pos[0], 2.0 + steps * 0.1);
    } finally {
      tracers.dispose();
    }
  });

  it("freezes on solid (zero field) — stagnation, not death", () => {
    const layer = new Group();
    const tracers = new SmokeTracers(layer, { tracerCount: 2, historyLen: 6 });
    try {
      const before = Array.from(tracers.pos);
      for (let n = 0; n < 10; n += 1) tracers.update(1.0, zeroSampler());
      assert.deepStrictEqual(Array.from(tracers.pos), before);
      // The ring kept recording the stuck head (all slots equal the seed).
      for (const v of tracers.trail) assert.ok(Number.isFinite(v));
      for (let i = 0; i < 2; i += 1) {
        for (let s = 0; s < 6; s += 1) {
          const o = (i * 6 + s) * 3;
          closeTo(tracers.trail[o], before[i * 3]);
        }
      }
    } finally {
      tracers.dispose();
    }
  });

  it("freezes at the domain edge instead of leaving", () => {
    const layer = new Group();
    const tracers = new SmokeTracers(layer, { tracerCount: 1, historyLen: 4 });
    try {
      // Rake at x = nx − 0.5, then push hard +x: must never exit.
      tracers.seedX = DOMAIN.nx - 0.5;
      tracers.setRake(DOMAIN.ny / 2, DOMAIN.nz / 2, 0);
      for (let n = 0; n < 5; n += 1) {
        tracers.update(1.0, constantSampler(5.0, 0, 0));
        assert.ok(tracers.pos[0] < DOMAIN.nx);
        assert.ok(tracers.pos[0] >= 0);
      }
      closeTo(tracers.pos[0], DOMAIN.nx - 0.5);
      for (const v of tracers.pos) assert.ok(Number.isFinite(v));
    } finally {
      tracers.dispose();
    }
  });

  it("ignores non-finite samples and non-positive dt", () => {
    const layer = new Group();
    const tracers = new SmokeTracers(layer, { tracerCount: 1, historyLen: 4 });
    try {
      const before = Array.from(tracers.pos);
      tracers.update(1.0, constantSampler(Number.NaN, 0, 0));
      assert.deepStrictEqual(Array.from(tracers.pos), before);
      tracers.update(0, constantSampler(1, 0, 0));
      tracers.update(Number.NaN, constantSampler(1, 0, 0));
      assert.deepStrictEqual(Array.from(tracers.pos), before);
      for (const v of tracers.pos) assert.ok(Number.isFinite(v));
    } finally {
      tracers.dispose();
    }
  });
});

describe("SmokeTracers controls", () => {
  it("setRake moves the line and clears trails", () => {
    const layer = new Group();
    const tracers = new SmokeTracers(layer, { tracerCount: 3, historyLen: 6 });
    try {
      tracers.update(1.0, constantSampler(0.5, 0, 0));
      assert.ok(tracers.pos[0] > 2.0);
      tracers.setRake(10, 12, 2);
      assert.deepStrictEqual({ ...tracers.rake }, { yCenter: 10, zCenter: 12, halfWidth: 2 });
      // y = 8, 10, 12; z = 12; trails collapsed onto the new seeds.
      const expectedY = [8, 10, 12];
      for (let i = 0; i < 3; i += 1) {
        closeTo(tracers.pos[i * 3 + 1], expectedY[i]);
        closeTo(tracers.pos[i * 3 + 2], 12);
        for (let s = 0; s < 6; s += 1) {
          const o = (i * 6 + s) * 3;
          closeTo(tracers.trail[o + 1], expectedY[i]);
        }
      }
    } finally {
      tracers.dispose();
    }
  });

  it("setHistoryLen rebuilds buffers without artifacts or leaks", () => {
    const layer = new Group();
    const tracers = new SmokeTracers(layer, { tracerCount: 2, historyLen: 6 });
    try {
      tracers.update(1.0, constantSampler(0.3, 0, 0));
      const childrenBefore = layer.children.length;
      tracers.setHistoryLen(10);
      assert.strictEqual(tracers.historyLen, 10);
      assert.strictEqual(tracers.trail.length, 2 * 10 * 3);
      // Still exactly one LineSegments on the layer (old geometry disposed).
      assert.strictEqual(layer.children.length, childrenBefore);
      // Trails re-seeded from the live heads — no stale far-away points.
      for (let i = 0; i < 2; i += 1) {
        for (let s = 0; s < 10; s += 1) {
          const o = (i * 10 + s) * 3;
          closeTo(tracers.trail[o], tracers.pos[i * 3]);
        }
      }
      // No-op for the same value (same backing store).
      const trail = tracers.trail;
      tracers.setHistoryLen(10);
      assert.strictEqual(tracers.trail, trail);
      // Update keeps working after the rebuild.
      tracers.update(1.0, constantSampler(0.3, 0, 0));
      for (const v of tracers.pos) assert.ok(Number.isFinite(v));
    } finally {
      tracers.dispose();
    }
  });

  it("head vertex is #e5e7eb, tail vertex is #1f2937", () => {
    const layer = new Group();
    const tracers = new SmokeTracers(layer, { tracerCount: 1, historyLen: 5 });
    try {
      const color = layer.children[0].geometry.getAttribute("color");
      const array = color.array;
      const head = [0xe5 / 255, 0xe7 / 255, 0xeb / 255];
      const tail = [0x1f / 255, 0x29 / 255, 0x37 / 255];
      // Segment 0 endpoint 0 is trail-age 0 → head color.
      for (let c = 0; c < 3; c += 1) closeTo(array[c], head[c], 1e-6);
      // Last segment endpoint 1 is trail-age K−1 → tail color.
      const last = ((5 - 1 - 1) * 2 + 1) * 3;
      for (let c = 0; c < 3; c += 1) closeTo(array[last + c], tail[c], 1e-6);
    } finally {
      tracers.dispose();
    }
  });

  it("dispose is idempotent and removes the lines from the layer", () => {
    const layer = new Group();
    const tracers = new SmokeTracers(layer, {});
    assert.strictEqual(layer.children.length, 1);
    tracers.dispose();
    assert.strictEqual(layer.children.length, 0);
    assert.doesNotThrow(() => {
      tracers.dispose();
      tracers.update(1.0, constantSampler(1, 0, 0));
      tracers.setRake(1, 2, 3);
      tracers.setHistoryLen(30);
    });
  });
});
