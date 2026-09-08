# F009 — Physical ↔ lattice units mapping

## Metadata

| Field | Value |
|-------|-------|
| ID | F009 |
| Phase | 2 |
| Size | S |
| Skill fit | `logic` |
| Depends on | F003 (ABI exists); consumed by F010/F012/F013/F018 |
| Status | `[x]` done (2026-09-08; two criteria unticked with notes below + DECISIONS.md) |

## Goal

A pure, fully-tested conversion module: user-facing physical parameters (wind speed
m/s, air pressure kPa, viscosity Pa·s) become lattice parameters (u_lattice, τ, Δt,
Δx) and back. Includes clamping that guarantees the solver's stability envelope is
never violated, and the Reynolds number for display.

## Context

The formulas and clamp limits are fixed in `ARCHITECTURE.md` §3/§4 — implement them
exactly. This module is pure math with no wasm_bindgen and no state; `lib.rs` exposes
`set_conditions(...)` per the ABI. Air at defaults (101.325 kPa, 20 °C) →
ρ ≈ 1.2041 kg/m³, ν ≈ 1.5057×10⁻⁵ m²/s — your tests must reproduce these to 4
significant digits.

## Detailed spec

1. **`wasm/src/units.rs`**:
   ```rust
   pub struct PhysicalConditions { pub u_mps: f64, pub pressure_kpa: f64,
                                   pub viscosity_pas: f64, pub domain_length_m: f64,
                                   pub char_length_m: f64 }
   pub struct LatticeParams { pub u_lattice: f64, pub tau: f64, pub dt: f64,
                              pub dx_phys: f64, pub re: f64, pub unstable: bool }
   pub fn air_density(pressure_kpa: f64) -> f64          // ρ = P/(R·T), R=287.05, T=293.15
   pub fn kinematic_viscosity(pressure_kpa: f64, mu: f64) -> f64
   pub fn lattice_params(c: &PhysicalConditions, nx: usize) -> LatticeParams
   pub fn pressure_lattice_to_pa(rho_lattice_rel: f64, p: &LatticeParams) -> f64
   pub fn velocity_lattice_to_mps(u_lat: f64, p: &LatticeParams) -> f64
   pub fn speed_mps_to_lattice(v_mps: f64, p: &LatticeParams) -> f64
   ```
2. **`lattice_params` algorithm** (from ARCHITECTURE §4, concretized):
   - `Δx_phys = domain_length_m / nx`.
   - Target `u_lattice`: start at `min(0.10, max(0.03, u_mps / 60.0 × 0.10 + 0.03))`
     — i.e. gentle scaling from 0.03 at 1 m/s to 0.13 at 60 m/s (linear interpolation
     between those anchors); this keeps low-speed runs informative and high-speed
     runs stable.
   - `dt = u_lattice · Δx_phys / u_mps`.
   - `ν_lattice = ν · dt / Δx_phys²`; `τ = ν_lattice / (1/3) + 0.5`.
   - Clamp loop (max 8 iterations): while `τ > 0.95`, halve `u_lattice` and recompute
     (smaller u → smaller dt → smaller ν_lattice → smaller τ); while `τ < 0.505`,
     raise `u_lattice` by ×1.5 and recompute. If after 8 iterations still outside →
     return best-effort clamped values with `unstable: true`.
   - `re = u_mps · char_length_m / ν`.
   - `char_length_m` is supplied by JS (model bbox longest side in meters — F005's
     normalization scale × domain length; F018 wires it; default 0.25 m).
3. **`pressure_lattice_to_pa`**: `p_rel = (1/3)·ρ_lattice_rel · ρ_phys · c_phys²`
   where `c_phys = Δx_phys/dt`, `ρ_lattice_rel = ρ_lattice − 1`. Return p_rel in Pa
   (signed). F012/F013 consume this.
4. **ABI**: `set_conditions(u_mps, pressure_kpa, viscosity_pas, domain_length_m,
   char_length_m) -> LatticeParams` (wasm-bindgen struct export) — stores params in
   `SimState` (τ, u_inlet via the F007 setters), returns them. Domain length default
   1.0 m is JS's responsibility (F018 UI constant).
