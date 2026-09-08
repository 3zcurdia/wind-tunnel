/**
 * Unit checks for the F017 `SimReadout` format helpers in `types.ts`
 * (F017 test plan — the `formatReadout` pure-helper suggestion, split per
 * field so failure messages name the format).
 *
 * Run with Node's built-in runner — no framework install needed:
 *   node --test src/lib/sim/types.test.mjs
 *
 * Same `.mjs`-imports-`.ts` wrapper pattern as `colormaps.test.mjs`:
 * explicit extension satisfies both Node's type stripping and `tsc`, so
 * `types.ts` stays free of non-erasable syntax.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  READOUT_PLACEHOLDER,
  formatCd,
  formatDragN,
  formatInt,
  formatKPa,
  formatRe,
  formatTriangles,
} from "./types.ts";

describe("formatCd", () => {
  it("renders 3 decimals", () => {
    assert.strictEqual(formatCd(1.23456), "1.235");
    assert.strictEqual(formatCd(0), "0.000");
  });

  it("maps null, the -1 sentinel, and non-finite to the placeholder", () => {
    assert.strictEqual(formatCd(null), READOUT_PLACEHOLDER);
    assert.strictEqual(formatCd(-1), READOUT_PLACEHOLDER);
    assert.strictEqual(formatCd(Number.NaN), READOUT_PLACEHOLDER);
    assert.strictEqual(formatCd(Number.POSITIVE_INFINITY), READOUT_PLACEHOLDER);
  });
});

describe("formatDragN", () => {
  it("renders 2 decimals", () => {
    assert.strictEqual(formatDragN(12.4963), "12.50");
    assert.strictEqual(formatDragN(0), "0.00");
  });

  it("maps null and non-finite to the placeholder", () => {
    assert.strictEqual(formatDragN(null), READOUT_PLACEHOLDER);
    assert.strictEqual(formatDragN(Number.NaN), READOUT_PLACEHOLDER);
  });
});

describe("formatKPa", () => {
  it("converts Pa to kPa with 2 decimals", () => {
    // Default operating point: q_ref = 0.5·1.2041·15² ≈ 135.5 Pa.
    assert.strictEqual(formatKPa(135.46), "0.14");
    assert.strictEqual(formatKPa(0), "0.00");
    assert.strictEqual(formatKPa(-175.97), "-0.18");
  });

  it("maps non-finite to the placeholder", () => {
    assert.strictEqual(formatKPa(Number.NaN), READOUT_PLACEHOLDER);
  });
});

describe("formatRe", () => {
  it("renders compact scientific like the spec's 2.5e5 example", () => {
    assert.strictEqual(formatRe(249472.03), "2.5e5");
    assert.strictEqual(formatRe(1000), "1.0e3");
  });

  it("maps non-finite to the placeholder", () => {
    assert.strictEqual(formatRe(Number.NaN), READOUT_PLACEHOLDER);
  });
});

describe("formatInt", () => {
  it("rounds to an integer string", () => {
    assert.strictEqual(formatInt(59.6), "60");
    assert.strictEqual(formatInt(0), "0");
  });

  it("maps non-finite to the placeholder", () => {
    assert.strictEqual(formatInt(Number.NaN), READOUT_PLACEHOLDER);
  });
});

describe("formatTriangles", () => {
  it("renders small counts plain and large ones compact", () => {
    assert.strictEqual(formatTriangles(500), "500");
    assert.strictEqual(formatTriangles(12345), "12.3k");
  });

  it("maps null and non-finite to the placeholder", () => {
    assert.strictEqual(formatTriangles(null), READOUT_PLACEHOLDER);
    assert.strictEqual(formatTriangles(Number.NaN), READOUT_PLACEHOLDER);
  });
});
