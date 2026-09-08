import type { BufferGeometry } from "three";
import { HeatmapOverlay } from "@/lib/viz/HeatmapOverlay";
import { ParticleSystem } from "@/lib/viz/ParticleSystem";
import { SmokeTracers } from "@/lib/viz/SmokeTracers";
import type { SceneManager } from "@/components/viewport/SceneManager";
import { DOMAIN, type SimReadout } from "@/lib/sim/types";
import { loadWasm, type WasmApi } from "@/lib/sim/wasm";

export interface VoxelMeshResult {
  solidCount: number;
  surfaceMode: boolean;
}

export interface VoxelSnapshot {
  /** Copied occupancy bytes (1 = solid), row-major `x + nx*(y + ny*z)`. */
  occupancy: Uint8Array;
  nx: number;
  ny: number;
  nz: number;
}

/**
 * TEMPORARY JS bridge (F006; folded into `SimEngine` in F019).
 *
 * Owns the WASM voxelization path until `SimEngine` exists: ensures a single
 * `init_sim(128, 48, 48, PARTICLE_CAPACITY)` and forwards domain-space geometries to
 * `set_mesh`. Buffer views are copied synchronously (never held across
 * allocation-triggering calls, per ARCHITECTURE.md §5).
 */
let initPromise: Promise<WasmApi> | null = null;

/**
 * WASM particle-pool capacity (F014: sized for the particle-count slider max
 * of 100k; the F006-era 60k could not back the top of the range).
 */
const PARTICLE_CAPACITY = 100000;