5. **Consistency**: units conversions round-trip within float tolerance
   (`speed_mps_to_lattice` ∘ `velocity_lattice_to_mps` = identity ± 1e-9 relative).

## Files to create / modify

```
wasm/src/units.rs     (new)    — all functions above
wasm/src/lib.rs       (modify) — set_conditions export + SimState param storage
```

## Dependencies added

- none

## Interface contract

- ABI `set_conditions(...) -> LatticeParams` exactly as `ARCHITECTURE.md` §5
  (update §5 in the same commit if field names drift).
- `units.rs` is pure: no `SimState`, no wasm_bindgen, fully unit-testable.
- Callers may call `set_conditions` before or after `set_mesh`; it must never panic
  on any finite input (NaN inputs → `unstable: true` with zeroed params).

## Acceptance criteria

- [x] `air_density_at_sea_level`: 101.325 kPa → 1.2041 ± 0.0005 kg/m³.
      (Verified: 1.2041183.)
- [ ] `kinematic_viscosity_default_air`: μ=1.81e-5, P=101.325 kPa → ν = 1.5057e-5
      ± 1e-9. **NOT MET AS PRINTED** — true value for the stated inputs is
      ν = 1.5031745e-5 (off by 2.5e-8; the print matches μ≈1.813e-5). Test
      asserts the true literal; see DECISIONS.md 2026-09-08 §4a.
- [ ] `default_conditions_produce_stable_params`: U=15, defaults, nx=128 → τ ∈
      [0.505, 0.95], u_lattice ≤ 0.15, unstable=false, and τ matches the manual
      computation of the §4 formulas within 1e-6 (test contains the explicit
      expected numbers, computed by hand and written into the test).
      **PARTIALLY MET** — τ = 0.505 ∈ envelope ✓, u = 0.0737288 ≤ 0.15 ✓,
      hand-computed dt/dx/Re literals match ✓, but `unstable` is **true**:
      §4 direct τ ≈ 0.500028 can never reach the 0.505 floor within 8 ×1.5
      iterations for real air (see DECISIONS.md 2026-09-08 §2).
- [x] `high_speed_clamps_to_envelope`: U=60 m/s, if τ would exceed 0.95 → result
      τ ≤ 0.95, u_lattice reduced, unstable=false when the clamp loop converged.
      (Verified via μ = 1.0 Pa·s at U = 60, which the conditional permits:
      τ 1.297 → 0.8986, u 0.15 → 0.075, unstable=false; plus a physical-μ
      U = 60 case documenting the low-side outcome.)
- [x] `extreme_pressure_unstable_flag`: P=50 kPa with u=60, μ=0.5e-5 → either
      converges or returns `unstable=true`; never panics; τ within [0.505, 0.95].
      (Verified: unstable=true, τ = 0.505.)
- [x] `reynolds_sphere_15ms`: char_length 0.25 m, U=15, defaults →
      Re = 15×0.25/1.5057e-5 ≈ 2.49e5 ± 1%. (Verified: Re = 249472.03.)
- [x] `pressure_conversion_round_trip`: p_rel → Pa at default params for
      ρ_lattice_rel = 0.01 → 166.7 Pa ± 1 Pa (show the arithmetic in a comment).
      (Verified: 166.133 Pa; arithmetic in `units.rs` test comment. Requires the
      ARCHITECTURE-anchor u — the spec's printed u-formula gives 298.5 Pa;
      see DECISIONS.md 2026-09-08 §1.)
- [x] `velocity_round_trip`: identity within 1e-9 relative for 20 sample speeds.

## Test plan

- Rust unit tests in `units.rs` exactly as the criteria above (write the hand-computed
  expected values as literals with their derivation in comments).
- Manual: none (pure module).

## Out of scope

- UI sliders (F018), auto-throttling of a running sim (F019 calls set_conditions and
  reacts), temperature as a user input (fixed 293.15 K), humidity.
