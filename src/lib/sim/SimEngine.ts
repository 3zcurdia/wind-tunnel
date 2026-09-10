import type { BufferGeometry } from "three";
import {
  DEFAULT_CHAR_LEN_M,
  DEFAULT_CONDITIONS,
  DOMAIN_LENGTH_M,
  type FlowConditions,
} from "@/lib/sim/conditions";
import { AppError } from "@/lib/sim/errors";
import {
  QUALITY_PRESETS,
  type GridDims,
  type QualityLevel,
  type QualitySpec,
} from "@/lib/sim/quality";
import { DOMAIN, type SimReadout } from "@/lib/sim/types";
import {
  loadWasm,
  type SetMeshResult,
  type StatsRecordHandle,
  type WasmApi,
} from "@/lib/sim/wasm";
import type { ModelOrientation } from "@/lib/sim/ModelContext";

/**
 * The single owner of every raw WASM ABI call (F019, ARCHITECTURE.md §6).
 *
 * Visualization modules and React components never import `wasm.ts` or the
 * generated bindings — they go through `SimEngine` (or the
 * `SimulationContext` actions wrapping it) and receive typed-array views /
 * plain data only.
 *
 * Buffer-view discipline (ARCHITECTURE.md §5): this class never holds a live
 * view across an allocation-triggering call. Views are created fresh on every
 * accessor call (`getParticleViews`, `getPressureView`) and must be consumed
 * synchronously by the caller — no allocation-triggering engine call happens
 * while a caller reads a view within a single frame.
 */

/** WASM particle-pool capacity: sized for the count slider max (F014). */
export const PARTICLE_CAPACITY = 100000;

/** Particle-count slider range (F014 §3; single owner since F019). */
export const PARTICLE_COUNT_MIN = 5000;
export const PARTICLE_COUNT_MAX = 100000;
export const PARTICLE_COUNT_STEP = 5000;
export const PARTICLE_COUNT_DEFAULT = 30000;

/** Trail-length UI range (F016 §2). */
export const SMOKE_HISTORY_MIN = 30;
export const SMOKE_HISTORY_MAX = 240;
export const SMOKE_HISTORY_DEFAULT = 90;
/**
 * Rake-height inset from the domain floor/ceiling (F016 §2: y in 8..ny−8).
 * The slider's live range is derived from the active tier's `ny` by
 * `SimulationContext.smokeRakeBounds`, not from a constant here.
 */
export const SMOKE_RAKE_Y_MIN = 8;
/** Rake-width slider range (F016 §2: halfWidth in 2..16). */
export const SMOKE_HALF_WIDTH_MIN = 2;
export const SMOKE_HALF_WIDTH_MAX = 16;

/** Solver budget per frame in ms (F019 contract: 12 of the 16.7 ms frame). */
export const SIM_TICK_BUDGET_MS = 12;

/** Top-up bound per frame (F014 §4): keeps respawn cost bounded. */
const RESPAWN_PER_FRAME_MAX = 2000;

/**
 * Speed-ramp headroom (F014 §2): the `speedNorm` max is
 * `1.3 × u_inlet` in lattice units — gap-accelerated particles outrun the
 * freestream, and the headroom keeps them on-scale instead of compressing
 * the whole freestream to mid-ramp.
 */
const SPEED_NORM_HEADROOM = 1.3;

/**
 * Lattice time step per frame for particle/smoke integration: 1.0 lattice
 * time unit per solver step — NOT `LatticeParams.dt` (physical seconds,
 * ~4e-5 s), which would freeze advection if used for lattice-space
 * `p += v·dt` integration (see DECISIONS.md F016.1).
 */
const ADVECT_DT_LATTICE = 1.0;

/** Instability auto-recovery throttle (F019 contract: 1 per 5 s). */
const RECOVERY_THROTTLE_MS = 5000;

/**
 * Double-blowup latch window (F022 §3): two instability recoveries within
 * 30 s stop auto-recovery and raise the persistent banner instead.
 */
const BLOWUP_WINDOW_MS = 30000;

/** Persistent banner text for the double-blowup latch (F022 §3, ≤ 90 chars). */
export const UNSTABLE_LOCK_MESSAGE =
  "Simulation unstable — reduce wind speed or change model";

/**
 * One instability incident, kept for deluxe console diagnostics + devtools.
 *
 * `transient` = soft auto-reset, the loop keeps running (the normal case).
 * `catastrophic` = repeated blowups inside the latch window — the engine
 * paused and waits for an explicit Reset (banner).
 */
export interface StabilityEvent {
  readonly at: string;
  readonly kind: "transient" | "catastrophic";
  readonly stepsPerFrame: number;
  readonly avgStepMs: number;
  readonly uMps: number;
  readonly uLattice: number;
  readonly tau: number;
  readonly conditionsUnstable: boolean;
  readonly activeParticles: number;
  readonly blowupsInWindow: number;
  readonly windReduced: boolean;
  readonly prevUMps: number | null;
  readonly nextUMps: number | null;
}

/** Cap on the in-memory stability ring buffer (devtools readout). */
const STABILITY_LOG_MAX = 50;

/** EMA weight for the loop-driven FPS counter (F017 §2). */
const FPS_EMA_ALPHA = 0.1;
/** Longer frame gaps are discarded (background-tab return drags the EMA). */
const FPS_SAMPLE_MAX_MS = 500;

/** Result of `setMesh`: solid cell count + leaky-mesh fallback flag. */
export interface MeshResult {
  readonly solidCount: number;
  readonly surfaceMode: boolean;
  /** Triangles skipped by the F022 pathological swept-range cap. */
  readonly skippedTriangles: number;
}

/** What the engine reported for the last committed operating point. */
export interface AppliedConditions {
  readonly uLattice: number;
  readonly tau: number;
  readonly unstable: boolean;
}

/** Per-frame result of `tick` (F019 contract). */
export interface TickResult {
  /** Lattice steps executed this frame (0 while paused). */
  readonly stepsRun: number;
  /**
   * True when a soft (transient) auto-recovery ran this frame — the flow was
   * reset and the loop keeps running. The loop surfaces this as a
   * non-blocking info toast; see `windReduced` for whether the wind speed
   * was also halved.
   */
  readonly recovered: boolean;
  /** True when the soft recovery also halved the wind speed (5 s throttle). */
  readonly windReduced: boolean;
  /** Total soft recoveries since init (monotonic, for diagnostics). */
  readonly recoveryCount: number;
  /** Currently alive particles in the wasm pool. */
  readonly activeParticles: number;
  /** Latched stability flag after this frame's work. */
  readonly stable: boolean;
  /** F022 double-blowup latch: auto-recovery stopped, banner owns Reset. */
  readonly unstableLocked: boolean;
}

