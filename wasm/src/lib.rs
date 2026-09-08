use std::cell::RefCell;
use wasm_bindgen::prelude::*;

mod boundaries;
mod lbm;
mod units;
mod voxel;

/// Shared solver/domain state (F006 skeleton; grown by later features).
///
/// `occupancy` is row-major (`idx = x + nx*(y + ny*z)`), `1` = solid.
/// `mesh_vertices` keeps deduplicated domain-space vertex positions for F012.
/// `f` / `f_next` are the D3Q19 SoA populations (F007): 19 planes of
/// `nx*ny*nz` `f32`, two buffers, allocated once in `init_sim`.
/// `mass_in_flux` / `mass_out_flux` accumulate the F008 inlet/outlet mass
/// exchange (lattice units); `reset_flow` zeroes them.
pub struct SimState {
    pub(crate) nx: usize,
    pub(crate) ny: usize,
    pub(crate) nz: usize,
    pub(crate) occupancy: Vec<u8>,
    pub(crate) solid_count: usize,
    pub(crate) mesh_vertices: Vec<f32>,
    pub(crate) vertex_count: usize,
    pub(crate) surface_mode: bool,
    /// Reserved for the F011 particle pool (allocated then).
    #[allow(dead_code)]
    pub(crate) particle_capacity: usize,
    // ── F007 flow state ────────────────────────────────────────────
    /// SoA populations, 19 planes × cells (result always lives in `f`).
    pub(crate) f: Vec<f32>,
    /// Scratch post-collision buffer, same layout as `f`.
    pub(crate) f_next: Vec<f32>,
    /// Relaxation time, default 0.56 (clamped to [0.505, 0.95]).
    pub(crate) tau: f64,
    /// Lattice inlet velocity (x-direction), default 0.05 (clamped ≤ 0.15).
    pub(crate) u_inlet: f64,
    /// Completed timesteps since the last `reset_flow` / `init_sim`.
    pub(crate) steps: u64,
    // ── F008 mass-balance instrumentation ──────────────────────────
    /// Accumulated inlet mass flux since the last `reset_flow`
    /// (`ρ·u_inlet·(ny-2)(nz-2)` per step, ρ = 1).
    pub(crate) mass_in_flux: f64,
    /// Accumulated measured outlet mass flux (`Σ ρ·u_x` over the interior
    /// outlet face per step).
    pub(crate) mass_out_flux: f64,
    // ── F009 physical conditions (last `set_conditions` call) ──────────
    /// Wind speed [m/s] (F012's `q_ref`, F013's conversions).
    pub(crate) u_mps: f64,
    /// Air density [kg/m³].
    pub(crate) rho_phys: f64,
    /// Physical cell size [m] and timestep [s].
    pub(crate) dx_phys: f64,
    pub(crate) dt_phys: f64,
    /// Reynolds number at the last `set_conditions`.
    pub(crate) re: f64,
    /// True when the last conversion did not converge into the τ envelope.
    pub(crate) conditions_unstable: bool,
}

impl SimState {
    fn empty() -> Self {
        Self {
            nx: 0,
            ny: 0,
            nz: 0,
            occupancy: Vec::new(),
            solid_count: 0,
            mesh_vertices: Vec::new(),
            vertex_count: 0,
            surface_mode: false,
            particle_capacity: 0,
            f: Vec::new(),
            f_next: Vec::new(),
            tau: 0.56,
            u_inlet: 0.05,
            steps: 0,
            mass_in_flux: 0.0,
            mass_out_flux: 0.0,
            u_mps: 0.0,
            rho_phys: 0.0,
            dx_phys: 0.0,
            dt_phys: 0.0,
            re: 0.0,
            conditions_unstable: false,
        }
    }

    fn fresh(nx: usize, ny: usize, nz: usize, particle_capacity: usize) -> Self {
        let total = nx.saturating_mul(ny).saturating_mul(nz);
        let planes = 19usize.saturating_mul(total);
        let mut s = Self {
            nx,
            ny,
            nz,
            occupancy: vec![0u8; total],
            solid_count: 0,
            mesh_vertices: Vec::new(),
            vertex_count: 0,
            surface_mode: false,
            particle_capacity,
            f: vec![0.0f32; planes],
            f_next: vec![0.0f32; planes],
            tau: 0.56,
            u_inlet: 0.05,
            steps: 0,
            mass_in_flux: 0.0,
            mass_out_flux: 0.0,
            u_mps: 0.0,
            rho_phys: 0.0,
            dx_phys: 0.0,
            dt_phys: 0.0,
            re: 0.0,
            conditions_unstable: false,
        };
        lbm::reset_state_flow(&mut s);
        s
    }

