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
