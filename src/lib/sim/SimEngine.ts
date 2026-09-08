import type { BufferGeometry } from "three";
import {
  DEFAULT_CHAR_LEN_M,
  DEFAULT_CONDITIONS,
  DOMAIN_LENGTH_M,
  type FlowConditions,
} from "@/lib/sim/conditions";
import {
  QUALITY_PRESETS,
  type GridDims,
  type QualityLevel,
  type QualitySpec,
} from "@/lib/sim/quality";
import { DOMAIN, type SimReadout } from "@/lib/sim/types";
import { loadWasm, type WasmApi } from "@/lib/sim/wasm";

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

/** Structural view of the wasm-bindgen `LatticeParams` return (F009). */
interface LatticeParamsHandle {
  readonly u_lattice: number;
  readonly tau: number;
  readonly dt: number;
  readonly dx_phys: number;
  readonly re: number;
  readonly rho_phys: number;
  readonly unstable: boolean;
  free(): void;
}

/** Structural view of the wasm-bindgen `PressureAnchors` return (F012). */
interface PressureAnchorsHandle {
  readonly p_min_pa: number;
  readonly p_max_pa: number;
  readonly q_ref_pa: number;
  free(): void;
}

/** Structural view of the wasm-bindgen `Timing` return (F010). */
interface TimingHandle {
  readonly last_step_ms: number;
  readonly avg_step_ms: number;
  free(): void;
}

/** Structural view of the wasm-bindgen `StatsRecord` return (F013). */
interface StatsRecordHandle {
  readonly cd: number;
  readonly drag_n: number;
  readonly p_min_pa: number;
  readonly p_max_pa: number;
  readonly re: number;
  readonly steps: bigint;
  readonly active_particles: number;
  readonly stable: boolean;
  free(): void;
}

/**
 * Full ABI surface used by the engine. `wasm.ts` intentionally stays at its
 * narrow loader type; the structural extension lives here so no `wasm.ts`
 * edit is needed for this feature.
 */
type FullWasmApi = WasmApi & {
  set_conditions(
    uMps: number,
    pressureKpa: number,
    viscosityPas: number,
    domainLengthM: number,
    charLengthM: number,
  ): LatticeParamsHandle;
  reset_flow(): void;
  step(n: number): void;
  is_stable(): boolean;
  timing(): TimingHandle;
  set_mesh(triangles: Float32Array): number;
  clear_mesh(): void;
  particles_ptr(): number;
  speeds_ptr(): number;
  active_particle_count(): number;
  spawn_particles(count: number): void;
  respawn(n: number): number;
  advect_particles(dt: number): void;
  sample_velocity_batch(points: Float32Array, out: Float32Array): void;
  vertex_pressure_ptr(): number;
  vertex_pressure_len(): number;
  pressure_anchors(): PressureAnchorsHandle;
  stats(): StatsRecordHandle;
};

/** WASM particle-pool capacity: sized for the count slider max (F014). */
export const PARTICLE_CAPACITY = 100000;

/** Particle-count slider range (F014 §3; single owner since F019). */
export const PARTICLE_COUNT_MIN = 5000;
export const PARTICLE_COUNT_MAX = 100000;
export const PARTICLE_COUNT_STEP = 5000;
export const PARTICLE_COUNT_DEFAULT = 30000;

/** Smoke rake size default (F016 §1; single owner since F019). */
export const SMOKE_TRACER_COUNT = 25; // F021: superseded by QUALITY_PRESETS smoke counts; kept for API stability.
/** Trail-length UI range (F016 §2). */
export const SMOKE_HISTORY_MIN = 30;
export const SMOKE_HISTORY_MAX = 240;
export const SMOKE_HISTORY_DEFAULT = 90;
/** Rake-height slider range (F016 §2: y in 8..ny−8). */
export const SMOKE_RAKE_Y_MIN = 8;
export const SMOKE_RAKE_Y_MAX = DOMAIN.ny - 8;
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

/** EMA weight for the loop-driven FPS counter (F017 §2). */
const FPS_EMA_ALPHA = 0.1;
/** Longer frame gaps are discarded (background-tab return drags the EMA). */
const FPS_SAMPLE_MAX_MS = 500;

/** Result of `setMesh`: solid cell count + leaky-mesh fallback flag. */
export interface MeshResult {
  readonly solidCount: number;
  readonly surfaceMode: boolean;
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
  /** True when an instability auto-recovery ran this frame. */
  readonly recovered: boolean;
  /** Currently alive particles in the wasm pool. */
  readonly activeParticles: number;
  /** Latched stability flag after this frame's work. */
  readonly stable: boolean;
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
    throw new Error("Cannot voxelize geometry without a position attribute");
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

/** Options for `SimEngine.init` (F021: boot grid + pool target are runtime). */
export interface SimEngineInit {
  /** Quality tier selecting the boot grid (default `"medium"`). */
  readonly quality?: QualityLevel;
  /** Particle pool target (default: the tier's preset count). */
  readonly particleCount?: number;
}

export class SimEngine {
  private api: FullWasmApi | null = null;
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
  private inletULattice = 0.05;
  private lastConditions: FlowConditions = DEFAULT_CONDITIONS;
  private applied: AppliedConditions = {
    uLattice: 0.05,
    tau: 0.56,
    unstable: false,
  };
  private solidCount = 0;
  private surfaceMode = false;
  /** Mean ms per lattice step (EMA from wasm `timing()`); feeds `tick`. */
  private avgStepMs = 0;
  /** Last auto-recovery timestamp; starts armed so the first recovery runs. */
  private lastRecoveryMs = -RECOVERY_THROTTLE_MS;
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
      const api = (await loadWasm()) as FullWasmApi;
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

