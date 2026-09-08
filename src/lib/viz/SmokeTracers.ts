import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  LineBasicMaterial,
  LineSegments,
  type Group,
} from "three";
import { DOMAIN } from "../sim/types";

/**
 * Smoke tracer lines (F016): a rake of JS-owned tracer seeds upstream of the
 * model emits continuous ribbons that bend around the body, drawn as fading
 * line trails (`THREE.LineSegments`, color-darkening fade on the dark
 * background — `LineBasicMaterial` has no per-vertex alpha).
 *
 * Driver-agnostic by design: the caller (the F019 frame loop via
 * `SimEngine`) injects a batched sampling closure over
 * `sample_velocity_batch` — this class never imports wasm modules and stays
 * unit-testable with a fake flow field.
 *
 * Solid-hit policy (spec contract): tracers FREEZE at their current position
 * instead of dying. Sampling inside a solid returns (0,0,0) (F011), so
 * `p += v·dt` naturally stalls there; positions leaving the domain are
 * clamped the same way (the old position is re-recorded). The trail then
 * collapses onto the stuck head — visible "stagnant smoke" in wakes, a real
 * wind-tunnel effect.
 *
 * Kept free of non-erasable TS syntax (like `colormaps.ts`/`HeatmapOverlay.ts`)
 * so the `node --test` harness can transpile + import it directly (see
 * `SmokeTracers.test.mjs`).
 */

/**
 * 1 lattice cell = 0.1 world units. Must match `SceneManager.latticeToWorld`
 * (F002/F006) — the smoke layer carries this as a parent `Group` transform
 * (same pattern as `ParticleSystem`), so per-frame updates never convert
 * coordinates per vertex.
 */
const LATTICE_TO_WORLD = 0.1;

/** Head color `#e5e7eb` as 0..1 floats (newest trail vertex, full bright). */
const HEAD_RGB: readonly [number, number, number] = [
  0xe5 / 255,
  0xe7 / 255,
  0xeb / 255,
];
/** Tail color `#1f2937` as 0..1 floats (oldest trail vertex). */
const TAIL_RGB: readonly [number, number, number] = [
  0x1f / 255,
  0x29 / 255,
  0x37 / 255,
];

/** Default tracer count (spec §1). */
export const SMOKE_TRACER_COUNT_DEFAULT = 25;
/** Default trail history length in frames (spec §1: ≈ 1.5 s at 60 fps). */
export const SMOKE_HISTORY_LEN_DEFAULT = 90;
/** Default seed plane x in lattice cells (spec §1). */
export const SMOKE_SEED_X_DEFAULT = 2.0;
/** Class-level history clamp (the UI narrows this to 30..240 per spec §2). */
export const SMOKE_HISTORY_LEN_MIN = 2;
export const SMOKE_HISTORY_LEN_MAX = 240;

/** Rake seed line in lattice cells (spec §1). */
export interface SmokeSeedLine {
  readonly yCenter: number;
  readonly zCenter: number;
  readonly halfWidth: number;
}

/** Constructor options — every field optional, spec defaults apply. */
export interface SmokeTracersOptions {
  readonly tracerCount?: number;
  readonly historyLen?: number;
  readonly seedLine?: Partial<SmokeSeedLine>;
  readonly seedX?: number;
  readonly speedScale?: number;
}

/**
 * Injected batched sampler (spec contract): reads `tracerCount×3`
 * domain-space points, writes `tracerCount×3` lattice velocities. The bridge
 * supplies `(pts, out) => wasm.sample_velocity_batch(pts, out)`.
 */
export type SmokeSampler = (
  points: Float32Array,
  out: Float32Array,
) => void;

function clampHistoryLen(n: number): number {
  if (!Number.isFinite(n)) return SMOKE_HISTORY_LEN_DEFAULT;
  return Math.min(
    SMOKE_HISTORY_LEN_MAX,
    Math.max(SMOKE_HISTORY_LEN_MIN, Math.floor(n)),
  );
}

