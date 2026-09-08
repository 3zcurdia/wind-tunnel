import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Points,
  PointsMaterial,
  type Group,
} from "three";
import { DOMAIN } from "../sim/types";
import { speedColorInto } from "./colormaps";

/**
 * 1 lattice cell = 0.1 world units. Must match `SceneManager.latticeToWorld`
 * (F002/F006) — the particles layer carries this as a parent `Group`
 * transform so per-frame updates never convert coordinates per vertex.
 */
const LATTICE_TO_WORLD = 0.1;

/** Per-particle color source. `'pressure'` is a stub until F015 (see below). */
export type ParticleColorMode = "speed" | "pressure";

/**
 * The signature visual (F014): thousands of solver-advected particles as a
 * single `THREE.Points` draw call, colored by speed (slow = blue, fast = red).
 *
 * Driver-agnostic by design: the caller (TEMPORARY `voxelBridge` driver now,
 * `SimEngine` via F019 later) passes zero-copy wasm-memory views each frame —
 * this class never imports wasm modules and never copies on the caller side.
 * Rust owns the pool (F011); this class only mirrors the active prefix into
 * GPU attributes.
 */
export class ParticleSystem {
  /** Fixed GPU capacity (point count), set at construction. */
  readonly capacity: number;

  private readonly geometry = new BufferGeometry();
  private readonly positionAttr: BufferAttribute;
  private readonly colorAttr: BufferAttribute;
  private readonly material: PointsMaterial;
  private readonly points: Points;
  // Starts at 1 so the first update() paints colors (counter is incremented
  // before the even-check): colors refresh on calls 1, 3, 5, … — every 2nd
  // frame — while positions upload on every call.
  private updates = 1;
  private disposed = false;

  /**
   * Build the points cloud on `layer` (usually
   * `SceneManager.getLayer('particles')`) with room for `capacity` points.
   * Applies the lattice→world parent transform to the layer (idempotent —
   * safe to re-apply when SceneManager pre-configured it).
   */
  constructor(layer: Group, capacity = 30000) {
    const cap = Math.max(1, Math.floor(capacity));
    this.capacity = cap;

    layer.scale.setScalar(LATTICE_TO_WORLD);
    layer.position.set(
      (-DOMAIN.nx / 2) * LATTICE_TO_WORLD,
      (-DOMAIN.ny / 2) * LATTICE_TO_WORLD,
      (-DOMAIN.nz / 2) * LATTICE_TO_WORLD,
    );

    this.positionAttr = new BufferAttribute(new Float32Array(cap * 3), 3);
    this.positionAttr.setUsage(DynamicDrawUsage);
    this.colorAttr = new BufferAttribute(new Float32Array(cap * 3), 3);
    this.colorAttr.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute("position", this.positionAttr);
    this.geometry.setAttribute("color", this.colorAttr);
    this.geometry.setDrawRange(0, 0);

    this.material = new PointsMaterial({
      size: 0.06,
      vertexColors: true,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });

    this.points = new Points(this.geometry, this.material);
    // Instance positions span the whole domain with a draw-range window —
    // default frustum culling would use the (empty) base bounds and wrongly
    // cull the cloud.
    this.points.frustumCulled = false;
    layer.add(this.points);
  }

  /**
   * Mirror one frame of pool state into the GPU attributes.
   *
   * `positions` must be the wasm-memory view (no copy by the caller —
   * `Float32Array.set` copies the active prefix here); `active` is clamped
   * to `capacity` and to the views' lengths, so over-long inputs can never
   * overrun the attributes. Positions upload every call; color mapping runs
   * every 2nd call (starting with the first, so frame one is never black).
   *
   * `speedNorm` anchors come from the caller — F019 computes
   * `[0, 1.3 × u_inlet]` in lattice-speed units from the current
   * `LatticeParams`; the 1.3 headroom keeps gap-accelerated particles (which
   * outrun the freestream) on-scale instead of clipping the whole freestream
   * to mid-ramp.
   */
  update(
    positions: Float32Array,
    speeds: Float32Array,
    active: number,
    colorMode: ParticleColorMode,
    speedNorm: { min: number; max: number },
  ): void {
    if (this.disposed) return;
    const count = Math.max(
      0,
      Math.min(active, this.capacity, Math.floor(positions.length / 3), speeds.length),
    );

    const posArray = this.positionAttr.array as Float32Array;
    posArray.set(positions.subarray(0, count * 3));
    this.positionAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, count);

    this.updates += 1;
    if (this.updates % 2 === 0) {
      const colorArray = this.colorAttr.array as Float32Array;
      const span = speedNorm.max - speedNorm.min;
      const inv = span > 0 && Number.isFinite(span) ? 1 / span : 0;
      for (let i = 0; i < count; i += 1) {
        const s = speeds[i] ?? 0;
        let t = (s - speedNorm.min) * inv;
        if (!Number.isFinite(t) || t < 0) t = 0;
        else if (t > 1) t = 1;
        // F014 stub: per-particle pressure data arrives with F015 — until
        // then 'pressure' mode intentionally falls back to the speed ramp so
        // the toggle compiles and renders sensibly.
        void colorMode;
        speedColorInto(t, colorArray, i * 3);
      }
      this.colorAttr.needsUpdate = true;
    }
  }

  /** Remove the points from the layer and release GPU resources. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
