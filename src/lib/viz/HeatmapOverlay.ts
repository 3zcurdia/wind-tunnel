import { BufferAttribute, BufferGeometry, DynamicDrawUsage } from "three";
import { DOMAIN } from "../sim/types";
import { pressureColorInto } from "./colormaps";

/**
 * Surface pressure heatmap (F015): paints per-vertex CFD pressure onto the
 * displayed model as vertex colors (blue = low, near-white = ambient,
 * red = high) via `pressureColor`.
 *
 * Pure-ish module — no React, no wasm imports. The driver (TEMPORARY
 * `voxelBridge` heatmap section now, `SimEngine` via F019 later) passes the
 * zero-copy wasm pressure view each frame; this class never touches wasm
 * memory ownership and holds no scene nodes, only attribute writes.
 *
 * Kept free of non-erasable TS syntax (like `colormaps.ts`) so the
 * `node --test` harness can import it directly (see
 * `HeatmapOverlay.test.mjs`).
 */

/**
 * 1 lattice cell = 0.1 world units. Must match `SceneManager.latticeToWorld`
 * (F002/F006) — `attach` inverts that mapping to recover lattice coords.
 */
const LATTICE_TO_WORLD = 0.1;

/** Centering offset of the lattice→world mapping (matches SceneManager). */
const WORLD_OFFSET = {
  x: (-DOMAIN.nx / 2) * LATTICE_TO_WORLD,
  y: (-DOMAIN.ny / 2) * LATTICE_TO_WORLD,
  z: (-DOMAIN.nz / 2) * LATTICE_TO_WORLD,
} as const;

/** F006's dedup quantum: coordinates are quantized at 1e-6 before dedup. */
const DEDUP_QUANTUM = 1000000;

/** Anchor triple for pressure normalization — the exact shape F019 calls with. */
export interface PressureHeatmapAnchors {
  readonly pMinPa: number;
  readonly pMaxPa: number;
  readonly qRefPa: number;
}

/**
 * Display normalization (F015 spec §Context):
 * `t = clamp((p − p_min) / max(p_max − p_min, q_ref × 0.25), 0, 1)`.
 * The `q_ref × 0.25` denominator floor keeps the map meaningful before the
 * flow develops (all-zero field → t = 0, deep blue — not a divide-by-zero).
 *
 * No-data inputs map to t = 0.5 (mid-gray/ambient white — never
 * black/garbage): non-finite pressures, non-finite anchors, or a
 * non-positive denominator (no mesh / no conditions yet).
 */
export function normalizePressure(
  p: number,
  anchors: PressureHeatmapAnchors,
): number {
  if (!Number.isFinite(p)) return 0.5;
  const { pMinPa, pMaxPa, qRefPa } = anchors;
  if (
    !Number.isFinite(pMinPa) ||
    !Number.isFinite(pMaxPa) ||
    !Number.isFinite(qRefPa)
  ) {
    return 0.5;
  }
  const span = pMaxPa - pMinPa;
  const denom = Math.max(span, qRefPa * 0.25);
  if (!(denom > 0) || !Number.isFinite(denom)) return 0.5;
  const t = (p - pMinPa) / denom;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

/**
 * Quantize one lattice coordinate exactly like F006's
 * `deduplicate_vertices`: `(v as f64) * 1e6`, rounded half away from zero
 * (Rust `f64::round` — `Math.round` differs for negative halves, rounding
 * them toward +∞, so the sign/magnitude form is used).
 *
 * Non-finite inputs mirror Rust's saturating `as i64` cast (NaN → 0,
 * ±∞ → ±i64::MAX) so they form deterministic keys instead of throwing.
 * Real loader output is always finite; these paths only keep garbage input
 * crash-free.
 */
function quantizeLattice(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v === Number.POSITIVE_INFINITY) return 9223372036854775807;
  if (v === Number.NEGATIVE_INFINITY) return -9223372036854775807;
  const scaled = v * DEDUP_QUANTUM;
  if (!Number.isFinite(scaled)) {
    return v > 0 ? 9223372036854775807 : -9223372036854775807;
  }
  return Math.sign(scaled) * Math.round(Math.abs(scaled));
}

