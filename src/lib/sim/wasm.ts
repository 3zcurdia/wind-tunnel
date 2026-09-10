/**
 * WASM loader singleton (F003).
 *
 * Owns instantiation of the generated wasm-bindgen module (`src/wasm/`,
 * produced by `npm run wasm:build` — gitignored, so a fresh clone must run
 * that script first) and the typing of the raw ABI. `SimEngine` is the only
 * consumer; components go through it, never import the generated module
 * directly.
 */

/** Structural view of the wasm-bindgen `LatticeParams` return (F009). */
export type LatticeParamsHandle = {
  readonly u_lattice: number;
  readonly tau: number;
  readonly dt: number;
  readonly dx_phys: number;
  readonly re: number;
  readonly rho_phys: number;
  readonly unstable: boolean;
  free(): void;
};

/** Structural view of the generated `SetMeshResult` class (F022). */
export type SetMeshResult = {
  readonly solidCount: number;
  readonly skippedTriangles: number;
  free(): void;
};

/** Structural view of the wasm-bindgen `PressureAnchors` return (F012). */
export type PressureAnchorsHandle = {
  readonly p_min_pa: number;
  readonly p_max_pa: number;
  readonly q_ref_pa: number;
  free(): void;
};

/** Structural view of the wasm-bindgen `Timing` return (F010). */
export type TimingHandle = {
  readonly last_step_ms: number;
  readonly avg_step_ms: number;
  free(): void;
};

/** Structural view of the wasm-bindgen `StatsRecord` return (F013). */
export type StatsRecordHandle = {
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

/** Raw exports of the generated `windtunnel` module (ARCHITECTURE.md §5). */
export type WasmApi = {
  /** Allocate domain & solver state (F006; resets everything). */
  init_sim(nx: number, ny: number, nz: number, particle_capacity: number): void;
  /**
   * Voxelize domain-space triangles (F006; F022: returns `{ solidCount,
   * skippedTriangles }` — free the result after reading, as `SimEngine`
   * does).
   */
  set_mesh(triangles: Float32Array): SetMeshResult;
  /** Clear the mesh; the grid returns to all-fluid (F006). */
  clear_mesh(): void;
  /** Pointer to the occupancy grid bytes (F006; re-fetch after reallocating). */
  occupancy_ptr(): number;
  /** Occupancy grid length in bytes (F006). */
  occupancy_len(): number;
  /** True when the last set_mesh fell back to shell-only mode (F006). */
  surface_mode_flag(): boolean;
  /** Recompute lattice params from physical conditions (F009). */
  set_conditions(
    uMps: number,
    pressureKpa: number,
    viscosityPas: number,
    domainLengthM: number,
    charLengthM: number,
  ): LatticeParamsHandle;
  /** Re-initialize the flow field to the inlet uniform state (F009). */
  reset_flow(): void;
  /** Advance the solver by `n` LBM steps (F007). */
  step(n: number): void;
  /** False once the field has diverged (F010). */
  is_stable(): boolean;
  /** Per-step timing of the last batch (F010). */
  timing(): TimingHandle;
  /** Pointer to the particle position buffer (F014). */
  particles_ptr(): number;
  /** Pointer to the particle speed buffer (F014). */
  speeds_ptr(): number;
  /** Live particle count (F014). */
  active_particle_count(): number;
  /** Seed `count` particles across the inlet plane (F014). */
  spawn_particles(count: number): void;
  /** Top up dead particles, returns how many were respawned (F014). */
  respawn(n: number): number;
  /** Integrate particle positions by `dt` lattice time units (F014). */
  advect_particles(dt: number): void;
  /** Batched velocity sampling for smoke tracers (F016). */
  sample_velocity_batch(points: Float32Array, out: Float32Array): void;
  /** Pointer to the per-vertex surface pressure buffer (F015). */
  vertex_pressure_ptr(): number;
  /** Per-vertex surface pressure buffer length (F015). */
  vertex_pressure_len(): number;
  /** Pressure color-ramp anchors (F012). */
  pressure_anchors(): PressureAnchorsHandle;
  /** Aggregate readout for the HUD (F013). */
  stats(): StatsRecordHandle;
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
      return { ...mod, memory: initOutput.memory } as WasmApi;
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