function resolveSeedLine(
  seedLine: Partial<SmokeSeedLine> | undefined,
): SmokeSeedLine {
  return {
    yCenter: seedLine?.yCenter ?? DOMAIN.ny / 2,
    zCenter: seedLine?.zCenter ?? DOMAIN.nz / 2,
    halfWidth: seedLine?.halfWidth ?? 8,
  };
}

/**
 * JS-owned smoke rake. Positions live in domain space (lattice cells); the
 * `smoke` layer's parent transform maps them to world space.
 */
export class SmokeTracers {
  /** Fixed tracer count (rake size), set at construction. */
  readonly tracerCount: number;
  /** Current history length (frames per trail); changed via `setHistoryLen`. */
  historyLen: number;
  /** Seed plane x in lattice cells. */
  seedX: number;
  /** Velocity gain applied as `p += v·dt·speedScale` (spec default 1.0). */
  speedScale: number;

  /** Current tracer positions (`tracerCount×3`, domain space). */
  readonly pos: Float32Array;
  /** Per-tracer ring history (`tracerCount×historyLen×3`, domain space). */
  trail: Float32Array;
  /** Ring slot holding the newest entry (all tracers share one head). */
  head = 0;

  private seedLine: SmokeSeedLine;
  private readonly pointsScratch: Float32Array;
  private readonly velScratch: Float32Array;
  private geometry: BufferGeometry;
  private positionAttr: BufferAttribute;
  private readonly material: LineBasicMaterial;
  private readonly lines: LineSegments;
  private disposed = false;

  /**
   * Build the rake on `layer` (usually `SceneManager.getLayer('smoke')`).
   * Applies the lattice→world parent transform to the layer (idempotent —
   * safe to re-apply when SceneManager pre-configured it) and seeds the
   * vertical rake line immediately.
   */
  constructor(layer: Group, options: SmokeTracersOptions = {}) {
    const count = Math.max(1, Math.floor(options.tracerCount ?? 25));
    this.tracerCount = count;
    this.historyLen = clampHistoryLen(
      options.historyLen ?? SMOKE_HISTORY_LEN_DEFAULT,
    );
    this.seedX = options.seedX ?? SMOKE_SEED_X_DEFAULT;
    this.speedScale =
      options.speedScale !== undefined &&
      Number.isFinite(options.speedScale) &&
      options.speedScale > 0
        ? options.speedScale
        : 1.0;
    this.seedLine = resolveSeedLine(options.seedLine);

    layer.scale.setScalar(LATTICE_TO_WORLD);
    layer.position.set(
      (-DOMAIN.nx / 2) * LATTICE_TO_WORLD,
      (-DOMAIN.ny / 2) * LATTICE_TO_WORLD,
      (-DOMAIN.nz / 2) * LATTICE_TO_WORLD,
    );

    this.pos = new Float32Array(count * 3);
    this.trail = new Float32Array(count * this.historyLen * 3);
    this.pointsScratch = new Float32Array(count * 3);
    this.velScratch = new Float32Array(count * 3);

    this.material = new LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    this.geometry = new BufferGeometry();
    this.positionAttr = new BufferAttribute(
      new Float32Array(count * (this.historyLen - 1) * 2 * 3),
      3,
    );
    this.positionAttr.setUsage(DynamicDrawUsage);
    const colorAttr = new BufferAttribute(
      new Float32Array(count * (this.historyLen - 1) * 2 * 3),
      3,
    );
    this.geometry.setAttribute("position", this.positionAttr);
    this.geometry.setAttribute("color", colorAttr);
    this.fillStaticColors(colorAttr.array as Float32Array);

    this.lines = new LineSegments(this.geometry, this.material);
    // History always spans the domain, so the base (empty) bounds would
    // wrongly cull the trails (same rationale as `ParticleSystem`).
    this.lines.frustumCulled = false;
    layer.add(this.lines);

    this.reseed();
  }

  /** Current rake line (a copy — mutate via `setRake`). */
  get rake(): SmokeSeedLine {
    return { ...this.seedLine };
  }