function compareKeys(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

/**
 * Replicate F006's dedup ordering for domain-space (lattice) positions:
 * returns, per input vertex, its index into the sorted unique-vertex list —
 * i.e. its row in the wasm `vertex_pressure` buffer (see DECISIONS.md
 * F015.1 for why the display order cannot be used directly).
 *
 * Pure and allocation-light at call time (one key array + one order array);
 * `attach` calls it once per model swap, never per frame.
 */
export function buildStoredIndexMap(lattice: Float32Array): Int32Array {
  const count = Math.floor(lattice.length / 3);
  const keys = new Array<[number, number, number]>(count);
  for (let i = 0; i < count; i += 1) {
    keys[i] = [
      quantizeLattice(lattice[i * 3] ?? 0),
      quantizeLattice(lattice[i * 3 + 1] ?? 0),
      quantizeLattice(lattice[i * 3 + 2] ?? 0),
    ];
  }
  const order = keys.map((_, i) => i).sort((a, b) => {
    const ka = keys[a];
    const kb = keys[b];
    if (ka === undefined || kb === undefined) return 0;
    return compareKeys(ka, kb);
  });
  const map = new Int32Array(count);
  let stored = -1;
  let prev: [number, number, number] | null = null;
  for (const i of order) {
    const key = keys[i];
    if (key === undefined) continue;
    if (
      prev === null ||
      key[0] !== prev[0] ||
      key[1] !== prev[1] ||
      key[2] !== prev[2]
    ) {
      stored += 1;
      prev = key;
    }
    map[i] = stored;
  }
  return map;
}

/**
 * Writes wasm vertex-pressure colors onto a model's `color` attribute.
 *
 * Driver-agnostic: the caller passes the pressure view + anchors each frame
 * (TEMPORARY `voxelBridge` driver now, `SimEngine` via F019 later — the
 * `update` signature is the exact shape F019 will call). The class holds no
 * scene nodes and never imports wasm modules.
 */
export class HeatmapOverlay {
  private geometry: BufferGeometry | null = null;
  private colorAttr: BufferAttribute | null = null;
  private indexMap: Int32Array | null = null;
  // Starts at 0 so the first update() paints (counter is incremented before
  // the modulo check): paints on calls 1, 4, 7, … — every 3rd frame per spec.
  private frames = 0;

  /** The geometry this overlay is currently attached to (null when detached). */
  get attachedGeometry(): BufferGeometry | null {
    return this.geometry;
  }

  /**
   * Attach to a displayed (world-space) model geometry: (re)creates its
   * `color` attribute (`3·vertexCount`, `DynamicDrawUsage`, initialized to
   * ambient mid so the mesh is never black before the first update) and
   * builds the display-vertex → stored-pressure-row index map by inverting
   * `showModel`'s lattice→world transform and replicating F006's dedup
   * order (see DECISIONS.md F015.1). Idempotent per geometry swap — calling
   * again with a new geometry detaches the old one first. Material switching
   * (`vertexColors`) stays with the caller via
   * `SceneManager.setModelVertexColors`, which only the SceneManager can do.
   */
  attach(geometry: BufferGeometry): void {
    this.clear();
    this.geometry = geometry;
    const position = geometry.getAttribute("position") as
      | BufferAttribute
      | undefined;
    const count = position?.count ?? 0;
    if (!position || count === 0) {
      this.indexMap = new Int32Array(0);
      return;
    }
    const source = position.array as ArrayLike<number>;
    const lattice = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      lattice[i * 3] =
        (Number(source[i * 3] ?? 0) - WORLD_OFFSET.x) / LATTICE_TO_WORLD;
      lattice[i * 3 + 1] =
        (Number(source[i * 3 + 1] ?? 0) - WORLD_OFFSET.y) / LATTICE_TO_WORLD;
      lattice[i * 3 + 2] =
        (Number(source[i * 3 + 2] ?? 0) - WORLD_OFFSET.z) / LATTICE_TO_WORLD;
    }
    this.indexMap = buildStoredIndexMap(lattice);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      pressureColorInto(0.5, colors, i * 3);
    }
    this.colorAttr = new BufferAttribute(colors, 3);
    this.colorAttr.setUsage(DynamicDrawUsage);
    geometry.setAttribute("color", this.colorAttr);
    this.frames = 0;
  }

  /**
   * Fill colors from the wasm vertex-pressure view (stored-vertex order) +
   * anchors. Throttled to every 3rd call; stale-geometry and short-buffer
   * inputs degrade to mid-gray per vertex instead of crashing (model-swap
   * safety). No-op when detached.
   */
  update(
    pressure: Float32Array,
    anchors: PressureHeatmapAnchors,
  ): void {
    const attr = this.colorAttr;
    const map = this.indexMap;
    if (!attr || !map || !this.geometry) return;
    this.frames += 1;
    if (this.frames % 3 !== 1) return;
    const colors = attr.array as Float32Array;
    const count = Math.min(map.length, Math.floor(colors.length / 3));
    const available = pressure.length;
    for (let i = 0; i < count; i += 1) {
      const stored = map[i] ?? -1;
      const p =
        stored >= 0 && stored < available ? (pressure[stored] ?? NaN) : NaN;
      pressureColorInto(normalizePressure(p, anchors), colors, i * 3);
    }
    attr.needsUpdate = true;
  }

  /**
   * Detach: remove the `color` attribute from the attached geometry and drop
   * all state. The caller restores the base material via
   * `SceneManager.setModelVertexColors(false)`. Idempotent; safe on an
   * already-disposed geometry (`deleteAttribute` only drops the JS-side
   * attribute entry).
   */
  clear(): void {
    const geometry = this.geometry;
    this.geometry = null;
    this.colorAttr = null;
    this.indexMap = null;
    this.frames = 0;
    if (geometry) geometry.deleteAttribute("color");
  }
}