  private requireApi(): FullWasmApi {
    const api = this.api;
    if (!api) {
      throw new Error("SimEngine used before init() completed");
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
   * f32 array, calls `set_mesh`, stores the solid count + surface flag.
   * Caches a copy of the soup with the current dims (F021) so a later
   * quality switch can re-voxelize without the original file bytes.
   * Pointer-affecting call — callers must re-fetch views afterwards (all
   * accessors here create fresh views per call, so nothing goes stale).
   */
  setMesh(geometry: BufferGeometry): MeshResult {
    const api = this.requireApi();
    const soup = triangleSoup(geometry);
    const solidCount = api.set_mesh(soup);
    const surfaceMode = api.surface_mode_flag();
    this.solidCount = solidCount;
    this.surfaceMode = surfaceMode;
    this.cachedMesh = { soup: soup.slice(), dims: { ...this.dims } };
    return { solidCount, surfaceMode };
    return { solidCount, surfaceMode };
  }

  /** Remove the current mesh; the grid returns to all-fluid. */
  clearMesh(): void {
    const api = this.requireApi();
    api.clear_mesh();
    this.solidCount = 0;
    this.surfaceMode = false;
    this.cachedMesh = null;
  }

  /** Solid cell count from the last `setMesh` (0 with no mesh). */
  getSolidCount(): number {
    return this.solidCount;
  }

  /** True when the last `setMesh` fell back to shell-only mode (F006). */
  getSurfaceMode(): boolean {
    return this.surfaceMode;
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
   * `step(8)` at the boot (Low) grid and return `timing().avg_step_ms` for
   * `probeQuality`. Leaves a clean uniform flow behind (`reset_flow`) so the
   * caller can keep the instance as-is when the probe picks Low. Throws when
   * used before `init()` completed.
   */
  warmupStepMs(): number {
    const api = this.requireApi();
    api.step(8);
    const timing = api.timing();
    try {
      const ms = timing.avg_step_ms;
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
    const prevDims: GridDims = { ...this.dims };
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
      const rescaled = rescaleTriangleSoup(cached.soup, prevDims, nextDims);
      this.solidCount = api.set_mesh(rescaled);
      this.surfaceMode = api.surface_mode_flag();
    } else {
      this.solidCount = 0;
      this.surfaceMode = false;
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
   * 1. While running: adapt `stepsPerFrame` (1–8) against `avg_step_ms`,
   *    `step(steps)`, then `is_stable()` — on instability: pause, halve
   *    `u_mps` (min 1 m/s), commit + `resetFlow()`, mark `recovered`
   *    (halving + toast flag throttled to one recovery per 5 s; the
   *    pause + reset always run).
   * 2. While running and stable: `advect_particles(1.0)` + top-up respawn
   *    (≤ 2 000/frame once below 98 % of target).
   * 3. While paused: stepping halts and buffers stay on screen untouched.
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
        recovered = this.recover(nowMs);
      } else {
        api.advect_particles(ADVECT_DT_LATTICE);
        const active = api.active_particle_count();
        if (active < this.particleTarget * 0.98) {
          api.respawn(
            Math.min(this.particleTarget - active, RESPAWN_PER_FRAME_MAX),
          );
        }
      }
    }

    const stable = api.is_stable();
    return {
      stepsRun,
      recovered,
      activeParticles: api.active_particle_count(),
      stable,
    };
  }

  /**
   * Instability recovery: pause + halve wind speed + commit + soft restart.
   * Returns true when a full (halving) recovery ran; the 5 s throttle gates
   * the halving (spamming conditions can't loop-crash), but pause + reset
   * always run so the latch clears and the badge can return to STABLE.
   */
  private recover(nowMs: number): boolean {
    const api = this.requireApi();
    this.pause();
    const full = nowMs - this.lastRecoveryMs >= RECOVERY_THROTTLE_MS;
    if (full) {
      this.lastRecoveryMs = nowMs;
      const halved = Math.min(
        60,
        Math.max(1, this.lastConditions.uMps / 2),
      );
      this.setConditions({ ...this.lastConditions, uMps: halved });
    }
    api.reset_flow();
    return full;
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
        return {
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
          stable: record.stable,
          modelName: null,
          modelTriangles: null,
        };
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
