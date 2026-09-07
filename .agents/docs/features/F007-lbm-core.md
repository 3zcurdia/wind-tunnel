# F007 — LBM D3Q19 core step

## Metadata

| Field | Value |
|-------|-------|
| ID | F007 |
| Phase | 2 |
| Size | M |
| Skill fit | `Rust` |
| Depends on | F003, F006 (SimState exists) |
| Status | `[x]` done |

## Goal

The lattice Boltzmann core: D3Q19 distributions with BGK collision and pull-streaming,
plus `step(n)` and `reset_flow()` on the ABI. Unit tests prove mass conservation and
rest-state stability. Obstacles are (for now) skipped by the streamer — F008 adds
bounce-back; this feature establishes the correct, allocation-free timestep kernel.

## Context

Reference literature: Krüger et al., *The Lattice Boltzmann Method* (2017), ch. 3–4;
any D3Q19 BGK formulation. Velocity set indexing convention (fix these constants in
one place — `lbm.rs`): directions `e[i]` for `i = 0..19`, rest = 0, axis faces ±x ±y
±z = 1..6, edge centers = 7..18 with weights `w = {1/3, 1/18×6, 1/36×12}`.
`c_s² = 1/3`. Memory layout: **SoA** — `f` stored as 19 planes of `nx·ny·nz` f32;
two buffers `f` and `f_next`, swapped per step. All arrays allocated once in
`init_sim` (extend F006's `SimState`).

## Detailed spec

1. **State extension** (`SimState` gains):
   ```rust
   f: Vec<f32>,          // 19 * cells
   f_next: Vec<f32>,     // 19 * cells
   tau: f64,             // relaxation time, default 0.56
   u_inlet: f64,         // lattice inlet velocity (x-direction), default 0.05
   steps: u64,
   ```
   `reset_flow()`: `f` filled with equilibrium at `ρ=1`, `u=(u_inlet,0,0)`;
   `f_next` zeroed; `steps = 0`.
2. **`wasm/src/lbm.rs`** — pure algorithm functions (no wasm_bindgen):
   - `equilibrium(rho, ux, uy, uz, i) -> f64` — standard D3Q19 Maxwellian:
     `w[i]·ρ·(1 + 3 e·u + 4.5 (e·u)² − 1.5 u²)`.
   - `macroscopic(f, cell) -> (rho, ux, uy, uz)` — sums over 19.
   - `collide(state, cell)` — BGK: `f[i] += (f_eq[i] − f[i]) / τ` computed into
     `f_next` (collide+stream fused, see below).
   - `stream_and_collide(state)` — pull scheme: for every fluid cell, for each i,
     `f_next[i][cell] = post_collision(f[i][cell − e[i]])`. Implementation order:
     (a) compute post-collision values into `f_next` in-place-safe way: first pass
     writes `f[i][c] − (f[i][c] − feq)/τ` into `f_next[i][c]` for all cells (collision
     only), then (b) stream reads `f_next` and writes `f` shifted by `−e[i]` — i.e.
     the "collide-then-swap-stream" two-pass form. The exact scheme is implementer's
     choice **provided** it is allocation-free and passes the tests; document the
     chosen scheme in a module doc comment with its conservation argument.
   - Solid cells: copied through untouched this feature (`f_next = f` at solids).
   - `step(n)` in `lib.rs`: loops `stream_and_collide`, swaps buffers, increments
     `steps`. No allocation inside the loop (enforced by test with allocator hook or
     code review).
3. **ABI additions**: `step(n: u32)`, `reset_flow()`, `steps_done() -> u64`
   (diagnostic), `set_lattice_params(u_lattice: f64, tau: f64)` (F009 drives it;
   clamps inputs to §3 stability limits — clamped values returned via
   `get_lattice_params()` for verification).
4. **Performance guardrails** (from `ARCHITECTURE.md` §7): at 128×48×48, one step ≤
   4 ms on a mid-range CPU (M-series / Ryzen 5-class). Use contiguous inner loops
   (x fastest), bounds-check only outer loops, prefer slice iteration. If exceeding,
   note actual numbers in `DECISIONS.md` — do not add threads (wasm-bindgen sync ABI
   is single-threaded in v1).
5. **Boundary policy this feature**: domain edges use **periodic wrap** in x, y, z
   (simplest fully-conserving choice for kernel tests). F008 replaces x-periodicity
   with inlet/outlet and y/z with free-slip; keep the periodic path behind a
   `#[cfg(test)]`-visible function for the conservation tests.

## Files to create / modify

```
wasm/src/lbm.rs              (new)    — velocity set, equilibrium, collide, stream
wasm/src/lib.rs              (modify) — SimState fields, step/reset_flow/steps_done/
                                       set_lattice_params/get_lattice_params
```

## Dependencies added

- none (tests use std; no rand)

## Interface contract

- ABI: `step(n)`, `reset_flow()`, `steps_done() -> u64`,
  `set_lattice_params(u_lattice, tau)` (clamped: u≤0.15, τ∈[0.505, 0.95]),
  `get_lattice_params() -> {u_lattice, tau}` (plain object via wasm-bindgen).
- `lbm.rs` internals are private to the crate; only `lib.rs` touches `wasm_bindgen`.
- `step` must not allocate; `stream_and_collide` must not allocate per call.

## Acceptance criteria

- [x] `rest_state_is_invariant`: uniform ρ=1, u=0, τ=1.0 → after 100 steps,
      max |ρ−1| < 1e-6, |u| < 1e-6.
- [x] `mass_is_conserved_periodic`: sum(ρ) over grid changes < 1e-4 relative over
      100 steps with u_inlet=0.05, τ=0.56 (periodic variant).
- [x] `uniform_flow_is_steady`: ρ=1, u=(0.05,0,0) everywhere, no obstacle → after
      50 steps, max |u_x − 0.05| < 1e-4 (equilibrium flows stay put).
- [x] `gailei_insertion_creates_flow`: place a small solid block, u_inlet=0.08,
      500 steps → downstream cells show u_x < 0.05 (wake exists), upstream shows
      u_x > 0.05 (blockage), no NaN.
- [x] `clamping_rejects_bad_params`: `set_lattice_params(0.5, 1.5)` → stored values
      are 0.15 and 0.95.
- [x] `no_nan_in_sanity_run`: 2 000 steps at defaults → `is_stable()` placeholder
      may not exist yet; assert `rho.all(|r| r.is_finite() && r > 0)` in-test.
- [x] Perf: `cargo test --release bench_note` (manual timing in test, not CI-gated)
      logs ms/step at 128×48×48; record number in `DECISIONS.md` (target ≤ 4 ms).

## Test plan

- Rust unit tests as listed above, in `lbm.rs` `#[cfg(test)]`, using a helper that
  builds a small grid (e.g. 16×8×8) in-process without wasm-bindgen (make `SimState`
  constructible in tests via `#[cfg(test)] fn new_test(nx,ny,nz)`).
- Tolerances are the acceptance numbers — do not loosen them; if a scheme choice
  can't meet one, document why in `DECISIONS.md` and pick the meeting scheme.
- Manual: `wasm-pack build` succeeds; `WasmProbe` still works (no regression).

## Out of scope

- Real inlet/outlet/wall BCs and obstacle bounce-back (F008 — the wake test here
  uses periodic wrap + solid cells treated as copy-through, which is temporary).
- Units conversion (F009), stability monitor + adaptive stepping (F010),
  sampling/advection (F011).
- D3Q27, MRT/TRT collision, multi-threading, SoA→AoS micro-tuning beyond the budget.
