# F008 — Boundary conditions (inlet, outlet, walls, obstacles)

## Metadata

| Field | Value |
|-------|-------|
| ID | F008 |
| Phase | 2 |
| Size | M |
| Skill fit | `Rust` |
| Depends on | F006 (occupancy), F007 (step kernel) |
| Status | `[ ]` todo |

## Goal

Replace F007's temporary periodic wrap with wind-tunnel boundary conditions: fixed
velocity inlet at x=0, zero-gradient outlet at x=nx−1, free-slip walls on ±y/±z, and
full-way bounce-back on solid cells. Result: steady flow past the voxelized model
with a visible wake and net mass balance in ≈ out.

## Context

`ARCHITECTURE.md` §3 defines the BC set. Inlet uses **fixed-velocity equilibrium
injection** (robust, slightly over-constrains — fine for a toy). Outlet uses
**zero-gradient (copy from interior neighbor)** — simple and stable for sub-critical
lattice Mach numbers. Free-slip walls: mirror the wall-normal distribution families
(specular reflection). Obstacles: full-way bounce-back (half-way approximation, no
interpolation scheme in v1). Apply BCs **after** streaming each step.

## Detailed spec

1. **`wasm/src/boundaries.rs`** — pure functions over `SimState`:
   - `apply_obstacle_bounce_back(state)`: for each solid cell adjacent to a fluid
     cell, the outgoing populations that would enter the solid are reflected back to
     the source fluid cell with reversed direction: standard full-way formulation —
     for fluid cell `c` and direction `i` pointing into a solid neighbor, after
     streaming set `f_next[ī][c] = f_next[i][c]` where `ī` is the reversed velocity.
     Implementation: after the streaming pass, for every fluid cell, for each `i`,
     if neighbor `c + e[i]` is solid, copy `f_next[i][c]` into `f_next[reverse(i)][c]`.
     (This is the well-known on-node full-way bounce-back applied on the fluid side —
     document the exact implemented variant.)
   - `apply_inlet(state)`: at x=0, for all y,z: set all 19 `f` values to
     `equilibrium(ρ=1, u=(u_inlet, 0, 0))` (overwrite after streaming).
   - `apply_outlet(state)`: at x=nx−1, copy all 19 values from x=nx−2 (zero
     gradient).
   - `apply_walls(state)`: y=0, y=ny−1, z=0, z=nz−1 — specular (free-slip) reflection:
     for distributions with a wall-normal component, mirror the normal component and
     keep tangential ones. The precise D3Q19 mapping table (which i maps to which
     mirrored partner at each wall) must be written as a constant table in the module
     with a comment; derive it from the velocity set, and unit-test it against the
     rule "tangential momentum preserved, normal reversed".
   - Order per step: stream → bounce-back (obstacles) → inlet → outlet → walls.
2. **`step` integration**: F007's step calls the BC pass instead of periodic wrap.
   Keep the periodic variant as `step_periodic` (cfg(test)) for the conservation
   tests, which continue to pass.
3. **Mass-balance instrumentation**: add to `SimState` a `mass_in_flux` and
   `mass_out_flux` accumulation: every `reset_flow()` zeroes them; inlet application
   adds `ρ·u_inlet·(ny−2)(nz−2)` per step; outlet measures actual
   `Σ ρ u_x` over the outlet face per step into `mass_out_flux`. Expose via
   `stats()`-adjacent accessor `mass_balance() -> (f64, f64)` (F013 surfaces it; ABI
   now as a diagnostic `mass_balance() -> Vec<f64>` len 2 — acceptable temporary
   shape, F013 replaces with the full StatsRecord).
4. **Corner cells** (edges/corners where multiple BCs meet): inlet face corners get
   inlet values (inlet wins); outlet face corners get outlet copy; wall-wall and
   wall-outlet corner cells use walls after outlet. Document the precedence:
   **obstacle > inlet > outlet > walls**.
5. **Solid-adjacent streamer fix**: in F007 the streamer copied solids through; now
   streaming must **skip writing into solid cells** (they are mirrors handled by
   bounce-back). Update `stream_and_collide` accordingly (solid cells keep their
   previous values; bounce-back overwrites what's needed).

## Files to create / modify

```
wasm/src/boundaries.rs       (new)    — all four BC families + precedence docs
wasm/src/lbm.rs              (modify) — call BC pass in step; keep step_periodic for tests
wasm/src/lib.rs              (modify) — mass flux fields, mass_balance() diagnostic
```

## Dependencies added

- none

## Interface contract

- `step(n)` behavior is now the full wind-tunnel BC set — no ABI changes beyond
  `mass_balance() -> Vec<f64>` diagnostic (temporary, replaced by F013).
- All BC functions take `&mut SimState` and must not allocate.
- BC precedence order is fixed as above; changing it requires `DECISIONS.md` entry.

## Acceptance criteria

- [ ] `inlet_is_velocity_clamped`: after 100 steps, every x=0 cell has
      |u − (u_inlet,0,0)| < 1e-6.
- [ ] `outlet_is_zero_gradient`: after 100 steps, max |f[i][nx−1] − f[i][nx−2]| over
      i < 1e-9.
- [ ] `free_slip_preserves_tangential_momentum`: initialize a shear-free flow with a
      tangential component near a wall; after 50 steps the wall-adjacent tangential
      velocity differs from its initial value by < 1e-6 (specular property).
- [ ] `no_flow_through_solid`: with the F006 test cube present, after 500 steps the
      mean u_x inside solid-adjacent fluid pointing *into* solids is ~0 by
      construction (bounce-back verified via: total mass Σρ changes < 0.5 % over
      500 steps with BCs on).
- [ ] `wake_exists_downstream_of_cube`: cube at placement center, u_inlet = 0.08,
      τ = 0.56, 1 000 steps → mean u_x in a 8×8×8 box directly behind the cube is
      < 0.6 × u_inlet, and some cells there have |u_y| + |u_z| > 0.005 (flow
      deflection).
- [ ] `steady_state_reached`: 5 000 steps on the cube case → relative change of Σρ
      over the last 1 000 steps < 1e-3.
- [ ] No NaN after 10 000 steps at defaults with the cube.

## Test plan

- Rust unit tests in `boundaries.rs` + integration tests reusing F007's test helper
  grid; the cube case uses the same 128×48×48 default grid (release-mode timing not
  required here).
- Each acceptance criterion is one named test; numerical assertions exactly as
  stated.
- Manual: none (invisible until Phase 4); verify via `cargo test`.

## Out of scope

- Velocity/pressure boundary schemes (Zou–He), interpolated bounce-back, curved
  boundaries (staircase only), turbulence inlet, wind profile variation, moving
  obstacles, adaptive grids.
