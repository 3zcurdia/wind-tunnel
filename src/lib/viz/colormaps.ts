/**
 * Shared color ramps for flow visualization (F014; reused by F015/F016).
 *
 * Pure module — no React, no three.js, no wasm. Safe to import anywhere,
 * including Node (`node --test`, see `colormaps.test.mjs`).
 *
 * Both ramps clamp `t` to [0, 1]; non-finite input maps to 0 (the slow/cold
 * end) so a stray NaN speed never throws or paints white-hot.
 *
 * The `*Into` twins write into a caller-owned `Float32Array` at an offset
 * with zero allocation — they share the exact ramp the pure functions use
 * and exist for the per-frame particle/vertex fill loops (F014/F015), where
 * one tuple allocation per item would pressure the GC at 100k items.
 */

/** One ramp stop: normalized position plus sRGB channels as 0..1 floats. */
type Stop = readonly [number, number, number, number];

function hex(hexStr: string): [number, number, number] {
  const v = parseInt(hexStr.slice(1), 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

/**
 * 5-stop speed ramp: blue (slow) → cyan → white (mid) → amber → red (fast).
 * All stops are spec constants (F014 §1); interpolation between stops is linear.
 */
const SPEED_STOPS: ReadonlyArray<Stop> = [
  [0.0, ...hex("#1d4ed8")],
  [0.25, ...hex("#06b6d4")],
  [0.5, ...hex("#e5e7eb")],
  [0.75, ...hex("#f59e0b")],
  [1.0, ...hex("#dc2626")],
];

/** Diverging pressure ramp: blue (low) → near-white (ambient) → red (high). */
const PRESSURE_STOPS: ReadonlyArray<Stop> = [
  [0.0, ...hex("#2563eb")],
  [0.5, ...hex("#f3f4f6")],
  [1.0, ...hex("#dc2626")],
];

function clamp01(t: number): number {
  if (!Number.isFinite(t)) return 0;
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

function rampInto(
  stops: ReadonlyArray<Stop>,
  t: number,
  out: Float32Array,
  offset: number,
): void {
  const c = clamp01(t);
  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i];
    const b = stops[i + 1];
    if (c <= b[0] || i === stops.length - 2) {
      const span = b[0] - a[0];
      const f = span > 0 ? (c - a[0]) / span : 0;
      out[offset] = a[1] + (b[1] - a[1]) * f;
      out[offset + 1] = a[2] + (b[2] - a[2]) * f;
      out[offset + 2] = a[3] + (b[3] - a[3]) * f;
      return;
    }
  }
  // Unreachable (the loop always returns on the last segment); keeps the
  // function total for zero-length peace of mind.
  const last = stops[stops.length - 1];
  out[offset] = last[1];
  out[offset + 1] = last[2];
  out[offset + 2] = last[3];
}

/** Map a normalized speed to an sRGB triple (0..1 floats). */
export function speedColor(t: number): [number, number, number] {
  const out = new Float32Array(3);
  rampInto(SPEED_STOPS, t, out, 0);
  return [out[0], out[1], out[2]];
}

/** Map a normalized pressure to an sRGB triple (0..1 floats). */
export function pressureColor(t: number): [number, number, number] {
  const out = new Float32Array(3);
  rampInto(PRESSURE_STOPS, t, out, 0);
  return [out[0], out[1], out[2]];
}

/**
 * Allocation-free `speedColor`: writes the ramp result at `out[offset..+2]`.
 * Out-of-bounds offsets are ignored (never throws — hot-loop safe).
 */
export function speedColorInto(
  t: number,
  out: Float32Array,
  offset: number,
): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + 2 >= out.length) return;
  rampInto(SPEED_STOPS, t, out, offset);
}

/**
 * Allocation-free `pressureColor`: writes the ramp result at `out[offset..+2]`.
 * Out-of-bounds offsets are ignored (never throws — hot-loop safe).
 */
export function pressureColorInto(
  t: number,
  out: Float32Array,
  offset: number,
): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + 2 >= out.length) return;
  rampInto(PRESSURE_STOPS, t, out, offset);
}