    /// In-process test constructor (F007 test plan): fresh all-fluid grid
    /// without touching the thread-local ABI state. `#[cfg(test)]` only.
    #[cfg(test)]
    pub(crate) fn new_test(nx: usize, ny: usize, nz: usize) -> Self {
        Self::fresh(nx, ny, nz, 0)
    }
}

thread_local! {
    static STATE: RefCell<SimState> = RefCell::new(SimState::empty());
}

/// Temporary pipeline probe (F003). Removed with F019.
#[wasm_bindgen]
pub fn ping() -> String {
    "pong".to_string()
}

/// Allocate domain & solver state. Safe to call again to rebuild (resets
/// everything). Zero-sized domains yield an empty (valid) state, never a panic.
#[wasm_bindgen]
pub fn init_sim(nx: u32, ny: u32, nz: u32, particle_capacity: u32) {
    let (nx, ny, nz) = (nx as usize, ny as usize, nz as usize);
    STATE.with(|s| {
        *s.borrow_mut() = SimState::fresh(nx, ny, nz, particle_capacity as usize);
    });
}

/// Voxelize a mesh. Triangles are 9 floats each, in DOMAIN space.
/// Returns the number of solid cells. Replaces any previous mesh.
/// Malformed input (empty, or length % 9 != 0) returns 0 and leaves the
/// previous state untouched — no panics.
///
/// F007: newly-solid cells are frozen to rest equilibrium (and newly-fluid
/// cells back to inlet equilibrium) so a fresh obstacle immediately disturbs
/// the flow; the rest of the field is left untouched (no full reset).
#[wasm_bindgen]
pub fn set_mesh(triangles: &[f32]) -> u32 {
    if triangles.is_empty() || triangles.len() % 9 != 0 {
        return 0;
    }
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        if state.nx == 0 || state.ny == 0 || state.nz == 0 || state.occupancy.is_empty() {
            return 0;
        }
        let old = state.occupancy.clone();
        let res = voxel::voxelize(state.nx, state.ny, state.nz, triangles);
        let mut to_fluid = Vec::new();
        if old.len() == res.occupancy.len() {
            for (idx, (&o, &n)) in old.iter().zip(res.occupancy.iter()).enumerate() {
                if o != 0 && n == 0 {
                    to_fluid.push(idx);
                }
            }
        }
        state.occupancy = res.occupancy;
        state.solid_count = res.solid_count;
        state.surface_mode = res.surface_mode;
        state.mesh_vertices = voxel::deduplicate_vertices(triangles);
        state.vertex_count = state.mesh_vertices.len() / 3;
        lbm::retune_solid_cells(&mut state, &to_fluid);
        state.solid_count as u32
    })
}

/// Remove the current mesh; the grid returns to all-fluid.
/// Previously-solid cells are returned to inlet equilibrium (F007).
#[wasm_bindgen]
pub fn clear_mesh() {
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        let mut to_fluid = Vec::new();
        for (idx, &o) in state.occupancy.iter().enumerate() {
            if o != 0 {
                to_fluid.push(idx);
            }
        }
        state.occupancy.fill(0);
        state.solid_count = 0;
        state.mesh_vertices.clear();
        state.vertex_count = 0;
        state.surface_mode = false;
        lbm::retune_solid_cells(&mut state, &to_fluid);
    });
}

/// Pointer to the obstacle grid (1 byte per cell, row-major as §3).
/// Stable only until the next allocation-triggering call (`init_sim`,
/// `set_mesh`); re-fetch via this function afterwards. Null when empty.
#[wasm_bindgen]
pub fn occupancy_ptr() -> *const u8 {
    STATE.with(|s| {
        let state = s.borrow();
        if state.occupancy.is_empty() {
            std::ptr::null()
        } else {
            state.occupancy.as_ptr()
        }
    })
}

/// Length of the obstacle grid in bytes (`nx*ny*nz`).
#[wasm_bindgen]
pub fn occupancy_len() -> u32 {
    STATE.with(|s| s.borrow().occupancy.len() as u32)
}

/// True when the last `set_mesh` fell back to surface-only mode (leaky mesh).
#[wasm_bindgen]
pub fn surface_mode_flag() -> bool {
    STATE.with(|s| s.borrow().surface_mode)
}

// ── F007: LBM core ABI ────────────────────────────────────────────────

// ── F009: physical conditions ABI ───────────────────────────────────────

