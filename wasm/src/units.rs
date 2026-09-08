//! Physical ↔ lattice unit conversions (F009).
//!
//! Pure math module: user-facing SI parameters (wind speed, air pressure,
//! dynamic viscosity, domain/characteristic lengths) become lattice-Boltzmann
//! parameters (`u_lattice`, `τ`, `Δt`, `Δx`) and back. No `wasm_bindgen`, no
//! `SimState`, no allocation — fully unit-testable. The thin ABI export
//! (`set_conditions`) lives in `lib.rs`.
//!
//! Formulas are ARCHITECTURE.md §4. Three deliberate resolutions of spec-text
//! conflicts are recorded in `.agents/docs/DECISIONS.md` (2026-09-08) and
//! summarized where they bite below:
//! - `u_lattice` starts from ARCHITECTURE's 0.05–0.15 anchors (linear in U),
//!   not the spec's printed `min(0.10, …)` formula.
//! - `LatticeParams` carries `rho_phys`: the specified
//!   `pressure_lattice_to_pa(ρ_rel, &LatticeParams)` signature leaves no other
//!   place for the ρ_phys its formula requires.
//! - On clamp-loop non-convergence the *starting* u is returned (τ clamped,
//!   `unstable: true`); with real air this is the normal outcome, not an
//!   exception (τ_direct ≈ 0.50003 at defaults vs the 0.505 floor).

/// Specific gas constant of dry air [J/(kg·K)] (ARCHITECTURE §4).
pub const R_SPECIFIC: f64 = 287.05;
/// Fixed air temperature [K] = 20 °C (F009: not a user input).
pub const TEMPERATURE_K: f64 = 293.15;
/// Lattice speed of sound squared, D3Q19 (ARCHITECTURE §3).
pub const CS2: f64 = 1.0 / 3.0;
/// Stability envelope for τ (ARCHITECTURE §3).
pub const TAU_MIN: f64 = 0.505;
pub const TAU_MAX: f64 = 0.95;
/// Hard ceiling for the lattice velocity (ARCHITECTURE §3).
pub const U_LATTICE_MAX: f64 = 0.15;
/// Floor for the *starting* lattice velocity (spec §2; a guard only — the
/// anchor interpolation never reaches it for finite U > 0).
pub const U_LATTICE_START_MIN: f64 = 0.03;
/// Max clamp-loop iterations (spec §2).
pub const CLAMP_ITERATIONS: u32 = 8;

/// User-facing physical conditions (SI units).
#[derive(Clone, Copy, Debug)]
pub struct PhysicalConditions {
    /// Wind speed [m/s], UI range 1–60.
    pub u_mps: f64,
    /// Static air pressure [kPa], UI range 50–110.
    pub pressure_kpa: f64,
    /// Dynamic viscosity [Pa·s], UI range 0.5–3.0 ×10⁻⁵.
    pub viscosity_pas: f64,
    /// Physical domain length [m] (JS constant, default 1.0).
    pub domain_length_m: f64,
    /// Obstacle bbox longest side [m] (default 0.25; feeds Re only).
    pub char_length_m: f64,
}

/// Lattice parameters derived from [`PhysicalConditions`] (plus the air
/// density they were derived with, see [`pressure_lattice_to_pa`]).
#[derive(Clone, Copy, Debug)]
pub struct LatticeParams {
    /// Lattice inlet velocity (x-direction), ≤ 0.15.
    pub u_lattice: f64,
    /// BGK relaxation time, in [0.505, 0.95] unless [`Self::zeroed`].
    pub tau: f64,
    /// Physical timestep [s].
    pub dt: f64,
    /// Physical cell size [m].
    pub dx_phys: f64,
    /// Reynolds number Re = U·L_char/ν.
    pub re: f64,
    /// Air density [kg/m³] used for the conversion.
    pub rho_phys: f64,
    /// True when the τ clamp loop did not converge (or the input was
    /// degenerate). τ/u are still best-effort clamped values.
    pub unstable: bool,
}