/** Rake line snapshot in the exact shape `SmokeTracers.setRake` takes. */
export interface SmokeRakeState {
  readonly yCenter: number;
  readonly zCenter: number;
  readonly halfWidth: number;
}

/** Default rake line (F016 §1: centered, half-width 8 cells). */
export const SMOKE_RAKE_DEFAULT: SmokeRakeState = {
  yCenter: DOMAIN.ny / 2,
  zCenter: DOMAIN.nz / 2,
  halfWidth: 8,
};

/**
 * Pure adaptive step choice (F019 §1.1): start 2; if
 * `avg_step_ms × steps > budget × 0.6` halve (min 1); if `< 0.25 ×` double
 * (max 8). Exported pure (no engine state) so the policy reads the same from
 * the loop and from headless checks; the engine owns the persisted value.
 */
export function nextStepsPerFrame(
  current: number,
  avgStepMs: number,
  budgetMs: number,
): number {
  const budget =
    Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : SIM_TICK_BUDGET_MS;
  const avg = Number.isFinite(avgStepMs) ? Math.max(0, avgStepMs) : 0;
  const clamped = Math.min(
    8,
    Math.max(1, Math.floor(Number.isFinite(current) ? current : 2)),
  );
  if (avg * clamped > budget * 0.6) {
    return Math.max(1, Math.floor(clamped / 2));
  }
  if (avg * clamped < budget * 0.25) {
    return Math.min(8, clamped * 2);
  }
  return clamped;
}

/** Expand a (possibly indexed) BufferGeometry into a flat f32 triangle soup. */
function triangleSoup(geometry: BufferGeometry): Float32Array {
  const position = geometry.getAttribute("position");
  if (!position) {
    throw new AppError(
      "voxelize-failed",
      "Model has no position data — cannot voxelize",
    );
  }
  const array = position.array as ArrayLike<number>;
  const index = geometry.getIndex();
  if (!index) {
    return new Float32Array(array);
  }
  const out = new Float32Array(index.count * 3);
  for (let i = 0; i < index.count; i += 1) {
    const vi = index.getX(i);
    out[i * 3] = array[vi * 3] ?? 0;
    out[i * 3 + 1] = array[vi * 3 + 1] ?? 0;
    out[i * 3 + 2] = array[vi * 3 + 2] ?? 0;
  }
  return out;
}

/**
 * Rescale a domain-space triangle soup from one grid to another (F021).
 *
 * Pure helper for the quality-switch re-voxelization: every F021 tier keeps
 * the 8:3:3 aspect, and `normalizeToDomain` places models at fixed fractions
 * of the grid (longest side = 0.25·nx, center = (0.35·nx, ny/2, nz/2)), so a
 * soup normalized for `from` rescales *exactly* to what a fresh
 * normalization for `to` would produce (uniform ratio — per-axis multiply is
 * the robust form). The input is never mutated; an empty soup stays empty.
 */
export function rescaleTriangleSoup(
  soup: Float32Array,
  from: GridDims,
  to: GridDims,
): Float32Array {
  const out = new Float32Array(soup.length);
  const rx = to.nx / from.nx;
  const ry = to.ny / from.ny;
  const rz = to.nz / from.nz;
  for (let i = 0; i + 2 < soup.length; i += 3) {
    out[i] = (soup[i] ?? 0) * rx;
    out[i + 1] = (soup[i + 1] ?? 0) * ry;
    out[i + 2] = (soup[i + 2] ?? 0) * rz;
  }
  return out;
}

/**
 * Wrap one orientation angle in degrees to `[-180, 180)` (F024).
 *
 * Pure helper shared by `ModelContext.setOrientation` and the headless
 * rotation suite. Non-finite input maps to 0 (a programming error must not
 * smuggle NaN into the voxelizer); +180 wraps to −180 (same direction).
 */
export function wrapAngleDeg(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  const wrapped = ((((angle + 180) % 360) + 360) % 360) - 180;
  // `((…% 360) + 360) % 360` is in [0, 360); minus 180 lands in
  // [-180, 180). `-0` normalizes to `0` so skip-guards compare cleanly.
  return wrapped === 0 ? 0 : wrapped;
}

/**
 * Rotate a domain-space triangle soup about the §3 placement center (F024).
 *
 * Pure helper for the angle-of-attack commit: per vertex
 * `p' = C + s·R·(p − C)` with `C = (0.35·nx, ny/2, nz/2)` and
 * `R = Ry(yaw)·Rz(pitch)·Rx(roll)` (roll applied first, yaw last; angles in
 * degrees; yaw about +Y, pitch about +Z, roll about +X). Axes verified
 * against the acceptance triples: yaw +90° maps +X→−Z, pitch +90° maps
 * +X→+Y, roll +90° maps +Y→+Z.
 *
 * Fit correction: when the rotated AABB's longest side `L` exceeds the
 * placement-size envelope (`0.25·nx`), a uniform `s = (0.25·nx)/L` about `C`
 * pulls the model back inside (worst case a 45° square plate shrinks by
 * exactly `1/√2`); otherwise `s = 1` (`min(1, …)` — a yawed thin rod never
 * grows). The input is never mutated; an empty soup stays empty.
 *
 * All-zero orientation returns a verbatim copy (identity rotation + `s = 1`
 * would otherwise leave 1-ulp `(p−C)+C` round-trip noise, breaking the
 * rotate-away-and-back bitwise-equality criterion).
 */
