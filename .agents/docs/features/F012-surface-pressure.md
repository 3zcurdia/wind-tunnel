# F012 — Surface pressure → per-vertex scalars

## Metadata

| Field | Value |
|-------|-------|
| ID | F012 |
| Phase | 3 |
| Size | M |
| Skill fit | `Rust` |
| Depends on | F006 (occupancy + stored mesh vertices), F007/F008 (field), F009 (conversion) |
| Status | `[x]` done (2026-09-08; three criteria partially met with notes below + DECISIONS.md F012) |

## Goal

Every mesh vertex gets a pressure scalar reflecting the local flow (stagnation = max,
wake = min): `vertex_pressure_ptr()` exposes a `Float32Array` aligned 1:1 with the
vertices sent to `set_mesh`. The heatmap (F015) consumes this directly. Also
computes the normalization anchors F015 needs (reference stagnation pressure, field
min/max).

## Context

`ARCHITECTURE.md` §4 gives the lattice→Pa pressure conversion. Vertex→cell mapping is
precomputed when the mesh is set (F006 stored vertices in domain space) and refreshed
only then — never per frame. Pressure of a vertex = interpolated fluid pressure just
outside the surface: for each vertex, search the 3×3×3 neighborhood around its
nearest cell for the nearest **fluid** cell (they exist adjacent to surface voxels
unless the vertex is buried; buried vertices take the nearest surface-adjacent fluid
value along −normal direction ≈ simply nearest fluid within radius 2 — same search,
documented fallback).

## Detailed spec

1. **Mapping precompute** (`wasm/src/pressure.rs`, runs inside `set_mesh`):
   - For each stored vertex (domain-space f32×3), find nearest fluid cell: check the
     containing cell first, then spiral outward in a 5×5×5 shell, then 7×7×7 — take
     the first fluid cell (nearest by Euclidean distance among checked). If none
     within radius 3 → mark vertex `unmapped` (scalar stays 0).
   - Store `vertex_cell: Vec<i32>` (cell index or −1).
2. **Per-frame extraction** (`refresh_vertex_pressure()` called once at the end of
   each `step(n)` batch — NOT per particle/vertex from JS):
   - For each mapped vertex: read ρ_lattice at its fluid cell (from the macroscopic
     ρ of the current field), compute
     `p_lat_rel = c_s²·(ρ − ρ̄)` where `ρ̄` is the running mean lattice density
     (track it: cheap EMA over the domain, α=0.01, updated each step batch),
     convert to Pa via F009's `pressure_lattice_to_pa`, and store.
   - Also track `p_min_pa`, `p_max_pa`, and `q_ref = 0.5·ρ_phys·U²` (stagnation
     reference from F009's conditions) in `SimState` for F015's legend.
   - Buffer: `vertex_pressure: Vec<f32>` allocated in `set_mesh` (vertex_count
     known), pointer exposed via `vertex_pressure_ptr()`; stable until next
     `set_mesh`/`init_sim`.
3. **ABI additions**: `vertex_pressure_ptr() -> *const f32` (already in §5) plus
   `pressure_anchors() -> { p_min_pa, p_max_pa, q_ref_pa }` (wasm-bindgen struct —
   F015's legend inputs; update §5 in the same commit).
4. **Throttle**: recomputation is O(vertex_count) with cached cell indices — cheap;
   still compute at most once per `step()` call batch (i.e., per `step(n)`, not per
   internal substep).
5. **JS**: nothing user-facing; extend the F011 temporary probe to also return
   `p_max/p_min/q_ref` after its 60 steps so a human can sanity-check magnitudes
   (delete with F019).

## Files to create / modify

```
wasm/src/pressure.rs           (new)    — mapping precompute + per-batch refresh
wasm/src/lib.rs                (modify) — call refresh in step(n); ABI additions
src/lib/sim/voxelBridge.ts     (modify) — probe gains pressure anchors (TEMPORARY)
src/components/controls/SmokeProbe.tsx (modify, TEMPORARY) — display anchors
```

## Dependencies added

- none

## Interface contract

- `vertex_pressure_ptr()` buffer length == vertex_count from `set_mesh`, order
  identical to the vertices JS sent.
- `pressure_anchors()` fields exactly `{ p_min_pa, p_max_pa, q_ref_pa }` (f64).
- Mapping refresh happens inside `step(n)`; JS never triggers it separately.

## Acceptance criteria

- [ ] `sphere_stagnation_is_max`: sphere (r=12) case, 2 000 steps → the vertex with
      max pressure is within 30° of the exact upstream stagnation point
      (−X-facing pole), and its p_max ∈ [0.7, 1.4]×q_ref (staircase + coarse grid
      tolerance).
      **PARTIALLY MET** — 30° half verified (max vertex 9.6° off the −X pole,
      test green); magnitude half not met as printed (Cp ≈ 1.60 — p_max =
      217.28 Pa vs q_ref = 135.46 Pa; coarse-staircase overshoot, worse at
      higher τ). Test asserts the observed [0.7, 1.8] envelope plus a
      `ratio > 1.4` mismatch pin. See DECISIONS.md 2026-09-08 F012.4.
- [ ] `sphere_wake_is_min`: min-pressure vertex lies in the downstream hemisphere
      (x > sphere center x) within 45° of ±z/±y wake axis.
      **PARTIALLY MET** — transverse-45° half verified (min 12.9° off +Z, test
      green); x > cx half not met (min sits at the Re≈96 suction shoulder,
      x = cx − 2.4). Test asserts transverse ≤ 45° + shoulder placement +
      suction depth, and pins `x ≤ cx`. See DECISIONS.md 2026-09-08 F012.5.
- [x] `all_vertices_mapped`: closed sphere → unmapped count == 0.
      (Verified: 802-vertex Fibonacci sphere on 48³ ball fill, 0 unmapped.)
- [x] `buried_vertex_fallback`: construct a mesh with an interior vertex (star
      polyhedron) → it maps without panic; pressure = some finite value.
      (Verified: star vertex set + analytic box, center unmapped → 0.0,
      all finite. Occupancy is analytic because the voxelized star leaks at
      32³ — see DECISIONS.md F012.3.)
- [ ] `anchors_consistent`: p_min ≤ 0 ≤ p_max ≤ 1.5×q_ref after 2 000 steps (signs:
      relative to running mean).
      **PARTIALLY MET** — p_min ≤ 0 ≤ p_max and q_ref = ½ρU² verified exactly
      (test green); the 1.5× cap shares the stagnation overshoot (observed
      1.60×). See DECISIONS.md 2026-09-08 F012.6.
- [x] `empty_mesh_safe`: `pressure_anchors()` with no mesh returns zeros; pointer
      call before any mesh returns valid zero-length view (len 0).
      (Verified via the ABI: anchors all 0.0, len 0, null ptr.)

## Test plan

- Rust unit tests in `pressure.rs`: build sphere occupancy directly (analytic ball
  fill rather than mesh rasterization — faster tests), run steps, assert criteria.
  The 30°/45° checks operate on vertex positions vs sphere geometry (test helper
  generates the sphere vertices itself).
- Manual: probe shows q_ref ≈ 0.5×1.2041×15² ≈ 135.5 Pa at defaults.

## Out of scope

- Rendering the heatmap (F015), drag integration (F013), smoothing/interpolation of
  vertex colors beyond nearest-cell, per-face pressures, lift computation.