impl LatticeParams {
    /// Zeroed params for degenerate input (spec: NaN → `unstable: true`).
    pub fn zeroed() -> Self {
        Self {
            u_lattice: 0.0,
            tau: 0.0,
            dt: 0.0,
            dx_phys: 0.0,
            re: 0.0,
            rho_phys: 0.0,
            unstable: true,
        }
    }
}

/// Air density ρ = P/(R·T) [kg/m³]; `pressure_kpa` in kPa (×1000 → Pa).
pub fn air_density(pressure_kpa: f64) -> f64 {
    pressure_kpa * 1000.0 / (R_SPECIFIC * TEMPERATURE_K)
}

/// Kinematic viscosity ν = μ/ρ [m²/s].
pub fn kinematic_viscosity(pressure_kpa: f64, mu: f64) -> f64 {
    mu / air_density(pressure_kpa)
}

/// (τ, Δt) for a candidate lattice velocity at the given spacing.
fn candidate_tau_dt(nu: f64, u_lattice: f64, dx_phys: f64, u_mps: f64) -> (f64, f64) {
    let dt = u_lattice * dx_phys / u_mps;
    let nu_lattice = nu * dt / (dx_phys * dx_phys);
    (nu_lattice / CS2 + 0.5, dt)
}

/// Full conversion (ARCHITECTURE §4, concretized by the spec §2).
///
/// Start `u_lattice` interpolates the §4 anchors 0.05 @ 1 m/s → 0.15 @
/// 60 m/s (the UI range ends), clamped to [0.03, 0.15]. The clamp loop then
/// halves `u_lattice` while τ > 0.95 and scales it ×1.5 while τ < 0.505 (at
/// most 8 iterations); on success the converged triple is returned with
/// `unstable: false`, otherwise the *starting* u with τ clamped into the
/// envelope and `unstable: true` (see module docs + DECISIONS.md).
///
/// Degenerate input (any non-finite value, non-positive U/P/μ/L, negative
/// characteristic length, or `nx == 0`) yields [`LatticeParams::zeroed`] —
/// never a panic, never a NaN output.
pub fn lattice_params(c: &PhysicalConditions, nx: usize) -> LatticeParams {
    let inputs_ok = c.u_mps.is_finite()
        && c.pressure_kpa.is_finite()
        && c.viscosity_pas.is_finite()
        && c.domain_length_m.is_finite()
        && c.char_length_m.is_finite()
        && c.u_mps > 0.0
        && c.pressure_kpa > 0.0
        && c.viscosity_pas > 0.0
        && c.domain_length_m > 0.0
        && c.char_length_m >= 0.0
        && nx > 0;
    if !inputs_ok {
        return LatticeParams::zeroed();
    }
    let rho = air_density(c.pressure_kpa);
    let nu = kinematic_viscosity(c.pressure_kpa, c.viscosity_pas);
    let dx = c.domain_length_m / nx as f64;
    let u_start = (0.05 + (c.u_mps - 1.0) * (0.10 / 59.0)).clamp(U_LATTICE_START_MIN, U_LATTICE_MAX);
    let re = c.u_mps * c.char_length_m / nu;

    let mut u = u_start;
    for _ in 0..CLAMP_ITERATIONS {
        let (tau, dt) = candidate_tau_dt(nu, u, dx, c.u_mps);
        if tau > TAU_MAX {
            u *= 0.5;
        } else if tau < TAU_MIN {
            u *= 1.5;
        } else {
            return LatticeParams {
                u_lattice: u,
                tau,
                dt,
                dx_phys: dx,
                re,
                rho_phys: rho,
                unstable: false,
            };
        }
    }
    let dt = u_start * dx / c.u_mps;
    let (tau_restored, _) = candidate_tau_dt(nu, u_start, dx, c.u_mps);
    LatticeParams {
        u_lattice: u_start,
        tau: tau_restored.clamp(TAU_MIN, TAU_MAX),
        dt,
        dx_phys: dx,
        re,
        rho_phys: rho,
        unstable: true,
    }
}

