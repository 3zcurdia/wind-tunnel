import type { BufferGeometry } from "three";
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
 * `init_sim(128, 48, 48, 60000)` and forwards domain-space geometries to
 * `set_mesh`. Buffer views are copied synchronously (never held across
 * allocation-triggering calls, per ARCHITECTURE.md §5).
 */
let initPromise: Promise<WasmApi> | null = null;

function ensureEngine(): Promise<WasmApi> {
  if (!initPromise) {
    initPromise = (async () => {
      const api = await loadWasm();
      api.init_sim(DOMAIN.nx, DOMAIN.ny, DOMAIN.nz, 60000);
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
  advect_particles(dt: number): void;
  speeds_ptr(): number;
  active_particle_count(): number;
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
  ): unknown;
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