  /**
   * Advance every tracer one frame: sample the flow at the current positions,
   * integrate `p += v·dt·speedScale`, freeze (re-record the old position) on
   * solid hits / domain exits / non-finite samples, push the ring head, and
   * rewrite the segment positions. Colors are static (index-based fade).
   */
  update(dt: number, sample: SmokeSampler): void {
    if (this.disposed) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    const count = this.tracerCount;
    const k = this.historyLen;
    const gain = dt * this.speedScale;
    if (!Number.isFinite(gain) || gain <= 0) return;

    // Scratch copy so a misbehaving sampler can never corrupt `pos`.
    this.pointsScratch.set(this.pos);
    this.velScratch.fill(0);
    sample(this.pointsScratch, this.velScratch);

    const pos = this.pos;
    for (let i = 0; i < count; i += 1) {
      const vx = this.velScratch[i * 3] ?? 0;
      const vy = this.velScratch[i * 3 + 1] ?? 0;
      const vz = this.velScratch[i * 3 + 2] ?? 0;
      if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) {
        continue; // freeze: keep the current position
      }
      const nx = (pos[i * 3] ?? 0) + vx * gain;
      const ny = (pos[i * 3 + 1] ?? 0) + vy * gain;
      const nz = (pos[i * 3 + 2] ?? 0) + vz * gain;
      if (
        !Number.isFinite(nx) ||
        !Number.isFinite(ny) ||
        !Number.isFinite(nz) ||
        nx < 0 ||
        nx >= DOMAIN.nx ||
        ny < 0 ||
        ny >= DOMAIN.ny ||
        nz < 0 ||
        nz >= DOMAIN.nz
      ) {
        continue; // freeze at the head position (stagnant smoke)
      }
      pos[i * 3] = nx;
      pos[i * 3 + 1] = ny;
      pos[i * 3 + 2] = nz;
    }

