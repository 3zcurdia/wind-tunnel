import type { BufferGeometry } from "three";
import { HeatmapOverlay } from "@/lib/viz/HeatmapOverlay";
import { ParticleSystem } from "@/lib/viz/ParticleSystem";
import type { SceneManager } from "@/components/viewport/SceneManager";
import { DOMAIN } from "@/lib/sim/types";
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
