/**
 * Unit checks for `colormaps.ts` (F014 test plan).
 *
 * Run with Node's built-in runner — no framework install needed:
 *   node --test src/lib/viz/colormaps.test.mjs
 *
 * A `.mjs` wrapper (not `.test.ts`) so both toolchains resolve it: plain
 * Node cannot resolve extensionless TS imports, while `tsc` (via
 * `next build`) rejects explicit `.ts` import extensions — importing the
 * source with its explicit extension from `.mjs` satisfies both, using
 * Node's type stripping. `colormaps.ts` stays free of non-erasable syntax
 * for exactly this reason.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pressureColor,
  pressureColorInto,
  speedColor,
  speedColorInto,
} from "./colormaps.ts";

/** Back to 0..255 channels for exact hex comparison. */
function toHex(rgb) {
  return rgb.map((v) => Math.round(v * 255));
}

describe("speedColor", () => {
  it("matches the exact stop hex at t=0/0.25/0.5/0.75/1", () => {
    assert.deepStrictEqual(toHex(speedColor(0)), [0x1d, 0x4e, 0xd8]);
    assert.deepStrictEqual(toHex(speedColor(0.25)), [0x06, 0xb6, 0xd4]);
    assert.deepStrictEqual(toHex(speedColor(0.5)), [0xe5, 0xe7, 0xeb]);
    assert.deepStrictEqual(toHex(speedColor(0.75)), [0xf5, 0x9e, 0x0b]);
    assert.deepStrictEqual(toHex(speedColor(1)), [0xdc, 0x26, 0x26]);
  });

  it("clamps out-of-range t to the end stops", () => {
    assert.deepStrictEqual(speedColor(-1), speedColor(0));
    assert.deepStrictEqual(speedColor(2), speedColor(1));
    assert.deepStrictEqual(speedColor(Number.NaN), speedColor(0));
  });

  it("red channel rises monotonically on the cyan→amber span", () => {
    // NOTE: full-range red monotonicity does NOT hold for the spec stops —
    // blue→cyan dips red 29→6 and amber→red dips 245→220 — so the ramp's
    // genuinely monotonic span [0.25, 0.75] (6→229→245) is asserted here.
    let prev = -1;
    for (let t = 0.25; t <= 0.750001; t += 0.05) {
      const red = speedColor(t)[0];
      assert.ok(red >= prev, `red dips at t=${t}: ${red} < ${prev}`);
      prev = red;
    }
  });
});

describe("pressureColor", () => {
  it("matches the exact stop hex at t=0/0.5/1", () => {
    assert.deepStrictEqual(toHex(pressureColor(0)), [0x25, 0x63, 0xeb]);
    assert.deepStrictEqual(toHex(pressureColor(0.5)), [0xf3, 0xf4, 0xf6]);
    assert.deepStrictEqual(toHex(pressureColor(1)), [0xdc, 0x26, 0x26]);
  });

  it("clamps out-of-range t to the end stops", () => {
    assert.deepStrictEqual(pressureColor(-0.5), pressureColor(0));
    assert.deepStrictEqual(pressureColor(1.5), pressureColor(1));
  });
});

describe("Into variants", () => {
  it("agree with the pure functions and write at the given offset", () => {
    const out = new Float32Array(9).fill(-1);
    speedColorInto(0.3, out, 3);
    assert.deepStrictEqual(Array.from(out.subarray(3, 6)), speedColor(0.3));
    assert.strictEqual(out[0], -1);
    assert.strictEqual(out[8], -1);

    pressureColorInto(0.8, out, 0);
    assert.deepStrictEqual(Array.from(out.subarray(0, 3)), pressureColor(0.8));
  });

  it("ignore out-of-bounds offsets instead of throwing", () => {
    const out = new Float32Array(3).fill(0.5);
    assert.doesNotThrow(() => {
      speedColorInto(0.5, out, -3);
      speedColorInto(0.5, out, 1);
      speedColorInto(0.5, out, 3);
      pressureColorInto(0.5, out, 99);
    });
    assert.deepStrictEqual(Array.from(out), [0.5, 0.5, 0.5]);
  });
});