    this.head = (this.head + 1) % k;
    for (let i = 0; i < count; i += 1) {
      const dst = (i * k + this.head) * 3;
      this.trail[dst] = pos[i * 3] ?? 0;
      this.trail[dst + 1] = pos[i * 3 + 1] ?? 0;
      this.trail[dst + 2] = pos[i * 3 + 2] ?? 0;
    }
    this.rewriteSegments();
  }

  /**
   * Move the rake line; re-seeds all tracers and clears every trail (spec:
   * "Re-seeding (param change) clears trails").
   */
  setRake(yCenter: number, zCenter: number, halfWidth: number): void {
    if (this.disposed) return;
    this.seedLine = {
      yCenter: Number.isFinite(yCenter) ? yCenter : DOMAIN.ny / 2,
      zCenter: Number.isFinite(zCenter) ? zCenter : DOMAIN.nz / 2,
      halfWidth:
        Number.isFinite(halfWidth) && halfWidth >= 0 ? halfWidth : 8,
    };
    this.reseed();
  }

  /**
   * Change the trail length; rebuilds the ring + GL buffers (disposal + new
   * per spec) with trails re-seeded from the live head positions (no streak
   * artifacts across the domain). No-op when the clamped value is unchanged.
   */
  setHistoryLen(n: number): void {
    if (this.disposed) return;
    const next = clampHistoryLen(n);
    if (next === this.historyLen) return;
    this.historyLen = next;
    const count = this.tracerCount;
    this.trail = new Float32Array(count * next * 3);
    this.head = 0;
    for (let i = 0; i < count; i += 1) {
      for (let s = 0; s < next; s += 1) {
        const dst = (i * next + s) * 3;
        this.trail[dst] = this.pos[i * 3] ?? 0;
        this.trail[dst + 1] = this.pos[i * 3 + 1] ?? 0;
        this.trail[dst + 2] = this.pos[i * 3 + 2] ?? 0;
      }
    }
    const parent = this.lines.parent;
    this.lines.removeFromParent();
    this.geometry.dispose();
    this.geometry = new BufferGeometry();
    this.positionAttr = new BufferAttribute(
      new Float32Array(count * (next - 1) * 2 * 3),
      3,
    );
    this.positionAttr.setUsage(DynamicDrawUsage);
    const colorAttr = new BufferAttribute(
      new Float32Array(count * (next - 1) * 2 * 3),
      3,
    );
    this.geometry.setAttribute("position", this.positionAttr);
    this.geometry.setAttribute("color", colorAttr);
    this.fillStaticColors(colorAttr.array as Float32Array);
    this.lines.geometry = this.geometry;
    if (parent) parent.add(this.lines);
    this.rewriteSegments();
  }

  /** Remove the lines from the layer and release GPU resources. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lines.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }

  /**
   * Seed the vertical rake line at `seedX` (y from yCenter−hw to yCenter+hw,
   * evenly spaced; all z = zCenter) and fill every trail slot with its seed
   * so fresh tracers grow ribbons instead of streaking across the domain.
   */
  private reseed(): void {
    const count = this.tracerCount;
    const k = this.historyLen;
    const { yCenter, zCenter, halfWidth } = this.seedLine;
    for (let i = 0; i < count; i += 1) {
      const y =
        count > 1 ? yCenter - halfWidth + (2 * halfWidth * i) / (count - 1) : yCenter;
      this.pos[i * 3] = this.seedX;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = zCenter;
      for (let s = 0; s < k; s += 1) {
        const dst = (i * k + s) * 3;
        this.trail[dst] = this.seedX;
        this.trail[dst + 1] = y;
        this.trail[dst + 2] = zCenter;
      }
    }
    this.head = 0;
    this.rewriteSegments();
  }

  /**
   * Static index-based fade (spec §1): segment endpoint of trail-age `a`
   * (0 = newest) gets `lerp(tail, head, 1 − a/(historyLen−1))`, so the head
   * renders `#e5e7eb` at full and the tail sinks to `#1f2937`.
   */
  private fillStaticColors(colors: Float32Array): void {
    const count = this.tracerCount;
    const k = this.historyLen;
    for (let t = 0; t < count; t += 1) {
      for (let s = 0; s < k - 1; s += 1) {
        for (let e = 0; e < 2; e += 1) {
          const age = s + e;
          const f = 1 - age / (k - 1);
          const off = (t * (k - 1) + s) * 2 * 3 + e * 3;
          colors[off] = TAIL_RGB[0] + (HEAD_RGB[0] - TAIL_RGB[0]) * f;
          colors[off + 1] = TAIL_RGB[1] + (HEAD_RGB[1] - TAIL_RGB[1]) * f;
          colors[off + 2] = TAIL_RGB[2] + (HEAD_RGB[2] - TAIL_RGB[2]) * f;
        }
      }
    }
  }

  /**
   * Rewrite every segment endpoint from the ring. Logical age `a` (0 =
   * newest) lives in physical slot `(head − a + historyLen) % historyLen`
   * (spec contract: "index 0..historyLen−1 from head backwards; head =
   * newest").
   */
  private rewriteSegments(): void {
    if (this.disposed) return;
    const count = this.tracerCount;
    const k = this.historyLen;
    const positions = this.positionAttr.array as Float32Array;
    for (let t = 0; t < count; t += 1) {
      for (let s = 0; s < k - 1; s += 1) {
        const slotA = (this.head - s + k * 1024) % k;
        const slotB = (this.head - (s + 1) + k * 1024) % k;
        const srcA = (t * k + slotA) * 3;
        const srcB = (t * k + slotB) * 3;
        const dst = (t * (k - 1) + s) * 2 * 3;
        positions[dst] = this.trail[srcA] ?? 0;
        positions[dst + 1] = this.trail[srcA + 1] ?? 0;
        positions[dst + 2] = this.trail[srcA + 2] ?? 0;
        positions[dst + 3] = this.trail[srcB] ?? 0;
        positions[dst + 4] = this.trail[srcB + 1] ?? 0;
        positions[dst + 5] = this.trail[srcB + 2] ?? 0;
      }
    }
    this.positionAttr.needsUpdate = true;
  }
}
