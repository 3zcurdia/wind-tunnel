/**
 * WASM loader singleton (F003).
 *
 * Owns instantiation of the generated wasm-bindgen module (`src/wasm/`,
 * produced by `npm run wasm:build` — gitignored, so a fresh clone must run
 * that script first). Until `SimEngine` exists (F019), this module is the
 * single owner of the raw ABI; components go through it, never import the
 * generated module directly.
 */

/** Raw exports of the generated `windtunnel` module, grown per feature. */
export type WasmApi = {
  ping(): string;
  /** Allocate domain & solver state (F006; resets everything). */
  init_sim(nx: number, ny: number, nz: number, particle_capacity: number): void;
  /** Voxelize domain-space triangles; returns the solid cell count (F006). */
  set_mesh(triangles: Float32Array): number;
  /** Clear the mesh; the grid returns to all-fluid (F006). */
  clear_mesh(): void;
  /** Pointer to the occupancy grid bytes (F006; re-fetch after reallocating). */
  occupancy_ptr(): number;
  /** Occupancy grid length in bytes (F006). */
  occupancy_len(): number;
  /** True when the last set_mesh fell back to shell-only mode (F006). */
  surface_mode_flag(): boolean;
  /** Linear memory for zero-copy buffer views (see ARCHITECTURE.md §5). */
  readonly memory: WebAssembly.Memory;
};

export class WasmLoadError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "WasmLoadError";
  }
}

let loadPromise: Promise<WasmApi> | null = null;

export function loadWasm(): Promise<WasmApi> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const mod = await import("@/wasm/windtunnel");
      const initOutput = await mod.default();
      return { ...mod, ping: mod.ping, memory: initOutput.memory };
    } catch (cause) {
      // Never cache a rejected promise: the next call retries fresh.
      loadPromise = null;
      throw new WasmLoadError(
        "Simulation engine failed to load — run `npm run wasm:build`",
        { cause },
      );
    }
  })();
  return loadPromise;
}