function ensureEngine(): Promise<WasmApi> {
  if (!initPromise) {
    initPromise = (async () => {
      const api = await loadWasm();
      api.init_sim(DOMAIN.nx, DOMAIN.ny, DOMAIN.nz, PARTICLE_CAPACITY);
      return api;
    })().catch((err: unknown) => {
      // Never cache a rejected promise: the next call retries fresh.
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
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

export async function setMeshFromGeometry(
  geometry: BufferGeometry,
): Promise<VoxelMeshResult> {
  const api = await ensureEngine();
  const solidCount = api.set_mesh(triangleSoup(geometry));
  return { solidCount, surfaceMode: api.surface_mode_flag() };
}

export async function readOccupancy(): Promise<VoxelSnapshot> {
  const api = await ensureEngine();
  const ptr = api.occupancy_ptr();
  const len = api.occupancy_len();
  // `.slice` copies immediately, so the snapshot survives later reallocations.
  const occupancy =
    ptr === 0 || len === 0
      ? new Uint8Array(0)
      : new Uint8Array(api.memory.buffer.slice(ptr, ptr + len));
  return { occupancy, nx: DOMAIN.nx, ny: DOMAIN.ny, nz: DOMAIN.nz };
}

/** Voxelize one geometry and return the solid count plus a grid snapshot. */
export async function voxelizeGeometry(
  geometry: BufferGeometry,
): Promise<VoxelMeshResult & VoxelSnapshot> {
  const result = await setMeshFromGeometry(geometry);
  const snapshot = await readOccupancy();
  return { ...result, ...snapshot };
}

/**
 * Structural view of the F011 particle ABI. `WasmApi` (`wasm.ts`) is owned by
 * `SimEngine` in F019 and intentionally stays at the F006 surface until then;
 * this local extension types the calls the smoke probe needs without touching
 * that file.
 */
type ParticleWasmApi = WasmApi & {
  reset_flow(): void;
  step(n: number): void;
  spawn_particles(count: number): void;
  respawn(n: number): number;
  advect_particles(dt: number): void;
  particles_ptr(): number;
  speeds_ptr(): number;
  active_particle_count(): number;
};

/** Structural view of the wasm-bindgen `LatticeParams` return (F009). */
type LatticeParamsLike = {
  readonly u_lattice: number;
  free(): void;
};

/**
 * Structural view of the F012 pressure ABI (same TEMPORARY-bridge pattern as
 * above — folded into `SimEngine` in F019).
 *
 * `pressure_anchors()` returns a wasm-bindgen class instance (heap-allocated
 * per call — see DECISIONS.md F015.3), so every read must end in `.free()`.
 */
type PressureWasmApi = ParticleWasmApi & {
  set_conditions(
    uMps: number,
    pressureKpa: number,
    viscosityPas: number,
    domainLengthM: number,
    charLengthM: number,
  ): LatticeParamsLike;
  vertex_pressure_ptr(): number;
  vertex_pressure_len(): number;
  pressure_anchors(): {
    p_min_pa: number;
    p_max_pa: number;
    q_ref_pa: number;
    free(): void;
  };
};

export interface SmokeProbeResult {
  active: number;
  meanSpeed: number;
  /** F012 TEMPORARY: min/max vertex pressure [Pa] after the 60 steps. */
  pMinPa: number;
  pMaxPa: number;
  /** F012 TEMPORARY: stagnation reference ½·ρ·U² [Pa]. */
  qRefPa: number;
}

/**
 * TEMPORARY smoke probe (F011; deleted in F019 like F003's probe).
 *
 * Resets the flow, spawns 2 000 inlet particles, advances 60 lattice steps
 * (one advect per step), and reports the surviving count plus the mean
 * lattice speed over the active set. Deterministic: `spawn_particles`
 * reseeds, so two consecutive clicks agree exactly.
 *
 * F012 extension: sets default physical conditions first (15 m/s, sea-level
 * air — the manual-check operating point, q_ref ≈ 135.5 Pa) so the pressure
 * anchors it additionally returns carry physical magnitudes.
 */
export async function runSmokeProbe(): Promise<SmokeProbeResult> {
  const api = (await ensureEngine()) as PressureWasmApi;
  api.set_conditions(15.0, 101.325, 1.81e-5, 1.0, 0.25);
  api.reset_flow();
  api.spawn_particles(2000);
  for (let i = 0; i < 60; i += 1) {
    api.step(1);
    api.advect_particles(1.0);
  }
  const active = api.active_particle_count();
  let meanSpeed = 0;
  if (active > 0) {
    const ptr = api.speeds_ptr();
    // Synchronous read — no allocation-triggering call happens while the
    // view is alive, per ARCHITECTURE.md §5 buffer-view rules.
    const speeds = new Float32Array(api.memory.buffer, ptr, active);
    let sum = 0;
    for (let i = 0; i < active; i += 1) {
      sum += speeds[i] ?? 0;
    }
    meanSpeed = sum / active;
  }
  // Synchronous anchor read (plain struct, copied — no view lifetime issue).
  // The anchors object is wasm-heap-allocated per call, so it is freed
  // before returning (F015.3; previously leaked one per probe click).
  const anchors = api.pressure_anchors();
  try {
    return {
      active,
      meanSpeed,
      pMinPa: anchors.p_min_pa,
      pMaxPa: anchors.p_max_pa,
      qRefPa: anchors.q_ref_pa,
    };
  } finally {
    anchors.free();
  }
}

// ── TEMPORARY particle-streamlines driver (F014; deleted in F019) ──────────
// Until `SimEngine` exists, this section owns the live particle loop: one
// `ParticleSystem` on the SceneManager `particles` layer, stepped from
// `SceneManager.onFrame`. `ParticleSystem` itself stays driver-agnostic (it
// only receives typed-array views — never imports wasm modules).

export const PARTICLE_COUNT_MIN = 5000;
export const PARTICLE_COUNT_MAX = 100000;
export const PARTICLE_COUNT_STEP = 5000;
export const PARTICLE_COUNT_DEFAULT = 30000;

/** Top-up bound per frame (F014 §4): keeps respawn cost bounded. */
const RESPAWN_PER_FRAME_MAX = 2000;

/**
 * Speed-ramp headroom (F014 §2): the caller-side `speedNorm` max is
 * `1.3 × u_inlet` in lattice units — gap-accelerated particles outrun the
 * freestream, and the headroom keeps them on-scale instead of compressing
 * the whole freestream to mid-ramp. F019 computes the same anchors.
 */
const SPEED_NORM_HEADROOM = 1.3;

let particleTarget = PARTICLE_COUNT_DEFAULT;
/** True once the driver primed conditions + flow + the initial spawn. */
let particlePrimed = false;
/** Cached inlet lattice speed feeding `speedNorm` (read once at prime). */
let inletULattice = 0.05;

export function getParticleTargetCount(): number {
  return particleTarget;
}

/**
 * TEMPORARY count control backend (F014 §3; relocated by F018/F019).
 * Clamps to the 5k–100k slider range, stores the target for the frame
 * top-up, and reseeds the pool via destructive `spawn_particles`.
 */
export async function setParticleCount(count: number): Promise<number> {
  const stepped = Math.round(count / PARTICLE_COUNT_STEP) * PARTICLE_COUNT_STEP;
  const clamped = Math.min(
    PARTICLE_COUNT_MAX,
    Math.max(PARTICLE_COUNT_MIN, stepped),
  );
  particleTarget = clamped;
  const api = (await ensureEngine()) as ParticleWasmApi;
  api.spawn_particles(clamped);
  return clamped;
}

/**
 * TEMPORARY frame driver (F014 §4). Creates the `ParticleSystem`, primes the
 * engine once (default 15 m/s sea-level operating point — mirrors
 * `runSmokeProbe` — then `reset_flow` + initial spawn), and subscribes to
 * `SceneManager.onFrame`. Each frame: `step(1)` + `advect_particles(1.0)`
 * (fixed cadence of 1 step/frame — F019 owns adaptive timing, do not tune
 * here), top-up respawn when `active < target × 0.98` (≤ 2 000/frame), then
 * fresh zero-copy views into `ParticleSystem.update` (re-fetched every
 * frame, never held across calls, per ARCHITECTURE.md §5).
 *
 * Returns a stop function that unsubscribes and disposes GPU resources.
 * Safe under StrictMode remount: stopping then starting reuses the primed
 * engine without resetting the developed flow.
 */
export function startParticleDriver(manager: SceneManager): () => void {
  const system = new ParticleSystem(
    manager.getLayer("particles"),
    PARTICLE_CAPACITY,
  );
  const speedNorm = { min: 0, max: SPEED_NORM_HEADROOM * inletULattice };
  let stopped = false;
  let api: PressureWasmApi | null = null;

  const unsubscribe = manager.onFrame(() => {
    if (stopped || api === null) return;
    api.step(1);
    api.advect_particles(1.0);
    const active = api.active_particle_count();
    if (active < particleTarget * 0.98) {
      api.respawn(Math.min(particleTarget - active, RESPAWN_PER_FRAME_MAX));
    }
    const count = Math.min(api.active_particle_count(), PARTICLE_CAPACITY);
    const posPtr = api.particles_ptr();
    const spdPtr = api.speeds_ptr();
    if (posPtr === 0 || spdPtr === 0) return;
    const positions = new Float32Array(
      api.memory.buffer,
      posPtr,
      PARTICLE_CAPACITY * 3,
    );
    const speeds = new Float32Array(api.memory.buffer, spdPtr, PARTICLE_CAPACITY);
    system.update(positions, speeds, count, "speed", speedNorm);
  });

  void (async () => {
    try {
      const engine = (await ensureEngine()) as PressureWasmApi;
      if (stopped) return;
      if (!particlePrimed) {
        particlePrimed = true;
        const params = engine.set_conditions(15.0, 101.325, 1.81e-5, 1.0, 0.25);
        const u = params.u_lattice;
        params.free();
        if (Number.isFinite(u) && u > 0) {
          inletULattice = u;
          speedNorm.max = SPEED_NORM_HEADROOM * u;
        }
        engine.reset_flow();
        engine.spawn_particles(particleTarget);
      }
      api = engine;
    } catch {
      // Engine load failure surfaces via the existing probes/pipeline error
      // states; the driver simply stays idle (F019 replaces all of this).
    }
  })();

  return () => {
    stopped = true;
    unsubscribe();
    system.dispose();
  };
}

// ── TEMPORARY surface-pressure heatmap driver (F015; deleted in F019) ──────
// Until `SimEngine` exists, this section owns the live heatmap loop: one
// `HeatmapOverlay` on the SceneManager model mesh, refreshed from
// `SceneManager.onFrame`. Read-only — it never calls `step` (the particle
// driver owns stepping) and never imports wasm modules directly (views only).
// `HeatmapOverlay` itself stays driver-agnostic (F019 calls the same
// `update` signature).

/** Legend/overlay anchor snapshot in the exact shape F019 will pass around. */
export interface HeatmapAnchorState {
  pMinPa: number;
  pMaxPa: number;
  qRefPa: number;
}

/** Shared empty pressure view (no mesh yet) — never written to. */
const EMPTY_PRESSURE = new Float32Array(0);

/** Legend notify cadence: 4 Hz (spec §2/§4 — React re-renders stay cheap). */
const LEGEND_NOTIFY_MS = 250;

let heatmapEnabled = true;
let heatmapManager: SceneManager | null = null;
let heatmapOverlay: HeatmapOverlay | null = null;
let cachedAnchors: HeatmapAnchorState = { pMinPa: 0, pMaxPa: 0, qRefPa: 0 };
const heatmapListeners = new Set<(anchors: HeatmapAnchorState) => void>();
let lastLegendNotifyMs = 0;

export function getHeatmapEnabled(): boolean {
  return heatmapEnabled;
}

export function getHeatmapAnchors(): HeatmapAnchorState {
  return { ...cachedAnchors };
}

/**
 * Subscribe to anchor snapshots for the legend (notified at 4 Hz from the
 * frame driver, plus once immediately with the cached value so the legend
 * never renders stale). Returns an unsubscribe function.
 */
export function subscribeHeatmapAnchors(
  listener: (anchors: HeatmapAnchorState) => void,
): () => void {
  heatmapListeners.add(listener);
  listener({ ...cachedAnchors });
  return () => {
    heatmapListeners.delete(listener);
  };
}

/**
 * TEMPORARY heatmap toggle backend (F015 §2; relocated by F018/F019).
 * Enabling attaches the overlay to the current model geometry (if any) and
 * switches the material to vertex colors; disabling clears the attribute
 * and restores the plain gray material exactly. Safe before the driver
 * starts (the flag persists; start re-attaches when a model is present).
 */
export function setHeatmapEnabled(on: boolean): void {
  heatmapEnabled = on;
  const manager = heatmapManager;
  const overlay = heatmapOverlay;
  if (!manager || !overlay) return;
  if (!on) {
    overlay.clear();
    manager.setModelVertexColors(false);
    return;
  }
  const geometry = manager.getModelGeometry();
  if (geometry) {
    overlay.attach(geometry);
    manager.setModelVertexColors(true);
  }
}

/**
 * TEMPORARY frame driver (F015 §3). Each frame (read-only — no `step`):
 * reconcile the overlay with the live model geometry (re-attach on swap,
 * detach when the model is gone or the toggle is off), read the
 * `vertex_pressure` view + `pressure_anchors()` (freed every frame — see
 * DECISIONS.md F015.3), and call `HeatmapOverlay.update` (which throttles
 * color fills to every 3rd frame itself). Legend subscribers are notified at
 * 4 Hz.
 *
 * Returns a stop function that unsubscribes, detaches the overlay, and
 * restores the base material. Safe under StrictMode remount.
 */
export function startHeatmapDriver(manager: SceneManager): () => void {
  heatmapManager = manager;
  const overlay = new HeatmapOverlay();
  heatmapOverlay = overlay;
  let stopped = false;
  let api: PressureWasmApi | null = null;

  const unsubscribe = manager.onFrame(() => {
    if (stopped || api === null) return;
    const geometry = heatmapEnabled ? manager.getModelGeometry() : null;
    if (!geometry) {
      if (overlay.attachedGeometry) {
        overlay.clear();
        manager.setModelVertexColors(false);
      }
      return;
    }
    if (overlay.attachedGeometry !== geometry) {
      overlay.attach(geometry);
      manager.setModelVertexColors(true);
    }
    const len = api.vertex_pressure_len();
    const ptr = api.vertex_pressure_ptr();
    // Synchronous read — no allocation-triggering call happens while the
    // view is alive, per ARCHITECTURE.md §5 buffer-view rules.
    const pressure =
      ptr === 0 || len === 0
        ? EMPTY_PRESSURE
        : new Float32Array(api.memory.buffer, ptr, len);
    const raw = api.pressure_anchors();
    const anchors: HeatmapAnchorState = {
      pMinPa: raw.p_min_pa,
      pMaxPa: raw.p_max_pa,
      qRefPa: raw.q_ref_pa,
    };
    raw.free();
    overlay.update(pressure, anchors);
    cachedAnchors = anchors;
    const now = performance.now();
    if (now - lastLegendNotifyMs >= LEGEND_NOTIFY_MS) {
      lastLegendNotifyMs = now;
      const snapshot = { ...anchors };
      for (const listener of heatmapListeners) {
        listener(snapshot);
      }
    }
  });

  void (async () => {
    try {
      const engine = (await ensureEngine()) as PressureWasmApi;
      if (stopped) return;
      api = engine;
    } catch {
      // Engine load failure surfaces via the existing probes/pipeline error
      // states; the driver simply stays idle (F019 replaces all of this).
    }
  })();

  return () => {
    stopped = true;
    unsubscribe();
    overlay.clear();
    manager.setModelVertexColors(false);
    if (heatmapOverlay === overlay) heatmapOverlay = null;
    if (heatmapManager === manager) heatmapManager = null;
  };
}

// ── TEMPORARY smoke-tracer driver (F016; deleted in F019) ─────────────────
// Until `SimEngine` exists, this section owns the live smoke loop: one
// `SmokeTracers` rake on the SceneManager `smoke` layer, sampled from
// `SceneManager.onFrame` after the particle driver's `step(1)` (subscription
// order — this driver never calls `step` itself, mirroring the F015 heatmap
// driver's read-only rule). `SmokeTracers` itself stays driver-agnostic (it
// only receives the injected sampling closure — never imports wasm modules).

/** Smoke rake size (F016 §1 default — no UI control in v1). */
export const SMOKE_TRACER_COUNT = 25;
/** Trail-length UI range (F016 §2 number input). */
export const SMOKE_HISTORY_MIN = 30;
export const SMOKE_HISTORY_MAX = 240;
export const SMOKE_HISTORY_DEFAULT = 90;
/** Rake-height slider range (F016 §2: y in 8..ny−8). */
export const SMOKE_RAKE_Y_MIN = 8;
export const SMOKE_RAKE_Y_MAX = DOMAIN.ny - 8;
/** Rake-width slider range (F016 §2: halfWidth in 2..16). */
export const SMOKE_HALF_WIDTH_MIN = 2;
export const SMOKE_HALF_WIDTH_MAX = 16;

/**
 * Lattice time step per frame (F016 §1 `dt`). This is 1.0 lattice time unit
 * per solver step — NOT `LatticeParams.dt` (physical seconds, ~4e-5 s),
 * which would freeze the ribbons if used for lattice-space `p += v·dt`
 * integration (see DECISIONS.md F016.1). Matches the particle driver's fixed
 * `advect_particles(1.0)` cadence; F019 owns real timing.
 */
const SMOKE_DT_LATTICE = 1.0;

/**
 * Structural view of the F011 sampling ABI (same TEMPORARY-bridge pattern as
 * above — folded into `SimEngine` in F019).
 */
type SmokeWasmApi = PressureWasmApi & {
  sample_velocity_batch(points: Float32Array, out: Float32Array): void;
};

/** Rake line snapshot in the exact shape `SmokeTracers.setRake` takes. */
export interface SmokeRakeState {
  yCenter: number;
  zCenter: number;
  halfWidth: number;
}

let smokeEnabled = true;
let smokeRake: SmokeRakeState = {
  yCenter: DOMAIN.ny / 2,
  zCenter: DOMAIN.nz / 2,
  halfWidth: 8,
};
let smokeHistoryLen = SMOKE_HISTORY_DEFAULT;
let smokeTracers: SmokeTracers | null = null;

export function getSmokeEnabled(): boolean {
  return smokeEnabled;
}

export function getSmokeRake(): SmokeRakeState {
  return { ...smokeRake };
}

export function getSmokeHistoryLen(): number {
  return smokeHistoryLen;
}

function clampSmokeRake(
  yCenter: number,
  zCenter: number,
  halfWidth: number,
): SmokeRakeState {
  const y = Number.isFinite(yCenter)
    ? Math.min(SMOKE_RAKE_Y_MAX, Math.max(SMOKE_RAKE_Y_MIN, yCenter))
    : DOMAIN.ny / 2;
  const z = Number.isFinite(zCenter)
    ? Math.min(DOMAIN.nz - 1, Math.max(1, zCenter))
    : DOMAIN.nz / 2;
  const hw = Number.isFinite(halfWidth)
    ? Math.min(
        SMOKE_HALF_WIDTH_MAX,
        Math.max(SMOKE_HALF_WIDTH_MIN, halfWidth),
      )
    : 8;
  return { yCenter: y, zCenter: z, halfWidth: hw };
}

/**
 * TEMPORARY smoke toggle backend (F016 §2; relocated by F018/F020).
 * Disabling hides the `smoke` layer (lines removed from view, trails kept);
 * re-enabling re-shows it with a fresh emission (re-seed, per the "on
 * restores fresh emission" criterion). Safe before the driver starts (the
 * flag persists; start applies it).
 */
export function setSmokeEnabled(on: boolean): void {
  const wasOn = smokeEnabled;
  smokeEnabled = on;
  const tracers = smokeTracers;
  if (!tracers) return;
  if (on && !wasOn) {
    tracers.setRake(smokeRake.yCenter, smokeRake.zCenter, smokeRake.halfWidth);
  }
}

/**
 * TEMPORARY rake backend (F016 §2; relocated by F018/F020). Clamps to the
 * slider ranges and re-seeds live (param change clears trails, per spec §1).
 */
export function setSmokeRake(
  yCenter: number,
  zCenter: number,
  halfWidth: number,
): SmokeRakeState {
  smokeRake = clampSmokeRake(yCenter, zCenter, halfWidth);
  smokeTracers?.setRake(
    smokeRake.yCenter,
    smokeRake.zCenter,
    smokeRake.halfWidth,
  );
  return { ...smokeRake };
}

/**
 * TEMPORARY trail-length backend (F016 §2; relocated by F018/F020). Clamps
 * to 30..240 and rebuilds live (disposal + new, no leaks).
 */
export function setSmokeHistoryLen(n: number): number {
  const next = Number.isFinite(n)
    ? Math.min(SMOKE_HISTORY_MAX, Math.max(SMOKE_HISTORY_MIN, Math.floor(n)))
    : SMOKE_HISTORY_DEFAULT;
  smokeHistoryLen = next;
  smokeTracers?.setHistoryLen(next);
  return next;
}

/**
 * TEMPORARY frame driver (F016 §3). Each frame (read-only — no `step`): if
 * the toggle is off, hide the `smoke` layer and skip; otherwise ensure it is
 * visible and call `smoke.update(dt, closure)` with one batched
 * `sample_velocity_batch` call (tracerCount ≤ 100 points — the ≤ 2 ms
 * budget). Re-enabling after a disabled stretch re-seeds for a fresh
 * emission.
 *
 * Returns a stop function that unsubscribes and disposes GPU resources.
 * Safe under StrictMode remount.
 */
export function startSmokeDriver(manager: SceneManager): () => void {
  const tracers = new SmokeTracers(manager.getLayer("smoke"), {
    tracerCount: SMOKE_TRACER_COUNT,
    historyLen: smokeHistoryLen,
    seedLine: { ...smokeRake },
  });
  smokeTracers = tracers;
  manager.getLayer("smoke").visible = smokeEnabled;
  let stopped = false;
  let api: SmokeWasmApi | null = null;
  let wasEnabled = smokeEnabled;

  const unsubscribe = manager.onFrame(() => {
    if (stopped || api === null) return;
    const layer = manager.getLayer("smoke");
    if (!smokeEnabled) {
      layer.visible = false;
      wasEnabled = false;
      return;
    }
    layer.visible = true;
    if (!wasEnabled) {
      // Fresh emission after a disabled stretch (toggle criterion).
      tracers.setRake(
        smokeRake.yCenter,
        smokeRake.zCenter,
        smokeRake.halfWidth,
      );
      wasEnabled = true;
    }
    const engine = api;
    tracers.update(SMOKE_DT_LATTICE, (points, out) => {
      engine.sample_velocity_batch(points, out);
    });
  });

  void (async () => {
    try {
      const engine = (await ensureEngine()) as SmokeWasmApi;
      if (stopped) return;
      api = engine;
    } catch {
      // Engine load failure surfaces via the existing probes/pipeline error
      // states; the driver simply stays idle (F019 replaces all of this).
    }
  })();

  return () => {
    stopped = true;
    unsubscribe();
    tracers.dispose();
    if (smokeTracers === tracers) smokeTracers = null;
  };
}

// ── TEMPORARY live-stats readout (F017; deleted in F019) ────────────────
// Until `SimEngine` exists, this section assembles `SimReadout` (the durable
// F017 contract from `types.ts`) from the F013 `stats()` record plus the
// F012 `pressure_anchors()` q_ref. `StatsPanel` polls `getReadout()` at
// 4 Hz; F019 provides the same shape from `SimulationContext` and this whole
// section goes away (component unchanged).
//
// Model identity (`modelName` / `modelTriangles`) comes from `ModelContext`,
// which this React-free module cannot read — the bridge reports both as
// null and `StatsPanel` overwrites them from the context on every poll.

/**
 * Structural view of the F013 stats ABI (same TEMPORARY-bridge pattern as
 * above — folded into `SimEngine` in F019).
 *
 * `stats()` returns a wasm-bindgen class instance (heap-allocated per call,
 * like `pressure_anchors()`), so every read must end in `.free()`.
 */
type StatsRecordLike = {
  readonly cd: number;
  readonly drag_n: number;
  readonly p_min_pa: number;
  readonly p_max_pa: number;
  readonly re: number;
  readonly steps: bigint;
  readonly active_particles: number;
  readonly stable: boolean;
  free(): void;
};

type StatsWasmApi = PressureWasmApi & {
  stats(): StatsRecordLike;
};

/** EMA weight for the JS-side rAF frame counter (spec §2). */
const FPS_EMA_ALPHA = 0.1;
/** Longer gaps are discarded (background-tab return would drag the EMA). */
const FPS_SAMPLE_MAX_MS = 500;

let fpsEma = 0;
let fpsTickerStarted = false;
let lastFrameMs = 0;

/**
 * Lazily start the module-lifetime rAF ticker feeding `fpsEma`. One
 * timestamp subtraction per frame — negligible next to the sim drivers.
 * No stop function: the engine singleton this serves is itself
 * process-lifetime, and F019 deletes the whole section.
 */
function ensureFpsTicker(): void {
  if (fpsTickerStarted) return;
  if (
    typeof window === "undefined" ||
    typeof window.requestAnimationFrame !== "function"
  ) {
    return;
  }
  fpsTickerStarted = true;
  lastFrameMs = window.performance.now();
  const tick = (nowMs: number): void => {
    const dt = nowMs - lastFrameMs;
    lastFrameMs = nowMs;
    if (dt > 0 && dt <= FPS_SAMPLE_MAX_MS) {
      const fps = 1000 / dt;
      fpsEma = fpsEma === 0 ? fps : fpsEma + FPS_EMA_ALPHA * (fps - fpsEma);
    }
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}

let statsApi: StatsWasmApi | null = null;

/** Non-blocking engine grab: first polls stay on placeholders, later live. */
function primeStatsApi(): void {
  if (statsApi !== null) return;
  void ensureEngine().then(
    (api) => {
      statsApi = api as StatsWasmApi;
    },
    () => {
      // Engine unavailable (e.g. fresh clone without `npm run wasm:build`):
      // stay on placeholders; the next poll retries.
    },
  );
}

let lastSteps: number | null = null;
let lastStepsMs = 0;

/**
 * TEMPORARY stats assembler (F017 §1; `SimEngine.getReadout()` in F019).
 * Synchronous and total (never throws — a failing ABI drops back to null
 * so the 250 ms poll loop survives a poisoned instance). Null until the
 * engine resolves; `modelName` / `modelTriangles` are always null here
 * (see the section note — the panel fills them from `ModelContext`).
 */
export function getReadout(): SimReadout | null {
  ensureFpsTicker();
  primeStatsApi();
  const api = statsApi;
  if (api === null) return null;
  let record: StatsRecordLike | null = null;
  try {
    record = api.stats();
    try {
      // Steps/s from the step-counter delta across polls (spec §2). The
      // record's `steps` is the same counter `steps_done()` reads, so one
      // call serves both. First poll has no baseline → 0.
      const steps = Number(record.steps);
      const nowMs = performance.now();
      let stepsPerSecond = 0;
      if (lastSteps !== null) {
        const dtS = (nowMs - lastStepsMs) / 1000;
        if (dtS > 0) {
          stepsPerSecond = Math.max(0, (steps - lastSteps) / dtS);
        }
      }
      lastSteps = steps;
      lastStepsMs = nowMs;

      // `StatsRecord` carries no stagnation reference — it comes from the
      // F012 anchors (wasm-heap-allocated per call, freed before returning).
      const anchors = api.pressure_anchors();
      let qRefPa = 0;
      try {
        qRefPa = anchors.q_ref_pa;
      } finally {
        anchors.free();
      }

      // F013 sentinel: cd === −1 means "not yet meaningful" (< 200 steps
      // since reset or no mesh) — surfaced as null so the panel renders
      // "—" (same for the drag force, which shares the EMA).
      const meaningful =
        Number.isFinite(record.cd) && record.cd !== -1;
      return {
        fps: fpsEma,
        stepsPerSecond,
        cd: meaningful ? record.cd : null,
        dragN:
          meaningful && Number.isFinite(record.drag_n) ? record.drag_n : null,
        pMinPa: Number.isFinite(record.p_min_pa) ? record.p_min_pa : 0,
        pMaxPa: Number.isFinite(record.p_max_pa) ? record.p_max_pa : 0,
        qRefPa: Number.isFinite(qRefPa) ? qRefPa : 0,
        re: Number.isFinite(record.re) ? record.re : 0,
        gridDims: [DOMAIN.nx, DOMAIN.ny, DOMAIN.nz],
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