/// Lattice + physical parameters, returned by [`set_conditions`] and
/// [`get_lattice_params`] (ARCHITECTURE.md §5; `rho_phys` added by F009 —
/// the lattice→Pa conversion needs it — see DECISIONS.md 2026-09-08).
#[wasm_bindgen]
pub struct LatticeParams {
    pub(crate) u_lattice: f64,
    pub(crate) tau: f64,
    pub(crate) dt: f64,
    pub(crate) dx_phys: f64,
    pub(crate) re: f64,
    pub(crate) rho_phys: f64,
    pub(crate) unstable: bool,
}

#[wasm_bindgen]
impl LatticeParams {
    /// Lattice inlet velocity (x-direction).
    #[wasm_bindgen(getter)]
    pub fn u_lattice(&self) -> f64 {
        self.u_lattice
    }
    /// BGK relaxation time.
    #[wasm_bindgen(getter)]
    pub fn tau(&self) -> f64 {
        self.tau
    }
    /// Physical timestep [s].
    #[wasm_bindgen(getter)]
    pub fn dt(&self) -> f64 {
        self.dt
    }
    /// Physical cell size [m].
    #[wasm_bindgen(getter)]
    pub fn dx_phys(&self) -> f64 {
        self.dx_phys
    }
    /// Reynolds number Re = U·L_char/ν.
    #[wasm_bindgen(getter)]
    pub fn re(&self) -> f64 {
        self.re
    }
    /// Air density [kg/m³] used for the conversion.
    #[wasm_bindgen(getter)]
    pub fn rho_phys(&self) -> f64 {
        self.rho_phys
    }
    /// True when the τ clamp loop did not converge into the envelope (with
    /// real air: the normal outcome — see DECISIONS.md 2026-09-08).
    #[wasm_bindgen(getter)]
    pub fn unstable(&self) -> bool {
        self.unstable
    }
}

fn clamp_lattice_params(u_lattice: f64, tau: f64) -> (f64, f64) {
    let u = if !u_lattice.is_finite() {
        0.05
    } else if u_lattice < 0.0 {
        0.0
    } else if u_lattice > 0.15 {
        0.15
    } else {
        u_lattice
    };
    let t = if !tau.is_finite() {
        0.56
    } else if tau < 0.505 {
        0.505
    } else if tau > 0.95 {
        0.95
    } else {
        tau
    };
    (u, t)
}

/// Re-initialize the flow field to uniform inlet conditions (keeps the mesh).
/// Fluid cells → equilibrium at `(1, u_inlet, 0, 0)`, solid cells → rest.
/// Mass-flux accumulators are zeroed. Never panics, even on an empty domain.
#[wasm_bindgen]
pub fn reset_flow() {
    STATE.with(|s| {
        lbm::reset_state_flow(&mut s.borrow_mut());
    });
}

/// Advance exactly `n` lattice timesteps with the F008 wind-tunnel BC set
/// (inlet / outlet / free-slip walls / obstacle bounce-back).
/// No allocation inside the loop. Never panics.
#[wasm_bindgen]
pub fn step(n: u32) {
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        for _ in 0..n {
            lbm::stream_and_collide(&mut state);
            state.steps = state.steps.wrapping_add(1);
        }
    });
}

/// Completed timesteps since the last `reset_flow` / `init_sim`.
#[wasm_bindgen]
pub fn steps_done() -> u64 {
    STATE.with(|s| s.borrow().steps)
}

/// Accumulated inlet/outlet mass flux since the last `reset_flow`, as
/// `[mass_in, mass_out]` (lattice units). Temporary diagnostic shape — F013
/// replaces it with the full `StatsRecord`. Never panics.
#[wasm_bindgen]
pub fn mass_balance() -> Vec<f64> {
    STATE.with(|s| {
        let state = s.borrow();
        vec![state.mass_in_flux, state.mass_out_flux]
    })
}

/// Store lattice parameters, clamped to the §3 stability envelope
/// (`u ≤ 0.15`, `τ ∈ [0.505, 0.95]`; non-finite inputs fall back to defaults).
/// Read back the stored values via [`get_lattice_params`]. Never panics.
#[wasm_bindgen]
pub fn set_lattice_params(u_lattice: f64, tau: f64) {
    let (u, t) = clamp_lattice_params(u_lattice, tau);
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        state.u_inlet = u;
        state.tau = t;
    });
}

/// Currently stored `(u_lattice, tau)` after clamping, plus the physical
/// companions from the last [`set_conditions`] call (`dt`/`dx_phys`/`re`/
/// `rho_phys` are zero until it runs once — F007's u/tau behaviour is
/// unchanged).
#[wasm_bindgen]
pub fn get_lattice_params() -> LatticeParams {
    STATE.with(|s| {
        let state = s.borrow();
        LatticeParams {
            u_lattice: state.u_inlet,
            tau: state.tau,
            dt: state.dt_phys,
            dx_phys: state.dx_phys,
            re: state.re,
            rho_phys: state.rho_phys,
            unstable: state.conditions_unstable,
        }
    })
}

