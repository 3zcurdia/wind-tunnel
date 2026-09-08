/**
 * Unit checks for the F018 `derivedValues` display math in `conditions.ts`
 * (F018 test plan — the four hand-computed defaults plus clamp-edge cases).
 *
 * Run with Node's built-in runner — no framework install needed:
 *   node --test src/lib/sim/conditions.test.mjs
 *
 * Same `.mjs`-imports-`.ts` wrapper pattern as `types.test.mjs`:
 * explicit extension satisfies both Node's type stripping and `tsc`, so
 * `conditions.ts` stays free of non-erasable syntax.
 *
 * Hand derivations (R = 287.05, T = 293.15, R·T = 84148.7075) at the ARCH
 * defaults U = 15 m/s, P = 101.325 kPa, μ = 1.81e-5 Pa·s, L = 0.25 m:
 *   ρ = 101325 / 84148.7075 = 1.2041183164 kg/m³
 *   ν = 1.81e-5 / 1.2041183164 = 1.5031745431e-5 m²/s
 *   q = ½·1.2041183164·15² = 135.4633106 Pa
 *   Re = 15·0.25 / 1.5031745431e-5 = 249472.0269
 * (independent values cross-checked against `wasm/src/units.rs` tests.)
 *
 * NOTE — spec-print deviations, see DECISIONS.md §F018.4: the spec prints
 * ν = 1.506e-5 (matches μ ≈ 1.813e-5, not the stated μ = 1.81e-5 — the same
 * F009 §4a mismatch) and q_ref = 135.5 Pa at P = 101.325 while the slider
 * default is P = 101.3 (the 0.5 kPa step nearest sea level). The true
 * literals are asserted tightly below, with extra assertions pinning both
 * mismatches so a future edit to the printed (wrong) values fails loudly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AIR_PRESSURE_RANGE,
  DEFAULT_CHAR_LEN_M,
  DEFAULT_CONDITIONS,
  DOMAIN_LENGTH_M,
  VISCOSITY_COEF_RANGE,
  WIND_SPEED_RANGE,
  derivedValues,
  viscosityCoefToPas,
  viscosityPasToCoef,
} from "./conditions.ts";

const REL = 1e-9;

function assertRel(actual, expected, label) {
  const denom = Math.abs(expected) < 1e-300 ? 1 : Math.abs(expected);
  assert.ok(
    Math.abs(actual - expected) / denom < REL,
    `${label}: got ${actual}, want ${expected}`,
  );
}

describe("derivedValues at ARCH defaults (15 m/s, 101.325 kPa, 1.81e-5 Pa·s, 0.25 m)", () => {
  const d = derivedValues(15, 101.325, 1.81e-5, 0.25);

  it("matches hand-computed air density ρ = 1.2041 kg/m³", () => {
    assertRel(d.rhoKgM3, 1.2041183164, "rhoKgM3");
    assert.strictEqual(d.rhoKgM3.toFixed(3), "1.204");
  });

  it("matches the true kinematic viscosity ν = 1.5031745431e-5 m²/s", () => {
    assertRel(d.nuM2S, 1.5031745431e-5, "nuM2S");
    // Pins the spec-print deviation: 1.506e-5 does NOT match μ = 1.81e-5.
    assert.ok(
      Math.abs(d.nuM2S - 1.506e-5) > 1e-9,
      "spec's printed 1.506e-5 unexpectedly matches; see DECISIONS.md §F018.4",
    );
  });

  it("matches hand-computed q_ref = 135.4633106 Pa (≈ 0.5·ρ·40² = 963.2 Pa at 40 m/s)", () => {
    assertRel(d.qRefPa, 135.4633106, "qRefPa");
    assertRel(derivedValues(40, 101.325, 1.81e-5, 0.25).qRefPa, 963.2946531, "qRefPa@40");
  });

  it("matches hand-computed Re = 249472.0269 (≈ 2.49e5)", () => {
    assertRel(d.re, 249472.0269, "re");
  });
});

describe("slider defaults stay within a hair of the hand values", () => {
  it("P = 101.3 (slider default) agrees with P = 101.325 to 0.1 %", () => {
    const s = derivedValues(
      DEFAULT_CONDITIONS.uMps,
      DEFAULT_CONDITIONS.pressureKpa,
      DEFAULT_CONDITIONS.viscosityPas,
      DEFAULT_CHAR_LEN_M,
    );
    for (const [key, want] of [
      ["rhoKgM3", 1.2041183164],
      ["nuM2S", 1.5031745431e-5],
      ["qRefPa", 135.4633106],
      ["re", 249472.0269],
    ]) {
      const got = s[key];
      assert.ok(
        Math.abs(got - want) / want < 1e-3,
        `${key}: slider-default ${got} differs from hand value ${want} by ≥ 0.1 %`,
      );
    }
  });
});

describe("clamp-edge cases (total function — zeros, never NaN)", () => {
  it("zeroes everything on non-finite or non-positive P/μ", () => {
    for (const args of [
      [Number.NaN, 101.325, 1.81e-5, 0.25],
      [15, Number.NaN, 1.81e-5, 0.25],
      [15, 101.325, Number.NaN, 0.25],
      [15, 101.325, 1.81e-5, Number.NaN],
      [15, 0, 1.81e-5, 0.25],
      [15, -50, 1.81e-5, 0.25],
      [15, 101.325, 0, 0.25],
      [15, 101.325, -1e-5, 0.25],
      [15, 101.325, 1.81e-5, -0.25],
      [15, Number.POSITIVE_INFINITY, 1.81e-5, 0.25],
    ]) {
      const d = derivedValues(args[0], args[1], args[2], args[3]);
      assert.deepStrictEqual(d, { rhoKgM3: 0, nuM2S: 0, qRefPa: 0, re: 0 });
    }
  });

  it("U = 0 still reports ρ/ν but zeroes q_ref and Re", () => {
    const d = derivedValues(0, 101.325, 1.81e-5, 0.25);
    assert.ok(d.rhoKgM3 > 0 && d.nuM2S > 0);
    assert.strictEqual(d.qRefPa, 0);
    assert.strictEqual(d.re, 0);
  });

  it("negative U clamps to 0 (no negative Re)", () => {
    const d = derivedValues(-10, 101.325, 1.81e-5, 0.25);
    assert.strictEqual(d.qRefPa, 0);
    assert.strictEqual(d.re, 0);
  });
});

describe("viscosity slider converters", () => {
  it("round-trips the 1.81 default coefficient", () => {
    // 1.81 * 1e-5 is not bit-identical to the 1.81e-5 literal (binary
    // floating point), so the product asserts use relative tolerance while
    // the exact-inverse direction stays strict.
    assertRel(viscosityCoefToPas(1.81), 1.81e-5, "coefToPas(1.81)");
    assertRel(viscosityPasToCoef(1.81e-5), 1.81, "pasToCoef(1.81e-5)");
    assert.strictEqual(
      viscosityPasToCoef(viscosityCoefToPas(2.35)),
      2.35,
    );
    // Round-trip through both directions is self-consistent to 1e-12.
    const rt = viscosityPasToCoef(viscosityCoefToPas(1.81));
    assert.ok(Math.abs(rt - 1.81) / 1.81 < 1e-12, `round trip drifted: ${rt}`);
  });
});

describe("ranges and constants", () => {
  it("defaults sit inside the slider ranges", () => {
    assert.ok(
      DEFAULT_CONDITIONS.uMps >= WIND_SPEED_RANGE.min &&
        DEFAULT_CONDITIONS.uMps <= WIND_SPEED_RANGE.max,
    );
    assert.ok(
      DEFAULT_CONDITIONS.pressureKpa >= AIR_PRESSURE_RANGE.min &&
        DEFAULT_CONDITIONS.pressureKpa <= AIR_PRESSURE_RANGE.max,
    );
    const coef = viscosityPasToCoef(DEFAULT_CONDITIONS.viscosityPas);
    assert.ok(
      coef >= VISCOSITY_COEF_RANGE.min && coef <= VISCOSITY_COEF_RANGE.max,
    );
  });

  it("pins the JS-owned physical constants", () => {
    assert.strictEqual(DOMAIN_LENGTH_M, 1.0);
    assert.strictEqual(DEFAULT_CHAR_LEN_M, 0.25);
  });
});