/// Lattice relative density → physical pressure [Pa] (signed):
/// `p = c_s² · ρ_lattice_rel · ρ_phys · c_phys²` with `c_phys = Δx/Δt` and
/// `ρ_lattice_rel = ρ_lattice − 1`. Consumed by F012/F013. Degenerate params
/// (Δt = 0, non-finite) yield 0.0, never NaN.
#[allow(dead_code)] // consumed by F012 (`refresh_vertex_pressure`) — kept warning-free until then
pub fn pressure_lattice_to_pa(rho_lattice_rel: f64, p: &LatticeParams) -> f64 {
    if !rho_lattice_rel.is_finite()
        || !p.dt.is_finite()
        || !p.dx_phys.is_finite()
        || !p.rho_phys.is_finite()
        || p.dt == 0.0
    {
        return 0.0;
    }
    let c_phys = p.dx_phys / p.dt;
    CS2 * rho_lattice_rel * p.rho_phys * c_phys * c_phys
}

/// Lattice speed → m/s (`u_lat · Δx/Δt`). Degenerate params yield 0.0.
#[allow(dead_code)] // consumed by F011 (particle advection) — kept warning-free until then
pub fn velocity_lattice_to_mps(u_lat: f64, p: &LatticeParams) -> f64 {
    if !u_lat.is_finite() || !p.dt.is_finite() || !p.dx_phys.is_finite() || p.dt == 0.0 {
        return 0.0;
    }
    u_lat * p.dx_phys / p.dt
}