export function rotateTriangleSoup(
  soup: Float32Array,
  dims: GridDims,
  o: ModelOrientation,
): Float32Array {
  const out = new Float32Array(soup.length);
  if (soup.length === 0) return out;
  const yaw = (o.yawDeg * Math.PI) / 180;
  const pitch = (o.pitchDeg * Math.PI) / 180;
  const roll = (o.rollDeg * Math.PI) / 180;
  if (yaw === 0 && pitch === 0 && roll === 0) {
    out.set(soup);
    return out;
  }
  const cx = 0.35 * dims.nx;
  const cy = dims.ny / 2;
  const cz = dims.nz / 2;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const cosRoll = Math.cos(roll);
  const sinRoll = Math.sin(roll);
  // Pass 1: center-relative rotation (roll → pitch → yaw), tracking the AABB.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i + 2 < soup.length; i += 3) {
    const x = (soup[i] ?? 0) - cx;
    const y = (soup[i + 1] ?? 0) - cy;
    const z = (soup[i + 2] ?? 0) - cz;
    // Rx(roll): x untouched.
    const y1 = cosRoll * y - sinRoll * z;
    const z1 = sinRoll * y + cosRoll * z;
    // Rz(pitch).
    const x2 = cosPitch * x - sinPitch * y1;
    const y2 = sinPitch * x + cosPitch * y1;
    // Ry(yaw).
    const x3 = cosYaw * x2 + sinYaw * z1;
    const z3 = -sinYaw * x2 + cosYaw * z1;
    out[i] = x3;
    out[i + 1] = y2;
    out[i + 2] = z3;
    if (x3 < minX) minX = x3;
    if (y2 < minY) minY = y2;
    if (z3 < minZ) minZ = z3;
    if (x3 > maxX) maxX = x3;
    if (y2 > maxY) maxY = y2;
    if (z3 > maxZ) maxZ = z3;
  }
  const longest = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  const limit = 0.25 * dims.nx;
  // Pass 2: translate back about C, with the fit shrink when over envelope.
  if (!(longest > limit)) {
    for (let i = 0; i + 2 < soup.length; i += 3) {
      out[i] = (out[i] ?? 0) + cx;
      out[i + 1] = (out[i + 1] ?? 0) + cy;
      out[i + 2] = (out[i + 2] ?? 0) + cz;
    }
    return out;
  }
  const s = limit / longest;
  for (let i = 0; i + 2 < soup.length; i += 3) {
    out[i] = cx + (out[i] ?? 0) * s;
    out[i + 1] = cy + (out[i + 1] ?? 0) * s;
    out[i + 2] = cz + (out[i + 2] ?? 0) * s;
  }
  return out;
}

/** Options for `SimEngine.init` (F021: boot grid + pool target are runtime). */
export interface SimEngineInit {
  /** Quality tier selecting the boot grid (default `"medium"`). */
  readonly quality?: QualityLevel;
  /** Particle pool target (default: the tier's preset count). */
  readonly particleCount?: number;
}

export class SimEngine {
  private api: WasmApi | null = null;
  private initPromise: Promise<void> | null = null;
  private running = true;
  private stepsPerFrame = 2;
  private particleTarget = PARTICLE_COUNT_DEFAULT;
  /** Current lattice grid (F021: runtime state, was the `DOMAIN` constant). */
  private dims: GridDims = { ...QUALITY_PRESETS.medium.grid };
  /** Quality tier the current grid came from (F021). */
  private quality: QualityLevel = "medium";
  /**
   * Last voxelized triangle soup + the grid it was normalized for (F021).
   * `setMesh` caches a copy so a quality switch can re-voxelize without the
   * original file bytes; the rescale is exact (see `rescaleTriangleSoup`).
   * Null with no mesh.
   */
  private cachedMesh: { soup: Float32Array; dims: GridDims } | null = null;
  /**
   * Committed angle-of-attack orientation (F024). `cachedMesh` stays at
   * zero orientation forever — every rotation derives from it, so repeated
   * commits never compound drift. Reset to default by `setMesh`/`clearMesh`
   * (a new model always starts unrotated).
   */
  private appliedOrientation: ModelOrientation = {
    yawDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
  };
  /**
   * Currently-voxelized (rotated) soup (F024) — what `set_mesh` last baked.
   * Read via `getAppliedSoup` for display rebuilds; null with no mesh.
   */
  private appliedSoup: Float32Array | null = null;
  /** `MeshResult` of the last voxelization (backs the skip-guard). */
  private appliedResult: MeshResult | null = null;
  private inletULattice = 0.05;
  private lastConditions: FlowConditions = DEFAULT_CONDITIONS;
  private applied: AppliedConditions = {
    uLattice: 0.05,
    tau: 0.56,
    unstable: false,
  };
  private solidCount = 0;
  private surfaceMode = false;
  /** Skipped-triangle count from the last `setMesh` (F022 secondary channel). */
  private skippedTriangles = 0;
  /** Mean ms per lattice step (EMA from wasm `timing()`); feeds `tick`. */
  private avgStepMs = 0;
  /** Last auto-recovery timestamp; starts armed so the first recovery runs. */
  private lastRecoveryMs = -RECOVERY_THROTTLE_MS;
  /** Instability timestamps inside the F022 double-blowup window. */
  private recoveryTimes: number[] = [];
  /** F022 latch: two blowups within 30 s stopped auto-recovery. */
  private unstableLocked = false;
  /** Total soft (transient) recoveries since init — monotonic counter. */
  private recoveryCount = 0;
  /** Ring buffer of recent instability incidents (newest last). */
  private stabilityLog: StabilityEvent[] = [];
  /** Detail of the most recent soft recovery (backs the recovery toast). */
  private lastRecoveryInfo: {
    readonly windReduced: boolean;
    readonly prevUMps: number | null;
    readonly nextUMps: number | null;
  } | null = null;
  /** Last stable readout snapshot for the F022 stats-freeze path. */
  private lastGoodReadout: SimReadout | null = null;
  private fpsEma = 0;
  private lastTickMs = 0;
  private lastSteps: number | null = null;
  private lastStepsMs = 0;

