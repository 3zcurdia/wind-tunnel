# F006 — Rust: mesh → obstacle voxel grid

## Metadata

| Field | Value |
|-------|-------|
| ID | F006 |
| Phase | 1 |
| Size | M |
| Skill fit | `Rust` |
| Depends on | F003 (wasm pipeline); consumes F005's domain-space triangles |
| Status | `[ ]` todo |

## Goal

The Rust crate gains real functionality: `set_mesh(triangles) → solid-cell count`
rasterizes a triangle mesh into the lattice as an obstacle grid, with a flood-fill
interior test plus a surface-only fallback for leaky meshes. `occupancy_ptr()` exposes
the grid so TS can render a debug voxel view. No flow simulation yet.

## Context

First solver-adjacent feature; establishes the internal data conventions every Rust
feature shares (`ARCHITECTURE.md` §3): row-major `idx = x + nx*(y + ny*z)`, grid state
owned by a single `SimState` struct created by `init_sim`. Algorithm modules
(`voxel.rs`) stay `wasm_bindgen`-free; only `lib.rs` exports glue. The obstacle grid
is the substrate F008's bounce-back and F012's surface pressure build on.

## Detailed spec

1. **`wasm/src/lib.rs` skeleton state**:
   ```rust
   pub struct SimState {
       nx: usize, ny: usize, nz: usize,
       occupancy: Vec<u8>,            // 0 empty, 1 solid
       solid_count: usize,
       mesh_vertices: Vec<f32>,       // domain-space, per-vertex xyz (kept for F012)
       vertex_count: usize,
       surface_mode: bool,            // true when interior fill was skipped
   }
   ```
   - `init_sim(nx, ny, nz, particle_capacity)` allocates state, zeros occupancy.
     Store `particle_capacity` even though particles arrive in F011 (reserve it).
   - `set_mesh(triangles: &[f32]) -> u32`: validates length % 9 == 0 (return 0 on
     failure — no panics, per CONVENTIONS), runs voxelization below, stores
     per-vertex positions (deduplicated: parse unique vertices from triangle soup,
     tolerance 1e-6), returns solid cell count.
2. **`wasm/src/voxel.rs`** — the algorithm module:

   **Step 1 — surface rasterization.** For each triangle, mark every lattice cell the
   triangle intersects as surface. Use the Akenine-Möller triangle-box overlap test,
   sweeping the triangle's AABB voxel range (clamp to grid). This is standard and
   conservative; may mark extra cells, acceptable at this resolution.

   **Step 2 — interior determination.** BFS flood fill from all six domain-boundary
   faces over cells not marked surface. Every cell *not reached* (and not surface) is
   interior → mark solid. Cells reached → fluid. Handle non-watertight leaks:
   - After fill, compute `interior_estimate = unreached_non_surface_cells`.
   - Sanity heuristic: if the mesh is closed, interior volume should be
     `> 0` and `< 0.5 × (nx·ny·nz − surface_count)`. If interior estimate is 0 but
     the mesh has surface cells, OR the fill consumed suspiciously little (mesh
     clearly leaky — detect by counting boundary-adjacent leak paths: if any
     flood-fill front cell borders the model bbox interior region but the mesh bbox
     volume suggests a closed body — use the simpler documented rule below).
   - **Documented rule (implement exactly this)**: run flood fill; compute
     `solid = surface + interior`. Compute model bbox from marked surface cells; a
     properly closed mesh yields `interior ≥ 0.05 × bbox_cell_volume`. If
     `interior < 0.05 × bbox_cell_volume`, assume leaky → set `surface_mode = true`
     and define solid = surface cells only.
   - Marking solid = 1 in `occupancy`.
3. **ABI additions** (match `ARCHITECTURE.md` §5 exactly):
   - `set_mesh(triangles: &[f32]) -> u32`, `clear_mesh()`.
   - `occupancy_ptr() -> *const u8`, plus `occupancy_len() -> u32`.
   - `surface_mode_flag() -> bool` (TS reads it for the F022 user notice).
   - TEMPORARY `ping()` from F003 stays until F019 removes it.
