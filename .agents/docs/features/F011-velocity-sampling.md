# F011 — Velocity sampling & particle advection

## Metadata

| Field | Value |
|-------|-------|
| ID | F011 |
| Phase | 3 |
| Size | M |
| Skill fit | `Rust` |
| Depends on | F007/F008 (flow field), F006 (occupancy) |
| Status | `[x]` done |

## Goal

Batched trilinear velocity sampling over the flow field, plus a persistent particle
pool integrated one lattice-Δt per call: `spawn_particles(count)`, `advect_particles(dt)`,
positions/speeds readable via zero-copy pointers. This is the substrate for particles
(F014) and smoke tracers (F016).

## Context

ABI shapes are fixed in `ARCHITECTURE.md` §5 — particles live in Rust (pool with
fixed capacity from `init_sim`), compacted active-first, with a parallel `speeds`
buffer so JS never computes magnitudes. Sampling outside the domain returns the
inlet velocity for x<0 and zero elsewhere; inside solids returns zero.

## Detailed spec

1. **`wasm/src/advection.rs`**:
   ```rust
   pub fn sample_velocity(state, x: f32, y: f32, z: f32) -> [f32; 3]
   pub fn sample_velocity_batch(state, points: &[f32], out: &mut [f32])  // n×3 in, n×3 out
   pub fn advect(state, dt: f32)   // integrates the whole pool one substep
   ```
   - Trilinear interpolation over the 8 surrounding cell macroscopic velocities
     (macroscopic computed on demand — no caching this feature). Fractional lattice
     coords (domain space, i.e. cell centers at integer+0.5 — define precisely:
     **sample coordinate convention: cell (i,j,k) occupies [i, i+1); its velocity is
     located at its center (i+0.5, j+0.5, k+05)** — document this in the module).
   - Bounds: `x < 0` → `(u_inlet, 0, 0)`; `x ≥ nx` or outside y/z → `(0,0,0)`;
     inside solid cell → `(0,0,0)`. Interpolation weight of solid cells contributes
     zero velocity (not clamped) — document.
2. **`wasm/src/particles.rs`** — the pool:
   ```rust
   pub struct ParticlePool {
     capacity: usize,
     pos: Vec<f32>,        // capacity × 3, active-first compaction
     vel: Vec<f32>,        // capacity × 3, last sampled velocity (staged)
     speed: Vec<f32>,      // capacity, |vel| after each advect
     alive: usize,
   }
   ```
   - `spawn_particles(count)`: clears pool; distributes `count` points on the inlet
     plane region `x ∈ [0.5, 2.5]`, uniform-jittered grid over the full y/z interior,
     deterministic RNG (`std` has none — implement a small xorshift64 with a fixed
     seed constant; no rand crate). Points inside solids (possible for tall models)
     are skipped and re-seeded elsewhere; alive count ≤ capacity.
   - `advect_particles(dt)`: for each alive particle: `v = sample_velocity(p)`;
     `p += v·dt` (RK1 — v1; document). Kill (mark dead, compact swap-with-last) when:
     `p.x > nx`, `p` outside y/z interior by > 1, or sampled cell is solid, or speed
     < 1e-4 for 30 consecutive steps (trapped; maintain a per-particle counter in a
     `stall: Vec<u8>` buffer). Speeds buffer updated each call. `active_particle_count()`
     reflects compaction. No allocation per call.
   - Particles killed simply disappear from the active set (F014 recycles by calling
     a top-up: `spawn_particles` is destructive-clear, so additionally expose
     `respawn(n) -> u32` which refills up to n *new* particles appended to the pool
     if capacity allows, returning how many were added — F014 calls it each frame).
3. **ABI additions** (per §5): `spawn_particles(count)`, `respawn(n) -> u32`,
   `advect_particles(dt_lattice)`, `particles_ptr() -> *const f32`,
   `speeds_ptr() -> *const f32`, `active_particle_count() -> u32`,
   `sample_velocity_batch(points, out)`.
4. **Pointer stability contract**: pool buffers are allocated once in `init_sim`
   (capacity from there) and never reallocated — pointers stay valid until the next
   `init_sim` (stricter than the §5 general rule; document in lib.rs).
5. **JS**: no UI yet. `voxelBridge` (F006) gains a temporary `runSmokeProbe()` used
   by a temporary Controls-rail button: resets flow, spawns 2 000 particles, steps
   60× with advect, returns `active_particle_count` and mean speed — displayed in the
   button label. Deleted in F019 (like F003's probe).

## Files to create / modify

```
wasm/src/advection.rs      (new)    — trilinear sampling (batch + single)
wasm/src/particles.rs      (new)    — pool, spawn/respawn/advect
wasm/src/lib.rs            (modify) — ABI additions above
src/lib/sim/voxelBridge.ts (modify) — TEMPORARY runSmokeProbe (deleted in F019)
src/components/controls/SmokeProbe.tsx (new, TEMPORARY) — probe button, deleted in F019
src/app/page.tsx           (modify) — mount probe
```

## Dependencies added

- none

## Interface contract

- ABI exactly as `ARCHITECTURE.md` §5 lists it (`respawn` is an addition — update §5
  in the same commit).
- `sample_velocity_batch` semantics: `points.len() == out.len()`, both n×3; panics
  are forbidden — mismatched lengths return without writing.
- Sampling convention (cell-centered) documented in `advection.rs` header — F016
  depends on it.
- All particle buffers: active-first, `alive` compacted on kill via swap-with-last.

## Acceptance criteria

- [x] `sample_at_cell_center_exact`: uniform flow field → sample at any cell center
      returns (u_inlet,0,0) ± 1e-6.
- [x] `sample_trilinear_interpolates`: constructed linear shear field (u varying
      linearly in y across two cells) → sample at fractional y reproduces the linear
      profile ± 1e-5 (test derives expected by hand).
- [x] `sample_in_solid_is_zero` / `sample_upstream_is_inlet` / `sample_downstream_is_zero`.
- [x] `particles_transit_domain`: 1 000 particles, uniform field u=0.1, dt=1, 100
      advect calls → `active_particle_count() == 0` (all exited +X) and no NaNs ever
      written (positions buffer checked over the run).
- [x] `particles_deflect_around_cube`: cube case (F008), 2 000 particles, 200 steps
      → ≥ 60 % reach x > 0.8·nx without having entered a solid (spot-check: no
      particle position inside occupancy=1 at kill time), and their mean path y/z
      spread increased (deflection proxy).
- [x] `trapped_particles_die`: particle seeded in a recirculation pocket (behind
      cube at the wake centerline) is gone after ~200 steps (stall counter works).
- [x] `respawn_refills`: after mass exit, `respawn(500)` adds up to 500 (capacity
      permitting) and count returns accordingly.
- [x] `no_allocation_in_advect`: review assertion + test running 1 000 advects on
      16³ grid completes in < 50 ms release (catches accidental allocs via timing
      heuristic).

## Test plan

- Rust unit tests in `advection.rs`/`particles.rs` per criteria; the shear-field
  test builds a synthetic `f` field directly (helper writing equilibria with a
  prescribed linear profile).
- Manual: temporary probe button shows a plausible active count (≈ initial − exited)
  after clicking, twice in a row (deterministic).

## Out of scope

- Rendering particles (F014), smoke history (F016), RK2/RK4 integration, exact
  bounce-off-surface reflection (particles die instead — documented v1 behavior),
  GPU particles.