  /**
   * Lifecycle: `loadWasm()` → `init_sim(dims, capacity)` →
   * `set_conditions(defaults)` → `reset_flow()` → initial particle spawn.
   * The boot grid/pool target come from `options` (F021 — the
   * `SimulationContext` passes the stored or probed tier); omitted options
   * boot the Medium preset. Idempotent — concurrent callers share one
   * promise, and a second call after success is a no-op (StrictMode
   * double-mount safe). A rejection is never cached: the next call retries
   * fresh.
   */
  init(options?: SimEngineInit): Promise<void> {
    if (this.initPromise) return this.initPromise;
    const spec: QualitySpec =
      QUALITY_PRESETS[options?.quality ?? "medium"] ??
      QUALITY_PRESETS.medium;
    const target =
      options?.particleCount !== undefined &&
      Number.isFinite(options.particleCount)
        ? Math.max(0, Math.floor(options.particleCount))
        : spec.particles;
    this.initPromise = (async () => {
      const api = await loadWasm();
      this.dims = { ...spec.grid };
      this.quality = spec.level;
      this.particleTarget = target;
      api.init_sim(this.dims.nx, this.dims.ny, this.dims.nz, PARTICLE_CAPACITY);
      const params = api.set_conditions(
        DEFAULT_CONDITIONS.uMps,
        DEFAULT_CONDITIONS.pressureKpa,
        DEFAULT_CONDITIONS.viscosityPas,
        DOMAIN_LENGTH_M,
        DEFAULT_CHAR_LEN_M,
      );
      try {
        this.inletULattice =
          Number.isFinite(params.u_lattice) && params.u_lattice > 0
            ? params.u_lattice
            : 0.05;
        this.applied = {
          uLattice: params.u_lattice,
          tau: params.tau,
          unstable: params.unstable,
        };
      } finally {
        params.free();
      }
      api.reset_flow();
      api.spawn_particles(this.particleTarget);
      this.api = api;
    })().catch((err: unknown) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  /** Resolves once `init()` has completed (rejects while init failed). */
  whenReady(): Promise<void> {
    if (this.api) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    return Promise.reject(new Error("SimEngine.init() was never started"));
  }

  /** True once the wasm instance finished `init()` successfully. */
  get initialized(): boolean {
    return this.api !== null;
  }

  private requireApi(): WasmApi {
    const api = this.api;
    if (!api) {
      throw new AppError(
        "unknown",
        "Simulation engine not ready — retry shortly",
      );
    }
    return api;
  }

  // ── model API ──────────────────────────────────────────────────────────

  /** Current lattice grid in cells (F021: runtime state). */
  getDims(): GridDims {
    return { ...this.dims };
  }

  /** Quality tier the current grid came from (F021). */
  getQuality(): QualityLevel {
    return this.quality;
  }

  /**
   * Voxelize a domain-space (lattice cells) geometry: builds the triangle
   * f32 array, calls `set_mesh`, stores the solid count + surface flag +
   * skipped-triangle count (F022 secondary channel).
   * Caches a copy of the soup with the current dims (F021) so a later
   * quality switch can re-voxelize without the original file bytes.
   * Pointer-affecting call — callers must re-fetch views afterwards (all
   * accessors here create fresh views per call, so nothing goes stale).
   *
   * A new model always starts unrotated (F024): the orientation commit is
   * reset to default and the applied soup is the zero soup itself.
   */
  setMesh(geometry: BufferGeometry): MeshResult {
    const api = this.requireApi();
    const soup = triangleSoup(geometry);
    let result: SetMeshResult;
    try {
      result = api.set_mesh(soup);
    } catch (err) {
      throw new AppError(
        "voxelize-failed",
        "Voxelization failed — try a simpler model",
        { cause: err },
      );
    }
    try {
      const solidCount = Math.max(0, Math.floor(result.solidCount));
      const skippedTriangles = Math.max(0, Math.floor(result.skippedTriangles));
      const surfaceMode = api.surface_mode_flag();
      this.solidCount = solidCount;
      this.surfaceMode = surfaceMode;
      this.skippedTriangles = skippedTriangles;
      this.cachedMesh = { soup: soup.slice(), dims: { ...this.dims } };
      this.appliedOrientation = { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
      this.appliedSoup = soup.slice();
      this.appliedResult = { solidCount, surfaceMode, skippedTriangles };
      return { solidCount, surfaceMode, skippedTriangles };
    } finally {
      result.free();
    }
  }

  /** Remove the current mesh; the grid returns to all-fluid. */
  clearMesh(): void {
    const api = this.requireApi();
    api.clear_mesh();
    this.solidCount = 0;
    this.surfaceMode = false;
    this.skippedTriangles = 0;
    this.cachedMesh = null;
    this.appliedOrientation = { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
    this.appliedSoup = null;
    this.appliedResult = null;
  }

  /** Solid cell count from the last `setMesh` (0 with no mesh). */
  getSolidCount(): number {
    return this.solidCount;
  }

  /** True when the last `setMesh` fell back to shell-only mode (F006). */
  getSurfaceMode(): boolean {
    return this.surfaceMode;
  }

  /** Skipped-triangle count from the last `setMesh` (0 with no mesh). */
  getSkippedTriangles(): number {
    return this.skippedTriangles;
  }

  /**
   * Cached voxelized soup + the grid it was normalized for (F021), or null
   * with no mesh. Returns copies — the engine's cache stays immutable so
   * repeated quality switches never accumulate rescale drift. The display
   * layer (`useSimulation`) rebuilds the scene model from this after a
   * switch; the loop's heatmap index map follows automatically (same vertex
   * order, monotonic rescale — see DECISIONS.md §F021).
   */
  getMeshSoup(): { soup: Float32Array; dims: GridDims } | null {
    const cached = this.cachedMesh;
    if (!cached) return null;
    return { soup: cached.soup.slice(), dims: { ...cached.dims } };
  }

  /**
   * Commit an angle-of-attack orientation (F024): rotate the zero-orientation
   * `cachedMesh` soup → `set_mesh` (updating solid count / surface mode /
   * skipped triangles) → `reset_flow()` (engine-owned soft restart, the
   * viscosity-change precedent). `cachedMesh` itself is never overwritten,
   * so every commit derives from the same zero soup — no drift. Run/pause
   * state is untouched (a commit while paused stays paused).
   *
   * Skip-guard: when the request equals the applied orientation (and a mesh
   * is set), the stored result returns with no wasm work and no restart.
   * Returns null with no mesh (or before init) — callers no-op.
   */
  applyOrientation(o: ModelOrientation): MeshResult | null {
    const api = this.api;
    const cached = this.cachedMesh;
    if (!api || !cached) return null;
    const current = this.appliedOrientation;
    if (
      current.yawDeg === o.yawDeg &&
      current.pitchDeg === o.pitchDeg &&
      current.rollDeg === o.rollDeg &&
      this.appliedResult
    ) {
      return { ...this.appliedResult };
    }
    const rotated = rotateTriangleSoup(cached.soup, cached.dims, o);
    let result: SetMeshResult;
    try {
      result = api.set_mesh(rotated);
    } catch (err) {
      throw new AppError(
        "voxelize-failed",
        "Voxelization failed — try a simpler model",
        { cause: err },
      );
    }
    let solidCount = 0;
    let skippedTriangles = 0;
    let surfaceMode = false;
    try {
      solidCount = Math.max(0, Math.floor(result.solidCount));
      skippedTriangles = Math.max(0, Math.floor(result.skippedTriangles));
      surfaceMode = api.surface_mode_flag();
    } finally {
      result.free();
    }
    this.solidCount = solidCount;
    this.surfaceMode = surfaceMode;
    this.skippedTriangles = skippedTriangles;
    this.appliedOrientation = {
      yawDeg: o.yawDeg,
      pitchDeg: o.pitchDeg,
      rollDeg: o.rollDeg,
    };
    this.appliedSoup = rotated;
    this.appliedResult = { solidCount, surfaceMode, skippedTriangles };
    // Soft restart owned by the engine (viscosity-change precedent).
    api.reset_flow();
    return { ...this.appliedResult };
  }

  /**
   * Currently-voxelized (rotated) soup + the grid it lives in (F024), or
   * null with no mesh. Returns copies — the engine's state stays immutable.
   * The display layer (`useSimulation`) rebuilds the scene model from this
   * after an orientation commit; `getMeshSoup` stays zero-orientation for
   * the rescale math.
   */
  getAppliedSoup(): { soup: Float32Array; dims: GridDims } | null {
    const applied = this.appliedSoup;
    if (!applied) return null;
    return { soup: applied.slice(), dims: { ...this.dims } };
  }

  // ── conditions API ─────────────────────────────────────────────────────

  /**
   * Commit an operating point: `set_conditions` → store `AppliedConditions`
   * + recompute the F014 `speedNorm` anchors from the new `u_lattice`.
   *
   * Viscosity semantics (F019 decision, ARCHITECTURE.md §6): a viscosity
   * change performs the documented soft restart — `SimEngine` calls
   * `reset_flow()` itself before returning. The return flags the change so
   * callers can react (toasts, badges) without re-implementing the restart.
   */
  setConditions(params: FlowConditions): AppliedConditions & {
    readonly viscosityChanged: boolean;
  } {
    const api = this.requireApi();
    const viscosityChanged = params.viscosityPas !== this.lastConditions.viscosityPas;
    const result = api.set_conditions(
      params.uMps,
      params.pressureKpa,
      params.viscosityPas,
      DOMAIN_LENGTH_M,
      DEFAULT_CHAR_LEN_M,
    );
    try {
      this.lastConditions = { ...params };
      if (Number.isFinite(result.u_lattice) && result.u_lattice > 0) {
        this.inletULattice = result.u_lattice;
      }
      this.applied = {
        uLattice: result.u_lattice,
        tau: result.tau,
        unstable: result.unstable,
      };
    } finally {
      result.free();
    }
    if (viscosityChanged) {
      api.reset_flow();
    }
    return { ...this.applied, viscosityChanged };
  }

  /** Last committed operating point (slider state echoes this). */
  getConditions(): FlowConditions {
    return { ...this.lastConditions };
  }

  /** Last `set_conditions` report (lattice anchors + clamp flag). */
  getApplied(): AppliedConditions {
    return { ...this.applied };
  }

  /** F014 `speedNorm` anchors: `[0, 1.3 × u_inlet]` in lattice-speed units. */
  getSpeedNorm(): { min: number; max: number } {
    return { min: 0, max: SPEED_NORM_HEADROOM * this.inletULattice };
  }

  // ── transport ──────────────────────────────────────────────────────────

  play(): void {
    this.running = true;
  }

  pause(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Re-initialize the flow field to uniform inlet conditions (keeps mesh). */
  resetFlow(): void {
    this.requireApi().reset_flow();
  }

  /**
   * Full reset: conditions back to defaults (committed, with the viscosity
   * path's soft restart) plus a flow reset. Keeps the mesh and the particle
   * target; leaves the run/pause state untouched.
   */
  resetAll(): AppliedConditions {
    const { viscosityChanged: _dropped, ...applied } =
      this.setConditions(DEFAULT_CONDITIONS);
    void _dropped;
    this.requireApi().reset_flow();
    return applied;
  }

  // ── quality presets (F021) ─────────────────────────────────────────────

  /**
   * Hidden warm-up for the first-visit auto-probe (F021 §1): run one
   * `step(8)` at the boot (Low) grid and return `timing().last_step_ms` for
   * `probeQuality`. `last_step_ms` is the per-step cost of that one batch —
   * the sibling `avg_step_ms` is an EMA seeded at 0 (`avg += (last - avg) *
   * 0.1` in `wasm/src/lib.rs`), so after a single batch it reads ~10 % of the
   * real cost and would bias the probe towards Medium on every device.
   * Leaves a clean uniform flow behind (`reset_flow`) so the caller can keep
   * the instance as-is when the probe picks Low. Throws when used before
   * `init()` completed.
   */
  warmupStepMs(): number {
    const api = this.requireApi();
    api.step(8);
    const timing = api.timing();
    try {
      const ms = timing.last_step_ms;
      return Number.isFinite(ms) && ms >= 0 ? ms : 0;
    } finally {
      timing.free();
      api.reset_flow();
    }
  }

  /**
   * Quality-switch re-init (F021 §3 — the exact spec sequence): `init_sim`
   * at the new dims → re-commit the current conditions (the rebuild resets
   * solver params) → re-voxelize the cached mesh rescaled to the new grid
   * (skipped with no mesh) → `reset_flow` → `spawn_particles` at the
   * tier's preset count. Smoke re-seeding rides the context's rake state
   * (the loop's rake-sync effect re-seeds on the clamped values).
   *
   * F024: the rescale starts from the zero-orientation `cachedMesh` (which
   * is updated to the rescaled zero soup + new dims, so consecutive
   * switches stay exact) and the committed `appliedOrientation` is
   * re-applied on top — orientation survives tier switches.
   *
   * Pointer-affecting (ARCHITECTURE.md §5): all accessors here create fresh
   * views per call, so nothing goes stale. Adaptive state restarts
   * (`stepsPerFrame` 2, EMA cleared) — the new grid has new timing.
   * The run/pause flag and the last conditions are kept.
   */
  applyQuality(level: QualityLevel): QualitySpec {
    const api = this.requireApi();
    const spec: QualitySpec =
      QUALITY_PRESETS[level] ?? QUALITY_PRESETS.medium;
    const nextDims: GridDims = { ...spec.grid };
    this.quality = spec.level;
    this.dims = nextDims;
    api.init_sim(nextDims.nx, nextDims.ny, nextDims.nz, PARTICLE_CAPACITY);
    const conditions = api.set_conditions(
      this.lastConditions.uMps,
      this.lastConditions.pressureKpa,
      this.lastConditions.viscosityPas,
      DOMAIN_LENGTH_M,
      DEFAULT_CHAR_LEN_M,
    );
    try {
      if (Number.isFinite(conditions.u_lattice) && conditions.u_lattice > 0) {
        this.inletULattice = conditions.u_lattice;
      }
      this.applied = {
        uLattice: conditions.u_lattice,
        tau: conditions.tau,
        unstable: conditions.unstable,
      };
    } finally {
      conditions.free();
    }
    const cached = this.cachedMesh;
    if (cached && cached.soup.length > 0) {
      // Rescale from the soup's own grid (equals the pre-switch dims in the
      // normal flow; robust across consecutive switches) and keep the
      // zero-cache in sync with the live grid.
      const rescaled = rescaleTriangleSoup(cached.soup, cached.dims, nextDims);
      this.cachedMesh = { soup: rescaled, dims: { ...nextDims } };
      const rotated = rotateTriangleSoup(
        rescaled,
        nextDims,
        this.appliedOrientation,
      );
      const res = api.set_mesh(rotated);
      try {
        this.solidCount = Math.max(0, Math.floor(res.solidCount));
        this.skippedTriangles = Math.max(0, Math.floor(res.skippedTriangles));
      } finally {
        res.free();
      }
      this.surfaceMode = api.surface_mode_flag();
      this.appliedSoup = rotated;
      this.appliedResult = {
        solidCount: this.solidCount,
        surfaceMode: this.surfaceMode,
        skippedTriangles: this.skippedTriangles,
      };
    } else {
      this.solidCount = 0;
      this.surfaceMode = false;
      this.skippedTriangles = 0;
      this.appliedSoup = null;
      this.appliedResult = null;
    }
    api.reset_flow();
    this.particleTarget = spec.particles;
    api.spawn_particles(spec.particles);
    this.stepsPerFrame = 2;
    this.avgStepMs = 0;
    this.lastSteps = null;
    return spec;
  }

  // ── particles ──────────────────────────────────────────────────────────

  /** Current respawn top-up target (slider state echoes this). */
  getParticleTarget(): number {
    return this.particleTarget;
  }

  /**
   * Clamp to the 5k–100k slider range (5k steps), store the target for the
   * frame top-up, and reseed the pool via destructive `spawn_particles`.
   * Tolerant before init (stores the target; `init()` spawns it).
   */
  setParticleCount(count: number): number {
    const stepped =
      Math.round(count / PARTICLE_COUNT_STEP) * PARTICLE_COUNT_STEP;
    const clamped = Math.min(
      PARTICLE_COUNT_MAX,
      Math.max(PARTICLE_COUNT_MIN, stepped),
    );
    this.particleTarget = clamped;
    this.api?.spawn_particles(clamped);
    return clamped;
  }

  /** Current steps-per-frame (adaptive 1–8; surfaced for diagnostics). */
  getStepsPerFrame(): number {
    return this.stepsPerFrame;
  }

  // ── frame unit ─────────────────────────────────────────────────────────

  /**
   * The frame unit (F019 contract): the single entry point per frame — no
   * other wasm calls belong in the render loop.
   *
   * Continuous-run policy (supersedes the pause-on-first-blowup behaviour):
   *
   * 1. While running: adapt `stepsPerFrame` (1–8) against `avg_step_ms`,
   *    `step(steps)`, then `is_stable()` — on a transient instability the
   *    flow is soft-reset (`reset_flow()`, plus a throttled wind-speed
   *    halving at most once per 5 s) and the loop KEEPS RUNNING. `recovered`
   *    flags the frame so the loop can toast non-blockingly; a deluxe
   *    diagnostic group is always written to the console for developers.
   * 2. While running and stable (including right after a soft reset):
   *    `advect_particles(1.0)` + top-up respawn (≤ 2 000/frame once below
   *    98 % of target) — visuals never freeze on a transient.
   * 3. While paused (user pause only): stepping halts and buffers stay on
   *    screen untouched.
   * 4. Catastrophic failure only: two blowups within the 30 s window latch
   *    `unstableLocked` (F022 §3) — the engine pauses and the banner owns
   *    Reset via `resetUnstable()`. This is the ONLY path that stops the
   *    loop without an explicit user pause.
   */
  tick(budgetMs: number): TickResult {
    const api = this.requireApi();
    const nowMs = performance.now();
    if (this.lastTickMs > 0) {
      const dt = nowMs - this.lastTickMs;
      if (dt > 0 && dt <= FPS_SAMPLE_MAX_MS) {
        const fps = 1000 / dt;
        this.fpsEma =
          this.fpsEma === 0 ? fps : this.fpsEma + FPS_EMA_ALPHA * (fps - this.fpsEma);
      }
    }
    this.lastTickMs = nowMs;

    let stepsRun = 0;
    let recovered = false;
    let windReduced = false;
    if (this.running) {
      this.stepsPerFrame = nextStepsPerFrame(
        this.stepsPerFrame,
        this.avgStepMs,
        budgetMs,
      );
      api.step(this.stepsPerFrame);
      stepsRun = this.stepsPerFrame;
      const timing = api.timing();
      try {
        if (Number.isFinite(timing.avg_step_ms) && timing.avg_step_ms >= 0) {
          this.avgStepMs = timing.avg_step_ms;
        }
      } finally {
        timing.free();
      }
      if (!api.is_stable()) {
        if (this.unstableLocked) {
          // Latched (F022 §3): stay paused and frozen — Reset owns recovery.
          this.pause();
          recovered = false;
        } else {
          const outcome = this.recover(nowMs);
          recovered = outcome.recovered;
          windReduced = outcome.windReduced;
        }
      }
      // Intentionally NOT `else`: after a soft (transient) recovery the
      // field is a clean uniform flow again, so advection + top-up still
      // run on the detecting frame — no one-frame visual freeze.
      if (api.is_stable() && !this.unstableLocked) {
        api.advect_particles(ADVECT_DT_LATTICE);
        const active = api.active_particle_count();
        if (active < this.particleTarget * 0.98) {
          api.respawn(
            Math.min(this.particleTarget - active, RESPAWN_PER_FRAME_MAX),
          );
        }
      } else if (this.unstableLocked) {
        // Catastrophic latch tripped this frame: freeze on last-good
        // buffers (the banner owns Reset) — same as the old paused path.
        this.pause();
      }
    }

    const stable = api.is_stable() && !this.unstableLocked;
    return {
      stepsRun,
      recovered,
      windReduced,
      recoveryCount: this.recoveryCount,
      activeParticles: api.active_particle_count(),
      stable,
      unstableLocked: this.unstableLocked,
    };
  }

  /** True once two blowups within 30 s stopped auto-recovery (F022 §3). */
  isUnstableLocked(): boolean {
    return this.unstableLocked;
  }

  /**
   * Clear the double-blowup latch (the banner Reset button): drop the
   * recovery window, re-initialize to a clean uniform flow, and resume.
   * Recovers fully — the next instability starts a fresh window.
   */
  resetUnstable(): void {
    this.unstableLocked = false;
    this.recoveryTimes = [];
    this.requireApi().reset_flow();
    this.play();
    try {
      console.info(
        `%c[wind-tunnel] stability latch cleared by user Reset — resuming ` +
          `at ${this.lastConditions.uMps.toFixed(1)} m/s ` +
          `(${this.recoveryCount} transient recoveries so far)`,
        "color:#22c55e;font-weight:bold",
      );
    } catch {
      // Console unavailable — resume regardless.
    }
  }

  /**
   * Instability recovery — continuous-run policy.
   *
   * - Transient (first blowup in the window): soft-reset the flow
   *   (`reset_flow`), halve the wind speed at most once per 5 s, keep
   *   `running` untouched, and return `{ recovered: true }` so the loop can
   *   toast non-blockingly. Always writes a deluxe console diagnostic.
   * - Catastrophic (second blowup inside the 30 s window — a blowup at
   *   already-reduced speed, beyond auto-recovery): latch `unstableLocked`,
   *   reset to a clean field, and return `{ recovered: false }`. The caller
   *   pauses; the banner owns Reset. A `console.error` group records the
   *   full incident for developers.
   */
  private recover(nowMs: number): { recovered: boolean; windReduced: boolean } {
    const api = this.requireApi();
    // Snapshot BEFORE reset_flow clears the Rust latch — this is the
    // developer-facing "what happened" payload.
    const activeBefore = this.safeActiveCount(api);
    const prevU = this.lastConditions.uMps;
    this.recoveryTimes = [
      ...this.recoveryTimes.filter((t) => nowMs - t < BLOWUP_WINDOW_MS),
      nowMs,
    ];
    const blowupsInWindow = this.recoveryTimes.length;
    if (blowupsInWindow >= 2) {
      this.unstableLocked = true;
      api.reset_flow();
      const event: StabilityEvent = {
        at: new Date().toISOString(),
        kind: "catastrophic",
        stepsPerFrame: this.stepsPerFrame,
        avgStepMs: this.avgStepMs,
        uMps: prevU,
        uLattice: this.applied.uLattice,
        tau: this.applied.tau,
        conditionsUnstable: this.applied.unstable,
        activeParticles: activeBefore,
        blowupsInWindow,
        windReduced: false,
        prevUMps: prevU,
        nextUMps: prevU,
      };
      this.pushStabilityEvent(event);
      this.logCatastrophic(event);
      this.lastRecoveryInfo = null;
      return { recovered: false, windReduced: false };
    }
    // Transient: throttle only the wind-speed halving (spamming conditions
    // can't loop-crash); the reset always runs so the latch clears.
    let windReduced = false;
    let nextU: number | null = null;
    if (nowMs - this.lastRecoveryMs >= RECOVERY_THROTTLE_MS) {
      this.lastRecoveryMs = nowMs;
      const halved = Math.min(60, Math.max(1, prevU / 2));
      // At the 1 m/s floor the "halved" value is the current one — committing
      // it would toast "wind reduced" without reducing anything.
      if (halved < prevU) {
        try {
          this.setConditions({ ...this.lastConditions, uMps: halved });
          windReduced = true;
          nextU = halved;
        } catch {
          // A failed conditions commit must not block the flow reset below.
          windReduced = false;
          nextU = null;
        }
      }
    }
    api.reset_flow();
    this.recoveryCount += 1;
    this.lastRecoveryInfo = { windReduced, prevUMps: prevU, nextUMps: nextU };
    const event: StabilityEvent = {
      at: new Date().toISOString(),
      kind: "transient",
      stepsPerFrame: this.stepsPerFrame,
      avgStepMs: this.avgStepMs,
      uMps: prevU,
      uLattice: this.applied.uLattice,
      tau: this.applied.tau,
      conditionsUnstable: this.applied.unstable,
      activeParticles: activeBefore,
      blowupsInWindow,
      windReduced,
      prevUMps: prevU,
      nextUMps: nextU,
    };
    this.pushStabilityEvent(event);
    this.logTransient(event);
    // Deliberately no `pause()`: the simulation runs continuously through
    // transients and only stops on the catastrophic latch above.
    return { recovered: true, windReduced };
  }

  /** Total soft recoveries since init (monotonic — survives resets). */
  getRecoveryCount(): number {
    return this.recoveryCount;
  }

  /** Newest-last incident history (capped copy — safe for devtools). */
  getStabilityLog(): readonly StabilityEvent[] {
    return [...this.stabilityLog];
  }

  /** Detail of the most recent soft recovery (backs the recovery toast). */
  getLastRecoveryInfo(): {
    readonly windReduced: boolean;
    readonly prevUMps: number | null;
    readonly nextUMps: number | null;
  } | null {
    return this.lastRecoveryInfo;
  }

  private safeActiveCount(api: { active_particle_count(): number }): number {
    try {
      const n = api.active_particle_count();
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : -1;
    } catch {
      return -1;
    }
  }

  private pushStabilityEvent(event: StabilityEvent): void {
    this.stabilityLog = [...this.stabilityLog, event].slice(
      Math.max(0, this.stabilityLog.length + 1 - STABILITY_LOG_MAX),
    );
  }

  /**
   * Deluxe transient diagnostic (console): collapsed group + warn summary +
   * structured payload + one-line remediation hint. Always emitted (never
   * sampled) — a collapsed group is cheap, and a lost incident is worse
   * than a noisy console.
   */
  private logTransient(event: StabilityEvent): void {
    const n = this.recoveryCount;
    const label =
      `%c[wind-tunnel] transient instability #${n} — flow auto-reset, continuing` +
      (event.windReduced && event.nextUMps !== null
        ? ` (wind ${event.prevUMps?.toFixed?.(1) ?? "?"} → ${event.nextUMps.toFixed(1)} m/s)`
        : " (wind unchanged)");
    try {
      console.groupCollapsed(label, "color:#f59e0b;font-weight:bold");
      console.warn(
        `[wind-tunnel] LBM stability latch tripped at ${event.at} ` +
          `(${event.blowupsInWindow} blowup(s) in the last ${BLOWUP_WINDOW_MS / 1000}s window). ` +
          `Soft reset applied; simulation keeps running. ` +
          `A repeat within the window will latch CATASTROPHIC and pause.`,
      );
      console.log("[wind-tunnel] stability incident:", { ...event });
      console.log(
        "[wind-tunnel] hint: blowups usually mean the operating point " +
          "exceeds what BGK can integrate (sharp/under-resolved obstacle, " +
          "very high wind). " +
          "Try lower wind, higher viscosity, or a smoother model. " +
          "History: engine.getStabilityLog().",
      );
      console.groupEnd();
    } catch {
      // Console unavailable (embedded webview) — never break the loop.
    }
  }

  /** Deluxe catastrophic diagnostic (console): error group, full payload. */
  private logCatastrophic(event: StabilityEvent): void {
    try {
      console.groupCollapsed(
        "%c[wind-tunnel] CATASTROPHIC instability — auto-recovery stopped, Reset required",
        "color:#ef4444;font-weight:bold",
      );
      console.error(
        `[wind-tunnel] ${event.blowupsInWindow} blowups within ` +
          `${BLOWUP_WINDOW_MS / 1000}s at ${event.at}. ` +
          `Engine latched unstableLocked=true and paused; ` +
          `flow was reset to a clean field pending Reset.`,
      );
      console.error("[wind-tunnel] catastrophic incident:", { ...event });
      console.error(
        "[wind-tunnel] action: reduce wind speed / raise viscosity / simplify " +
          "the model, then press Reset in the banner. " +
          "Full history: engine.getStabilityLog().",
      );
      console.groupEnd();
    } catch {
      // Console unavailable — the banner still owns the user-visible path.
    }
  }

  // ── zero-copy readouts ─────────────────────────────────────────────────

  /**
   * Fresh particle views into wasm memory (active-first ordering). Created
   * per call — read synchronously; never hold across engine calls.
   */
  getParticleViews(): {
    readonly positions: Float32Array;
    readonly speeds: Float32Array;
    readonly active: number;
  } {
    const api = this.requireApi();
    const active = Math.min(
      api.active_particle_count(),
      PARTICLE_CAPACITY,
    );
    const posPtr = api.particles_ptr();
    const spdPtr = api.speeds_ptr();
    const positions =
      posPtr === 0
        ? new Float32Array(0)
        : new Float32Array(api.memory.buffer, posPtr, PARTICLE_CAPACITY * 3);
    const speeds =
      spdPtr === 0
        ? new Float32Array(0)
        : new Float32Array(api.memory.buffer, spdPtr, PARTICLE_CAPACITY);
    return { positions, speeds, active };
  }

  /**
   * Fresh vertex-pressure view (stored-vertex order, [Pa]). Empty with no
   * mesh. Created per call — read synchronously.
   */
  getPressureView(): Float32Array {
    const api = this.requireApi();
    const len = api.vertex_pressure_len();
    const ptr = api.vertex_pressure_ptr();
    if (ptr === 0 || len === 0) return new Float32Array(0);
    return new Float32Array(api.memory.buffer, ptr, len);
  }

  /** Current legend anchors (freed before returning — never held). */
  getAnchors(): { pMinPa: number; pMaxPa: number; qRefPa: number } {
    const api = this.requireApi();
    const anchors = api.pressure_anchors();
    try {
      return {
        pMinPa: anchors.p_min_pa,
        pMaxPa: anchors.p_max_pa,
        qRefPa: anchors.q_ref_pa,
      };
    } finally {
      anchors.free();
    }
  }

  /** Batched velocity sampling for the smoke driver (the only sampling path). */
  sampleVelocity(points: Float32Array, out: Float32Array): void {
    this.requireApi().sample_velocity_batch(points, out);
  }

  /**
   * Assemble the F017 `SimReadout` from `stats()` + anchors + the loop fps
   * EMA. Synchronous and total (never throws — a failing ABI drops back to
   * null so the 4 Hz poll loop survives a poisoned instance). `modelName` /
   * `modelTriangles` are always null here (React-free module — the provider
   * fills them from `ModelContext`, same split as the deleted bridge).
   *
   * F022 §3: while unstable (or double-blowup latched), stats freeze — the
   * last stable developed snapshot is returned with `stable: false`, so the
   * panel keeps showing last-good numbers plus the UNSTABLE badge instead of
   * NaN or diverged garbage. All numeric paths below are finite-guarded, so
   * no NaN ever reaches the UI even with no snapshot cached yet.
   */
  getReadout(): SimReadout | null {
    const api = this.api;
    if (!api) return null;
    let record: StatsRecordHandle | null = null;
    try {
      record = api.stats();
      try {
        const steps = Number(record.steps);
        const nowMs = performance.now();
        let stepsPerSecond = 0;
        if (this.lastSteps !== null) {
          const dtS = (nowMs - this.lastStepsMs) / 1000;
          if (dtS > 0) {
            stepsPerSecond = Math.max(0, (steps - this.lastSteps) / dtS);
          }
        }
        this.lastSteps = steps;
        this.lastStepsMs = nowMs;

        const anchors = this.getAnchors();
        // F013 sentinel: cd === −1 means "not yet meaningful" (< 200 steps
        // since reset or no mesh) — surfaced as null so the panel renders
        // "—" (same for the drag force, which shares the EMA).
        const meaningful =
          Number.isFinite(record.cd) && record.cd !== -1;
        const liveStable = record.stable && !this.unstableLocked;
        if (!liveStable && this.lastGoodReadout !== null) {
          return {
            ...this.lastGoodReadout,
            fps: this.fpsEma,
            stable: false,
          };
        }
        const readout: SimReadout = {
          fps: this.fpsEma,
          stepsPerSecond,
          cd: meaningful ? record.cd : null,
          dragN:
            meaningful && Number.isFinite(record.drag_n)
              ? record.drag_n
              : null,
          pMinPa: Number.isFinite(record.p_min_pa) ? record.p_min_pa : 0,
          pMaxPa: Number.isFinite(record.p_max_pa) ? record.p_max_pa : 0,
          qRefPa: Number.isFinite(anchors.qRefPa) ? anchors.qRefPa : 0,
          re: Number.isFinite(record.re) ? record.re : 0,
          gridDims: [this.dims.nx, this.dims.ny, this.dims.nz],
          activeParticles: record.active_particles,
          stable: liveStable,
          modelName: null,
          modelTriangles: null,
        };
        // Cache developed stable snapshots only (mesh + past the sentinel
        // horizon) so the freeze path restores last-good numbers, not a
        // just-reset uniform field.
        if (liveStable && meaningful) {
          this.lastGoodReadout = readout;
        }
        return readout;
      } finally {
        record.free();
      }
    } catch {
      return null;
    }
  }

  /**
   * Unmount cleanup hook (F019 contract). There is no per-engine rAF to
   * cancel — the SceneManager loop drives `tick()` and the hook owns that
   * subscription — so this only resets the fps baseline (a remount must not
   * record the unmounted gap as a frame). The wasm instance is intentionally
   * kept: re-init on remount would rebuild the domain and lose the developed
   * flow; the singleton resumes instead (StrictMode-safe via idempotent
   * `init()`).
   */
  dispose(): void {
    this.lastTickMs = 0;
  }
}

let instance: SimEngine | null = null;

/** Process-lifetime engine singleton (shared by context, loop, and probe). */
export function getSimEngine(): SimEngine {
  if (!instance) {
    instance = new SimEngine();
  }
  return instance;
}