/// Compute lattice parameters from physical inputs (pure math in `units.rs`).
/// Stores τ/u_inlet through F007's envelope clamp plus the physical
/// companions (U, ρ, Δx, Δt, Re, unstable flag) that F012/F013 consume, and
/// returns them. Safe to call before or after `set_mesh` — or before
/// `init_sim` (nx is then 0, so the result is `unstable` + zeroed). Never
/// panics, even for NaN inputs (→ zeroed params with `unstable: true`).
/// Domain length default 1.0 m is JS's responsibility (F018 UI constant).
#[wasm_bindgen]
pub fn set_conditions(
    u_mps: f64,
    pressure_kpa: f64,
    viscosity_pas: f64,
    domain_length_m: f64,
    char_length_m: f64,
) -> LatticeParams {
    let cond = units::PhysicalConditions {
        u_mps,
        pressure_kpa,
        viscosity_pas,
        domain_length_m,
        char_length_m,
    };
    let nx = STATE.with(|s| s.borrow().nx);
    let p = units::lattice_params(&cond, nx);
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        let (u, t) = clamp_lattice_params(p.u_lattice, p.tau);
        state.u_inlet = u;
        state.tau = t;
        state.u_mps = if cond.u_mps.is_finite() { cond.u_mps } else { 0.0 };
        state.rho_phys = p.rho_phys;
        state.dx_phys = p.dx_phys;
        state.dt_phys = p.dt;
        state.re = p.re;
        state.conditions_unstable = p.unstable;
        // Returned u/tau are the stored (envelope-clamped) values, so the
        // return always agrees with a subsequent `get_lattice_params()`.
        LatticeParams {
            u_lattice: u,
            tau: t,
            dt: p.dt,
            dx_phys: p.dx_phys,
            re: p.re,
            rho_phys: p.rho_phys,
            unstable: p.unstable,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `set_conditions` stores (envelope-clamped) params and returns values
    /// agreeing with `get_lattice_params()`; F012/F013 companions are kept.
    #[test]
    fn set_conditions_stores_and_returns_params() {
        init_sim(128, 48, 48, 0);
        let p = set_conditions(15.0, 101.325, 1.81e-5, 1.0, 0.25);
        // Real air never converges into the τ envelope (DECISIONS.md
        // 2026-09-08): best-effort clamped values + unstable flag.
        assert!(p.unstable());
        assert!((p.u_lattice() - 0.07372881355932204).abs() < 1e-12);
        assert_eq!(p.tau(), 0.505);
        assert!((p.rho_phys() - 1.2041183164).abs() < 1e-9);
        let q = get_lattice_params();
        assert_eq!(q.u_lattice(), p.u_lattice());
        assert_eq!(q.tau(), p.tau());
        assert_eq!(q.unstable(), p.unstable());
        STATE.with(|s| {
            let state = s.borrow();
            assert_eq!(state.u_inlet, p.u_lattice());
            assert_eq!(state.tau, p.tau());
            assert_eq!(state.u_mps, 15.0);
            assert_eq!(state.rho_phys, p.rho_phys());
            assert_eq!(state.dx_phys, p.dx_phys());
            assert_eq!(state.dt_phys, p.dt());
            assert_eq!(state.re, p.re());
        });
        // NaN input: zeroed + unstable, no panic, state stays usable.
        let bad = set_conditions(f64::NAN, 101.325, 1.81e-5, 1.0, 0.25);
        assert!(bad.unstable());
        assert_eq!(bad.dt(), 0.0);
        step(1);
        assert_eq!(steps_done(), 1);
    }

    /// `set_mesh` rejects malformed input without panicking and the state
    /// stays usable for subsequent calls.
    #[test]
    fn malformed_set_mesh_keeps_valid_state() {
        init_sim(16, 16, 16, 100);
        assert_eq!(set_mesh(&[]), 0);
        assert_eq!(set_mesh(&[1.0, 2.0, 3.0, 4.0]), 0);
        assert_eq!(occupancy_len(), 16 * 16 * 16);
        assert!(!surface_mode_flag());
        // A subsequent valid call still works (single triangle → shell mode).
        let tri: Vec<f32> = vec![1.0, 1.0, 1.0, 2.0, 1.0, 1.0, 1.0, 2.0, 1.0];
        assert!(set_mesh(&tri) > 0);
        assert!(surface_mode_flag());
        clear_mesh();
        assert_eq!(occupancy_len(), 16 * 16 * 16);
        assert!(STATE.with(|s| s.borrow().occupancy.iter().all(|&c| c == 0)));
    }
}