/// m/s → lattice speed (`v · Δt/Δx`). Degenerate params yield 0.0.
#[allow(dead_code)] // consumed by F011 (particle seeding) — kept warning-free until then
pub fn speed_mps_to_lattice(v_mps: f64, p: &LatticeParams) -> f64 {
    if !v_mps.is_finite() || !p.dt.is_finite() || !p.dx_phys.is_finite() || p.dx_phys == 0.0 {
        return 0.0;
    }
    v_mps * p.dt / p.dx_phys
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_conditions() -> PhysicalConditions {
        PhysicalConditions {
            u_mps: 15.0,
            pressure_kpa: 101.325,
            viscosity_pas: 1.81e-5,
            domain_length_m: 1.0,
            char_length_m: 0.25,
        }
    }

    /// 101.325 kPa → 1.2041 ± 0.0005 kg/m³.
    /// Hand derivation: ρ = 101325 / (287.05 × 293.15) = 101325 / 84148.7075
    /// = 1.2041183….
    #[test]
    fn air_density_at_sea_level() {
        let rho = air_density(101.325);
        assert!(
            (rho - 1.2041).abs() < 0.0005,
            "sea-level density out of bracket: {rho}"
        );
    }

    /// μ = 1.81e-5, P = 101.325 kPa → ν = 1.5031745431e-5 (hand derivation:
    /// 1.81e-5 / 1.2041183164). NOTE — spec-text deviation, see DECISIONS.md
    /// 2026-09-08 §4a: the spec prints 1.5057e-5 ± 1e-9, which matches
    /// μ ≈ 1.813e-5, not the stated μ = 1.81e-5 (off by 2.5e-8). The true
    /// value is asserted here; the second assertion pins the mismatch so a
    /// future edit to the printed (wrong) literal fails loudly.
    #[test]
    fn kinematic_viscosity_default_air() {
        let nu = kinematic_viscosity(101.325, 1.81e-5);
        assert!(
            (nu - 1.5031745431e-5).abs() < 1e-9,
            "kinematic viscosity mismatch: {nu:e}"
        );
        assert!(
            (nu - 1.5057e-5).abs() > 1e-9,
            "spec's printed 1.5057e-5 unexpectedly matches; see DECISIONS.md"
        );
    }

    /// U = 15, defaults, nx = 128.
    /// Hand derivation: u_start = 0.05 + 14 × 0.10/59 = 0.0737288136;
    /// Δx = 1/128 = 0.0078125 (exact); Δt = u·Δx/U = 3.8400423729e-05;
    /// §4 direct τ = 3νΔt/Δx² + 0.5 = 0.5000283718 < 0.505, so the ×1.5 loop
    /// cannot converge in 8 iterations (needs ~176×; see DECISIONS.md):
    /// u is restored to the start value, τ clamps to the envelope floor
    /// 0.505, and `unstable` is true. The spec's `unstable: false`
    /// expectation is unachievable with real air physics at this resolution
    /// (criterion left unticked); envelope membership, the u ceiling, and the
    /// hand-computed triple are asserted instead.
    #[test]
    fn default_conditions_produce_stable_params() {
        let p = lattice_params(&default_conditions(), 128);
        assert!(
            (p.u_lattice - 0.07372881355932204).abs() < 1e-12,
            "u_lattice mismatch: {}",
            p.u_lattice
        );
        assert_eq!(p.dx_phys, 0.0078125);
        assert!(
            (p.dt - 3.8400423729e-5).abs() < 1e-12,
            "dt mismatch: {:e}",
            p.dt
        );
        assert_eq!(p.tau, 0.505, "tau not clamped to the envelope floor");
        assert!(
            (TAU_MIN..=TAU_MAX).contains(&p.tau),
            "tau outside envelope: {}",
            p.tau
        );
        assert!(p.u_lattice <= U_LATTICE_MAX);
        assert!(p.unstable, "expected unstable=true; see DECISIONS.md");
    }

    /// U = 60 m/s. With physical air viscosities τ − 0.5 ≤ ~6e-6 over the
    /// whole UI envelope, so the τ > 0.95 premise never occurs there; the
    /// halving branch is exercised with a finite non-physical μ = 1.0 Pa·s
    /// (the criterion's "if τ would exceed 0.95" is conditional and does not
    /// fix μ). Hand derivation: ρ = 1.2041183164, ν = 1/ρ = 0.83048284;
    /// u_start = 0.15 (clamped); direct τ = 1.2972638460 > 0.95 → halve to
    /// u = 0.075 (exact) → τ = 0.8986319230 ∈ [0.505, 0.95], converged.
    #[test]
    fn high_speed_clamps_to_envelope() {
        let c = PhysicalConditions {
            u_mps: 60.0,
            pressure_kpa: 101.325,
            viscosity_pas: 1.0,
            domain_length_m: 1.0,
            char_length_m: 0.25,
        };
        let p = lattice_params(&c, 128);
        assert!(
            (p.u_lattice - 0.075).abs() < 1e-12,
            "u not halved: {}",
            p.u_lattice
        );
        assert!(p.u_lattice < 0.15, "u_lattice not reduced");
        assert!(
            (p.tau - 0.8986319230).abs() < 1e-6,
            "tau mismatch: {}",
            p.tau
        );
        assert!(p.tau <= TAU_MAX);
        assert!(!p.unstable, "clamp loop should have converged");

        // Physical-μ reality check at U = 60: direct τ ≈ 0.5000051, so the
        // low-side loop exhausts → start u restored, τ clamped, unstable.
        let c_phys = PhysicalConditions {
            u_mps: 60.0,
            ..default_conditions()
        };
        let q = lattice_params(&c_phys, 128);
        assert!((q.u_lattice - 0.15).abs() < 1e-12);
        assert_eq!(q.tau, TAU_MIN);
        assert!(q.unstable);
    }

    /// P = 50 kPa, U = 60, μ = 0.5e-5: direct τ ≈ 0.50000808 (ρ = 0.59418619,
    /// ν = 8.4148761e-6) → low-side loop exhausts → `unstable: true`, never a
    /// panic, τ best-effort clamped into [0.505, 0.95].
    #[test]
    fn extreme_pressure_unstable_flag() {
        let c = PhysicalConditions {
            u_mps: 60.0,
            pressure_kpa: 50.0,
            viscosity_pas: 0.5e-5,
            domain_length_m: 1.0,
            char_length_m: 0.25,
        };
        let p = lattice_params(&c, 128);
        assert!(p.unstable, "expected unstable=true at the envelope corner");
        assert!(
            (TAU_MIN..=TAU_MAX).contains(&p.tau),
            "tau outside envelope: {}",
            p.tau
        );
        assert!(p.u_lattice.is_finite() && p.dt.is_finite() && p.re.is_finite());
    }

    /// char_length 0.25 m, U = 15, defaults → Re = 15×0.25/1.5031745431e-5
    /// = 249472.0269 ≈ 2.49e5 (±1% bracket holds with 0.19% margin).
    #[test]
    fn reynolds_sphere_15ms() {
        let p = lattice_params(&default_conditions(), 128);
        assert!(
            (p.re - 249472.0269).abs() / 249472.0269 < 1e-9,
            "Re mismatch: {}",
            p.re
        );
        assert!(
            (p.re - 2.49e5).abs() / 2.49e5 < 0.01,
            "Re outside the 2.49e5 ± 1% bracket: {}",
            p.re
        );
    }

    /// ρ_lattice_rel = 0.01 at default params → 166.7 ± 1 Pa.
    /// Arithmetic: restored u = 0.0737288136 gives c_phys = Δx/Δt = U/u =
    /// 15/0.0737288136 = 203.4482759; p = (1/3) × 0.01 × 1.2041183164 ×
    /// 203.4482759² = 166.1330107. The spec's 166.7 print used rounded
    /// intermediates (0.57 Pa off, inside tolerance; see DECISIONS.md §4b).
    #[test]
    fn pressure_conversion_round_trip() {
        let p = lattice_params(&default_conditions(), 128);
        let pa = pressure_lattice_to_pa(0.01, &p);
        assert!(
            (pa - 166.1330107).abs() < 1e-6,
            "pressure conversion mismatch: {pa}"
        );
        assert!(
            (pa - 166.7).abs() < 1.0,
            "pressure outside the 166.7 ± 1 Pa bracket: {pa}"
        );
    }

    /// speed_mps_to_lattice ∘ velocity_lattice_to_mps = identity ± 1e-9
    /// relative, for 20 sample speeds across the UI range.
    #[test]
    fn velocity_round_trip() {
        let p = lattice_params(&default_conditions(), 128);
        for i in 0..20 {
            let v = 0.5 + i as f64 * 3.0;
            let back = velocity_lattice_to_mps(speed_mps_to_lattice(v, &p), &p);
            assert!(
                ((back - v) / v).abs() < 1e-9,
                "round trip failed at v={v}: got {back}"
            );
        }
    }

    /// Contract: NaN inputs → `unstable: true` with zeroed params; every other
    /// degenerate-but-finite input is panic-free (reaching the assertions is
    /// the no-panic proof).
    #[test]
    fn nan_inputs_yield_unstable_zeroed() {
        let nan_u = PhysicalConditions {
            u_mps: f64::NAN,
            ..default_conditions()
        };
        let p = lattice_params(&nan_u, 128);
        assert!(p.unstable);
        assert_eq!(p.u_lattice, 0.0);
        assert_eq!(p.tau, 0.0);
        assert_eq!(p.dt, 0.0);
        assert_eq!(p.dx_phys, 0.0);
        assert_eq!(p.re, 0.0);
        assert_eq!(p.rho_phys, 0.0);

        let inf_p = PhysicalConditions {
            pressure_kpa: f64::INFINITY,
            ..default_conditions()
        };
        assert!(lattice_params(&inf_p, 128).unstable);
        let neg_u = PhysicalConditions {
            u_mps: -5.0,
            ..default_conditions()
        };
        assert!(lattice_params(&neg_u, 128).unstable);
        assert!(lattice_params(&default_conditions(), 0).unstable);
    }
}
