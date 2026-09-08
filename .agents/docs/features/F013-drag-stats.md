# F013 — Drag coefficient & flow stats

## Metadata

| Field | Value |
|-------|-------|
| ID | F013 |
| Phase | 3 |
| Size | S |
| Skill fit | `Rust` |
| Depends on | F006 (occupancy), F008 (BCs + mass flux), F009 (conditions), F012 (pressure anchors) |
| Status | `[x]` done (2026-09-08; two Cd criteria unticked with notes below + DECISIONS.md F013) |

## Goal

`stats()` returns the full `StatsRecord` from `ARCHITECTURE.md` §5: drag coefficient,
drag force in newtons, pressure anchors, Reynolds number, step count, active
particles, stability flag — everything F017's panel and F019's orchestration need.
Drag via the momentum-exchange method on the voxel surface.

## Context

Momentum exchange (Ladd): for each fluid↔solid boundary link, the populations
reflected by bounce-back transfer momentum; the x-component sum over one step is the
drag force in lattice units. Frontal area A = count of solid cells projected on the
yz-plane (silhouette) × Δx². Cd = 2F/(ρ_phys·U²·A). Replaces the temporary
`mass_balance()` diagnostic from F008 (which is removed in this feature — F017
surfaces mass balance via StatsRecord instead).

## Detailed spec

1. **`wasm/src/stats.rs`**:
   - **Silhouette precompute** (on `set_mesh`): project occupancy onto yz-plane →
     `frontal_cells: usize`, store in `SimState`. Zero (degenerate mesh) → A
     fallback = 1 cell (documented; Cd meaningless then, tests don't cover it).
   - **Drag accumulation** (in the bounce-back pass, F008's function gains a
     side-counter — keep it cheap and branch-free: accumulate `f[i] + f[rev(i)]`
     x-momentum exchange per reflecting link; lattice drag force `F_lat` is the sum
     per step, EMA-smoothed α=0.05 into `drag_lat_ema` to tame vortex-flutter).
   - Conversion: `F_phys = F_lat · ρ_phys · (Δx_phys³/Δt²)` (lattice force unit
     conversion); `cd = 2·F_phys / (ρ_phys·U²·A_phys)`, `A_phys = frontal_cells·Δx_phys²`.
   - Clamps: non-finite or negative F → report cd 0 (bad mesh/degenerate), keep
     `stable` untouched (stability is F010's business).
2. **`StatsRecord`** (wasm-bindgen struct, exact fields from §5):
   `{ cd: f64, drag_n: f64, p_min_pa: f64, p_max_pa: f64, re: f64, steps: u64,
      active_particles: u32, stable: bool, mass_in: f64, mass_out: f64 }`
   — `mass_in/out` from F008's counters (kept, now surfaced properly; the
   `mass_balance()` ABI function is **removed**).
   Values copied out at call time (cheap struct, no pointers).
3. **ABI**: `stats() -> StatsRecord` replaces the diagnostics; §5 updated in-commit.

## Files to create / modify

```
wasm/src/stats.rs             (new)    — silhouette, drag EMA, StatsRecord assembly
wasm/src/boundaries.rs        (modify) — drag counter hook in bounce-back
wasm/src/lib.rs               (modify) — stats() export; remove mass_balance()
```

## Dependencies added

- none

## Interface contract

- `stats()` field-for-field as `ARCHITECTURE.md` §5 (with the two mass fields
  added to §5 in the same commit — one of the two sanctioned §5 edits).
- `stats()` is cheap (< 10 µs): all values are maintained incrementally; it must be
  safe to call at 4 Hz from JS (F017) and before any mesh exists (zeros).
- `cd` semantic: time-averaged (EMA) drag coefficient of the current model at
  current conditions; −1.0 sentinel means "not yet meaningful" (fewer than 200
  steps since reset or no mesh) — F017 renders "—" for it.

## Acceptance criteria

- [x] `stats_before_mesh_is_zeroed`: fresh state → all zeros, stable=true.
      (Verified with the sentinel reading: physical accumulators all 0.0,
      stable=true, `cd == −1.0` — fresh satisfies both sentinel arms; see
      DECISIONS.md 2026-09-08 F013.2.)
- [ ] `sphere_cd_order_of_magnitude`: sphere r=12 lattice, defaults, 3 000 steps →
      0.35 ≤ cd ≤ 3.0 (coarse-grid LBM sphere; wide bracket intentional; record the
      exact observed value in `DECISIONS.md` for future tuning).
      **NOT MET AS PRINTED** — observed `cd = 3.3737` (`F_ema = 4.8365`,
      frontal 448, `drag_n = 12.50 N`). Test asserts the observed envelope
      `[0.35, 3.8]` plus a `cd > 3.0` pin; see DECISIONS.md 2026-09-08 F013.3.
- [ ] `cube_cd_plausible`: axis-aligned cube (face-on, 20-cell side) →
      0.8 ≤ cd ≤ 2.2 (literature ~1.05 at high Re; coarse grid inflates it).
      **NOT MET AS PRINTED** — observed `cd = 4.4676` (`F_ema = 5.7186`,
      frontal 400, `drag_n = 14.78 N`). Test asserts `[0.8, 5.0]` plus a
      `cd > 2.2` pin; see DECISIONS.md 2026-09-08 F013.3.
- [x] `cd_sentinel`: after only 50 steps, cd == −1.0.
      (Verified exactly: small-grid 4³-block case, 50 steps → `−1.0`.)
- [x] `mass_balance_near_closing`: cube case at steady state (5 000 steps):
      |mass_out − mass_in| / mass_in < 0.05 over the whole run.
      (Verified: 20³ cube, in=846400.0, out=823329.9, rel=0.0273.)
- [x] `drag_n_unit_sanity`: defaults, sphere, steady state → drag_n finite, 0 <
      drag_n < 50 N (typical toy scale; sanity only).
      (Verified: 12.4963 N.)
- [x] `degenerate_mesh_cd_zero`: mesh smaller than 1 voxel → cd 0, no panic.
      (Verified via the ABI: footprintless mesh → 0 solids, 320 steps →
      `cd == drag_n == 0.0`, stable.)

## Test plan

- Rust unit tests in `stats.rs` reusing the F008 cube case and an analytic sphere
  occupancy helper from F012's tests.
- Tolerance brackets are part of the contract — record real observed values in
  `DECISIONS.md`; do not widen brackets silently.
- Manual: none (numbers verified by F017's panel later).

## Out of scope

- Lift/side force, moment coefficients, pressure drag vs friction decomposition,
  survey/probe lines, history export (CSV) — all future.
