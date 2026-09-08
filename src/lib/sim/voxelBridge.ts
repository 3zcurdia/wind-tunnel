import type { BufferGeometry } from "three";
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
 */
type PressureWasmApi = ParticleWasmApi & {
  set_conditions(
    uMps: number,
    pressureKpa: number,
    viscosityPas: number,
    domainLengthM: number,
    charLengthM: number,
  ): LatticeParamsLike;
  pressure_anchors(): {
    p_min_pa: number;
    p_max_pa: number;
    q_ref_pa: number;
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
  const anchors = api.pressure_anchors();
  return {
    active,
    meanSpeed,
    pMinPa: anchors.p_min_pa,
    pMaxPa: anchors.p_max_pa,
    qRefPa: anchors.q_ref_pa,
  };
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