4. **TS debug view** (`src/components/viewport/VoxelDebugView.ts` registered into
   SceneManager's `debug` layer, toggled by a boolean — F020 adds the real toggle;
   for now expose `SceneManager.setVoxelDebugVisible(on: boolean)` and call it from a
   temporary checkbox in the Controls rail):
   - `THREE.InstancedMesh` with `BoxGeometry(0.9, 0.9, 0.9)` (lattice scale 0.1 world),
     one instance per solid cell (cap 60 000 instances — beyond that, decimate by
     stride and note it), color `#ef4444`, transparent 0.8.
   - Rebuild on each `set_mesh`; positions = lattice coords × 0.1 − domain center
     offset (reuse SceneManager's world mapping; add
     `SceneManager.latticeToWorld(x,y,z): THREE.Vector3` helper if not already public).
   - This view is debug-only and throttled: rebuild ≤ 1× per second.
5. **JS-side helper**: `SimEngine` does not exist yet — for this feature, a temporary
   client module `src/lib/sim/voxelBridge.ts` loads wasm, calls `init_sim(128,48,48, 60000)`,
   exposes `setMeshFromGeometry(geometry): { solidCount, surfaceMode }` building the
   f32 triangle array (non-indexed positions triplets) from a normalized BufferGeometry.
   F019 will fold this into `SimEngine` (note in F019's spec).

## Files to create / modify

```
wasm/src/lib.rs               (modify) — SimState, init_sim, set_mesh, occupancy exports
wasm/src/voxel.rs             (new)    — rasterization + flood fill
src/lib/sim/voxelBridge.ts    (new)    — TEMPORARY JS bridge (folded into SimEngine in F019)
src/components/viewport/VoxelDebugView.ts            (new)
src/components/viewport/SceneManager.ts              (modify) — debug layer + helpers + toggle
src/components/controls/VoxelDebugToggle.tsx         (new)    — TEMPORARY checkbox
src/app/page.tsx                                     (modify) — hook pipeline → bridge → debug view
```

## Dependencies added

- none (wasm-bindgen already present)

## Interface contract

- ABI: `set_mesh(triangles) -> u32 solid count`; `occupancy_ptr()/occupancy_len()`;
  `surface_mode_flag() -> bool` — as `ARCHITECTURE.md` §5 (surface_mode flag is an
  extra accessor; update §5 in the same commit if naming differs).
- `voxelBridge.setMeshFromGeometry(geometry: THREE.BufferGeometry)`.
- Voxelization must be deterministic (same input → same grid, no HashMap iteration
  order dependencies).

## Acceptance criteria

- [ ] Unit cube mesh (1×1×1 lattice-space box spanning cells [10..14)³ around the
      placement center) → solid count between 90 and 160, all occupied cells within
      the expected bbox.
- [ ] Sphere mesh (r = 12 lattice cells) → solid count ≈ (4/3)πr³ × [0.6, 1.3]
      (conservative rasterization tolerance), `surface_mode_flag() == false`.
- [ ] Leaky mesh test: same sphere with one face removed (open shell) →
      `surface_mode_flag() == true`, solid ≈ shell voxel count, no hang.
- [ ] Degenerate: `set_mesh` with `[]` or length-4 array returns 0 and leaves state
      valid (no panic, subsequent calls work).
- [ ] Debug view renders red cubes exactly covering the model silhouette from all
      three axis views.
- [ ] `cargo test` passes (see test plan); `npm run lint`/`build` pass.

## Test plan

- Rust unit (`voxel.rs`):
  - `empty_grid_has_no_solids` — trivial init.
  - `axis_aligned_box_produces_expected_solid_count` — box [10..14)³ → count in
    [90,160], surface_mode false.
  - `sphere_volume_within_tolerance` — r=12 at center, count within [0.6, 1.3]×
    analytic.
  - `open_shell_falls_back_to_surface_mode` — sphere minus one triangle fan region.
  - `malformed_input_returns_zero` — length not divisible by 9, empty array.
- Manual: load sphere OBJ → toggle debug → visually compare red voxel cloud with the
  rendered model; try one non-watertight model and confirm no freeze.

## Out of scope

- Flow field, boundary conditions, bounce-back (F007/F008).
- Per-vertex pressure mapping (F012 — but `mesh_vertices` storage added here is its
  substrate).
- Octree/SPA optimizations, multi-resolution grids.
- Making the debug view pretty or user-facing (F020 owns toggles).
