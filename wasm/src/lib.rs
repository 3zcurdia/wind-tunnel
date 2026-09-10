use std::cell::RefCell;
use wasm_bindgen::prelude::*;

mod advection;
mod boundaries;
#[cfg(test)]
mod bench;
mod lbm;
mod particles;
mod pressure;
mod stats;
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
/// `stable` / `last_unstable_step` are the F010 latched stability monitor
/// (set by the collide pass, cleared only by `reset_state_flow`);
/// `last_step_ms` / `avg_step_ms` are the F010 per-batch timing signals.
/// `particles` is the F011 fixed-capacity pool (buffers allocated once in
/// `init_sim`, never reallocated — pointers stay valid until the next
/// `init_sim`, stricter than the §5 general rule).
/// `vertex_cell` / `vertex_pressure` are the F012 per-vertex pressure mapping
/// (allocated once in `set_mesh`, index-written by `pressure::refresh` —
/// never reallocated, so `vertex_pressure_ptr()` is stable until the next
/// `set_mesh` / `init_sim`); `rho_mean` is the running mean lattice density
/// (EMA, α = 0.01); `p_min_pa` / `p_max_pa` / `q_ref_pa` are the F015 legend
/// anchors.
/// `frontal_cells` / `drag_lat_ema` are the F013 drag substrate: the yz
/// silhouette cell count (recomputed once per `set_mesh`) and the
/// EMA-smoothed (α = 0.05) per-step lattice drag force from the bounce-back
/// momentum-exchange hook (see `stats.rs` + `boundaries.rs`).
pub struct SimState {
    pub(crate) nx: usize,
    pub(crate) ny: usize,
    pub(crate) nz: usize,
    pub(crate) occupancy: Vec<u8>,
    pub(crate) solid_count: usize,
    pub(crate) mesh_vertices: Vec<f32>,
    pub(crate) vertex_count: usize,
    pub(crate) surface_mode: bool,
    /// Fixed-capacity particle pool (F011). Allocated in `fresh` from the
    /// `init_sim` capacity argument; `spawn`/`respawn`/`advect` only write
    /// within it.
    pub(crate) particles: particles::ParticlePool,
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
    // ── F010 step driver: stability latch + batch timing ────────────────
    /// Latched stability flag: false once the collide pass observes ρ ≤ 0
    /// or a non-finite moment on its strided check; cleared only by reset.
    pub(crate) stable: bool,
    /// Completed-step count when the latch first tripped (0-based index of
    /// the failing step).
    pub(crate) last_unstable_step: u64,
    /// Mean wall ms per lattice step of the last `step(n)` batch.
    pub(crate) last_step_ms: f32,
    /// EMA (α = 0.1) of `last_step_ms` across `step(n)` calls, for F019.
    pub(crate) avg_step_ms: f32,
    // ── F012 surface pressure ────────────────────────────────────────
    /// Per-vertex nearest-fluid-cell mapping (`-1` = unmapped), built once
    /// in `set_mesh` (see `pressure::build_mapping`).
    pub(crate) vertex_cell: Vec<i32>,
    /// Per-vertex relative pressure [Pa] (same order/length as
    /// `mesh_vertices`), refreshed once per `step(n)` batch.
    pub(crate) vertex_pressure: Vec<f32>,
    /// Running mean lattice density (EMA, α = 0.01, over the domain mean).
    pub(crate) rho_mean: f64,
    /// Min / max vertex pressure [Pa] (relative to `rho_mean`, seeded with
    /// 0 so `p_min ≤ 0 ≤ p_max` holds structurally).
    pub(crate) p_min_pa: f64,
    pub(crate) p_max_pa: f64,
    /// Stagnation reference `½·ρ·U²` [Pa] (zero with no mesh).
    pub(crate) q_ref_pa: f64,
    // ── F013 drag & stats ────────────────────────────────────────────
    /// Silhouette cell count (yz-projection of the occupancy grid),
    /// recomputed once per `set_mesh` (see `stats::frontal_cells`).
    pub(crate) frontal_cells: usize,
    /// EMA-smoothed (α = 0.05) per-step lattice drag force from the
    /// bounce-back momentum-exchange hook (see `stats.rs`).
    pub(crate) drag_lat_ema: f64,
    // ── Precomputed obstacle boundary links (perf, see `boundaries.rs`) ──
    /// Cell indices of every fluid cell with at least one in-bounds solid
    /// neighbour, in the canonical `z → y → x` scan order. Parallel to
    /// [`Self::boundary_masks`]; rebuilt only when `occupancy` changes
    /// (`boundaries::rebuild_boundary_links`), never per step. Empty when the
    /// grid holds no solids — the fresh / cleared-mesh default.
    pub(crate) boundary_cells: Vec<u32>,
    /// Per-entry bitmask of the directions `i ∈ 1..19` whose neighbour
    /// `c + e[i]` is in-bounds **and** solid (bit `i` set). Same length and
    /// order as [`Self::boundary_cells`]; every mask is non-zero.
    pub(crate) boundary_masks: Vec<u32>,
    /// Cell count (`nx·ny·nz`) the link list was built for. The per-step
    /// bounce-back compares it against the live grid size and degrades to a
    /// no-op on a mismatch (a stale list can only mean a missed rebuild hook).
    pub(crate) boundary_grid_len: usize,
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
            particles: particles::ParticlePool::new(0),
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
            stable: true,
            last_unstable_step: 0,
            last_step_ms: 0.0,
            avg_step_ms: 0.0,
            vertex_cell: Vec::new(),
            vertex_pressure: Vec::new(),
            rho_mean: 1.0,
            p_min_pa: 0.0,
            p_max_pa: 0.0,
            q_ref_pa: 0.0,
            frontal_cells: 0,
            drag_lat_ema: 0.0,
            boundary_cells: Vec::new(),
            boundary_masks: Vec::new(),
            boundary_grid_len: 0,
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
            particles: particles::ParticlePool::new(particle_capacity),
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
            stable: true,
            last_unstable_step: 0,
            last_step_ms: 0.0,
            avg_step_ms: 0.0,
            vertex_cell: Vec::new(),
            vertex_pressure: Vec::new(),
            rho_mean: 1.0,
            p_min_pa: 0.0,
            p_max_pa: 0.0,
            q_ref_pa: 0.0,
            frontal_cells: 0,
            drag_lat_ema: 0.0,
            boundary_cells: Vec::new(),
            boundary_masks: Vec::new(),
            boundary_grid_len: 0,
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
/// Returns the solid cell count plus the F022 pathological-cap skip count.
/// Replaces any previous mesh.
/// Malformed input (empty, or length % 9 != 0) returns a zeroed result and
/// leaves the previous state untouched — no panics.
///
/// F007: newly-solid cells are frozen to rest equilibrium (and newly-fluid
/// cells back to inlet equilibrium) so a fresh obstacle immediately disturbs
/// the flow; the rest of the field is left untouched (no full reset).
///
/// F022: the return changed from a bare `u32` solid count to
/// [`SetMeshResult`] (`{ solidCount, skippedTriangles }` in JS — the
/// secondary channel reporting how many triangles tripped the pathological
/// swept-range cap). ARCHITECTURE.md §5 updated in the same commit.
#[wasm_bindgen]
pub struct SetMeshResult {
    pub(crate) solid_count: u32,
    pub(crate) skipped_triangles: u32,
}

#[wasm_bindgen]
impl SetMeshResult {
    /// Number of solid cells (surface + interior, or shell-only in fallback).
    #[allow(non_snake_case)]
    #[wasm_bindgen(getter)]
    pub fn solidCount(&self) -> u32 {
        self.solid_count
    }
    /// Triangles skipped by the pathological swept-range cap (F022 §2).
    #[allow(non_snake_case)]
    #[wasm_bindgen(getter)]
    pub fn skippedTriangles(&self) -> u32 {
        self.skipped_triangles
    }
}

#[wasm_bindgen]
pub fn set_mesh(triangles: &[f32]) -> SetMeshResult {
    let zeroed = || SetMeshResult {
        solid_count: 0,
        skipped_triangles: 0,
    };
    if triangles.is_empty() || triangles.len() % 9 != 0 {
        return zeroed();
    }
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        if state.nx == 0 || state.ny == 0 || state.nz == 0 || state.occupancy.is_empty() {
            return zeroed();
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
        // F012: (re)build the vertex→fluid mapping for the new occupancy,
        // allocate the pressure buffer, and drop stale pressures/anchors.
        // (Borrow the inputs first — NLL ends the shared borrows before the
        // exclusive assignments below.)
        let mapping = pressure::build_mapping(
            state.nx,
            state.ny,
            state.nz,
            &state.occupancy,
            &state.mesh_vertices,
        );
        state.vertex_cell = mapping;
        state.vertex_pressure = vec![0.0f32; state.vertex_count];
        pressure::on_new_mesh(&mut state);
        // F013: silhouette + drag-average restart for the new geometry.
        stats::on_new_mesh(&mut state);
        lbm::retune_solid_cells(&mut state, &to_fluid);
        SetMeshResult {
            solid_count: state.solid_count as u32,
            skipped_triangles: res.skipped_triangles as u32,
        }
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
        // F012: no mesh ⇒ zeroed pressure state (the `empty_mesh_safe`
        // contract — `pressure_anchors()` reads all zeros).
        pressure::on_mesh_cleared(&mut state);
        // F013: no mesh ⇒ zero silhouette + zero drag.
        stats::on_mesh_cleared(&mut state);
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
/// Mass-flux accumulators are zeroed. F012 pressures return to the uniform
/// zero baseline (`ρ̄` back to 1). Never panics, even on an empty domain.
#[wasm_bindgen]
pub fn reset_flow() {
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        lbm::reset_state_flow(&mut state);
        pressure::on_flow_reset(&mut state);
        stats::on_flow_reset(&mut state);
    });
}

/// Advance exactly `n` lattice timesteps with the F008 wind-tunnel BC set
/// (inlet / outlet / free-slip walls / obstacle bounce-back).
/// `n` is clamped to ≤ 64 per call (F010 — defends against runaway loops;
/// JS must respect this). No allocation inside the loop. Never panics.
///
/// F010: each call records batch timing (see [`timing`]) and the collide pass
/// latches `stable = false` on the first ρ ≤ 0 / non-finite observation
/// (strided check, every 7th cell). Steps still execute while unstable —
/// F019 stops calling `step` on instability.
#[wasm_bindgen]
pub fn step(n: u32) {
    let n = n.min(64);
    if n == 0 {
        return;
    }
    let t0 = batch_start();
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        for _ in 0..n {
            lbm::stream_and_collide(&mut state);
            state.steps = state.steps.wrapping_add(1);
        }
        // F012: one pressure refresh per step(n) batch (never per substep).
        // Index writes only — no allocation inside the stepping path.
        pressure::refresh(&mut state);
    });
    // Mean ms per lattice step within this batch. `.max(0.0)` also maps a
    // hypothetical non-finite clock read to 0 instead of poisoning the EMA.
    let per_step_ms = (batch_elapsed_ms(&t0) / f64::from(n)).max(0.0);
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        state.last_step_ms = per_step_ms as f32;
        state.avg_step_ms += (state.last_step_ms - state.avg_step_ms) * 0.1;
    });
}

/// Stability check (F010, cheap field read): false once the collide pass has
/// observed ρ ≤ 0 or a non-finite moment since the last `reset_flow` /
/// `init_sim`. Reporting never resets the latch — only `reset_flow()` does.
/// Never panics.
#[wasm_bindgen]
pub fn is_stable() -> bool {
    STATE.with(|s| s.borrow().stable)
}

/// Batch timing snapshot for F019's adaptive steps-per-frame loop.
#[wasm_bindgen]
pub struct Timing {
    pub(crate) last_step_ms: f32,
    pub(crate) avg_step_ms: f32,
}

#[wasm_bindgen]
impl Timing {
    /// Mean wall ms per lattice step of the last `step(n)` batch.
    #[wasm_bindgen(getter)]
    pub fn last_step_ms(&self) -> f32 {
        self.last_step_ms
    }
    /// EMA (α = 0.1) of `last_step_ms` across `step(n)` calls.
    #[wasm_bindgen(getter)]
    pub fn avg_step_ms(&self) -> f32 {
        self.avg_step_ms
    }
}

/// Last-batch timing snapshot (F010). Cheap enough to poll per frame; F019
/// consumes it for adaptive steps-per-frame. Never panics.
#[wasm_bindgen]
pub fn timing() -> Timing {
    STATE.with(|s| {
        let state = s.borrow();
        Timing {
            last_step_ms: state.last_step_ms,
            avg_step_ms: state.avg_step_ms,
        }
    })
}

// ── F010: cross-platform batch clock ────────────────────────────────────
// Native (unit tests, benches): `std::time::Instant` — monotonic, ns
// resolution. wasm32-unknown-unknown: std's clock traps at runtime
// (`unreachable`, verified 2026-09-08 with a wasm-pack/Node probe — the
// spec's "verified in F003's toolchain" assumption was wrong; F003 only ever
// called a trivial string probe), so the browser path imports the monotonic
// `performance.now()` host function through the existing `wasm-bindgen`
// dependency instead: no new crates (the spec's Dependencies say "none", and
// `wasm/Cargo.toml` is outside this feature's file list), and monotonicity
// makes it strictly better than the spec's `Date.now()` fallback sketch for
// measuring durations. Both arms expose milliseconds as f64; see
// DECISIONS.md 2026-09-08 (F010).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;
}

/// Opaque start stamp for one `step(n)` batch.
#[cfg(not(target_arch = "wasm32"))]
type BatchClock = std::time::Instant;
/// Opaque start stamp for one `step(n)` batch (ms, `performance.now()`).
#[cfg(target_arch = "wasm32")]
type BatchClock = f64;

#[cfg(not(target_arch = "wasm32"))]
fn batch_start() -> BatchClock {
    std::time::Instant::now()
}

#[cfg(target_arch = "wasm32")]
fn batch_start() -> BatchClock {
    // Plain call (no `unsafe`): wasm-bindgen generates a safe wrapper for
    // this pure host import. `performance.now` exists in every browser, the
    // app's only runtime (ARCHITECTURE.md §1).
    performance_now()
}

#[cfg(not(target_arch = "wasm32"))]
fn batch_elapsed_ms(t0: &BatchClock) -> f64 {
    t0.elapsed().as_secs_f64() * 1000.0
}

#[cfg(target_arch = "wasm32")]
fn batch_elapsed_ms(t0: &BatchClock) -> f64 {
    // Same safe wasm-bindgen import as `batch_start` above.
    performance_now() - *t0
}

/// Completed timesteps since the last `reset_flow` / `init_sim`.
#[wasm_bindgen]
pub fn steps_done() -> u64 {
    STATE.with(|s| s.borrow().steps)
}

// ── F013: drag coefficient & flow stats ─────────────────────────────────
// The F008 `mass_balance()` diagnostic is gone (replaced by the `mass_in` /
// `mass_out` fields below); the accumulators themselves (`mass_in_flux` /
// `mass_out_flux` in `boundaries.rs`) are kept and surfaced here.

/// Aggregated flow stats (ARCHITECTURE.md §5): time-averaged drag
/// coefficient + drag force, F012 pressure anchors, Reynolds number, step
/// count, live particle count, stability latch, and cumulative inlet/outlet
/// mass fluxes. All values are maintained incrementally — this copies them
/// out (cheap struct, no pointers), safe at ~4 Hz from JS and before any
/// mesh exists. Never panics.
#[wasm_bindgen]
pub struct StatsRecord {
    pub(crate) cd: f64,
    pub(crate) drag_n: f64,
    pub(crate) p_min_pa: f64,
    pub(crate) p_max_pa: f64,
    pub(crate) re: f64,
    pub(crate) steps: u64,
    pub(crate) active_particles: u32,
    pub(crate) stable: bool,
    pub(crate) mass_in: f64,
    pub(crate) mass_out: f64,
}

#[wasm_bindgen]
impl StatsRecord {
    /// Time-averaged drag coefficient, or −1.0 ("not yet meaningful": fewer
    /// than 200 steps since reset or no mesh — F017 renders "—").
    #[wasm_bindgen(getter)]
    pub fn cd(&self) -> f64 {
        self.cd
    }
    /// Drag force [N] from the EMA lattice force (0 with no obstacle).
    #[wasm_bindgen(getter)]
    pub fn drag_n(&self) -> f64 {
        self.drag_n
    }
    /// Minimum vertex pressure [Pa] (≤ 0 by construction; 0 with no mesh).
    #[wasm_bindgen(getter)]
    pub fn p_min_pa(&self) -> f64 {
        self.p_min_pa
    }
    /// Maximum vertex pressure [Pa] (≥ 0 by construction; 0 with no mesh).
    #[wasm_bindgen(getter)]
    pub fn p_max_pa(&self) -> f64 {
        self.p_max_pa
    }
    /// Reynolds number from the last `set_conditions` (0 until it runs).
    #[wasm_bindgen(getter)]
    pub fn re(&self) -> f64 {
        self.re
    }
    /// Completed timesteps since the last `reset_flow` / `init_sim`.
    #[wasm_bindgen(getter)]
    pub fn steps(&self) -> u64 {
        self.steps
    }
    /// Number of currently alive particles.
    #[wasm_bindgen(getter)]
    pub fn active_particles(&self) -> u32 {
        self.active_particles
    }
    /// Latched stability flag (F010; `reset_flow` clears it).
    #[wasm_bindgen(getter)]
    pub fn stable(&self) -> bool {
        self.stable
    }
    /// Accumulated inlet mass flux since reset (lattice units).
    #[wasm_bindgen(getter)]
    pub fn mass_in(&self) -> f64 {
        self.mass_in
    }
    /// Accumulated measured outlet mass flux since reset (lattice units).
    #[wasm_bindgen(getter)]
    pub fn mass_out(&self) -> f64 {
        self.mass_out
    }
}

/// Current stats snapshot (see [`StatsRecord`]). Never panics.
#[wasm_bindgen]
pub fn stats() -> StatsRecord {
    STATE.with(|s| {
        let state = s.borrow();
        StatsRecord {
            cd: stats::drag_coefficient(&state),
            drag_n: stats::drag_force_physical(&state),
            p_min_pa: state.p_min_pa,
            p_max_pa: state.p_max_pa,
            re: state.re,
            steps: state.steps,
            active_particles: state.particles.alive() as u32,
            stable: state.stable,
            mass_in: state.mass_in_flux,
            mass_out: state.mass_out_flux,
        }
    })
}

// ── F011: velocity sampling & particle advection ABI ────────────────────
// Pool buffers are allocated once in `init_sim` and never reallocated, so
// `particles_ptr` / `speeds_ptr` stay valid until the next `init_sim`
// (stricter than the §5 general rule). `reset_flow` leaves the pool
// untouched; `set_mesh`/`clear_mesh` leave it too (particles caught inside
// fresh solids die on the next `advect_particles`).

/// Batch velocity sampling: `points` holds `n×3` domain-space coords, `out`
/// receives `n×3` velocities (trilinear, see `advection.rs` for the
/// convention). Mismatched lengths write nothing. Never panics.
#[wasm_bindgen]
pub fn sample_velocity_batch(points: &[f32], out: &mut [f32]) {
    STATE.with(|s| {
        advection::sample_velocity_batch(&s.borrow(), points, out);
    });
}

/// (Re)seed `count` particles at the inlet plane. Clears the pool first
/// (deterministic cloud — same seed every call). `alive` never exceeds the
/// `init_sim` capacity. Never panics.
#[wasm_bindgen]
pub fn spawn_particles(count: u32) {
    STATE.with(|s| {
        particles::spawn(&mut s.borrow_mut(), count);
    });
}

/// Append up to `n` new inlet particles without clearing; returns how many
/// were added (0 when the pool is full). F014 calls this each frame to
/// recycle. Never panics.
#[wasm_bindgen]
pub fn respawn(n: u32) -> u32 {
    STATE.with(|s| particles::respawn(&mut s.borrow_mut(), n))
}

/// Integrate all alive particles one lattice-Δt substep (RK1). Kills those
/// exiting the domain, entering solids, or trapped (see `particles.rs`).
/// No allocation. Never panics.
#[wasm_bindgen]
pub fn advect_particles(dt_lattice: f32) {
    STATE.with(|s| {
        advection::advect(&mut s.borrow_mut(), dt_lattice);
    });
}

/// Pointer to the particle pool positions (`capacity×3` `f32`, xyz triplets,
/// active-first). Stable until the next `init_sim`. Null when empty.
#[wasm_bindgen]
pub fn particles_ptr() -> *const f32 {
    STATE.with(|s| {
        let state = s.borrow();
        if state.particles.capacity() == 0 {
            std::ptr::null()
        } else {
            state.particles.positions().as_ptr()
        }
    })
}

/// Pointer to the per-particle lattice speeds (`capacity` `f32`, parallel to
/// the positions above, active-first). Same stability rule. Null when empty.
#[wasm_bindgen]
pub fn speeds_ptr() -> *const f32 {
    STATE.with(|s| {
        let state = s.borrow();
        if state.particles.capacity() == 0 {
            std::ptr::null()
        } else {
            state.particles.speeds().as_ptr()
        }
    })
}

/// Number of currently alive (active-first) particles.
#[wasm_bindgen]
pub fn active_particle_count() -> u32 {
    STATE.with(|s| s.borrow().particles.alive() as u32)
}

// ── F012: surface pressure ABI ────────────────────────────────────────
// The pressure buffer is allocated once in `set_mesh` (length
// `vertex_count`, deduped sorted order — see `pressure.rs`) and only
// index-written by `pressure::refresh`, so the pointer below is stable
// until the next `set_mesh` / `init_sim` (the §5 general rule).
// `reset_flow` returns it to the uniform zero baseline; `clear_mesh`
// empties it (length 0).

/// Pointer to the per-vertex relative pressure buffer (`vertex_count` `f32`,
/// [Pa], in stored-vertex order). Stable until the next `set_mesh` /
/// `init_sim`; re-fetch via this function afterwards. Null when empty.
#[wasm_bindgen]
pub fn vertex_pressure_ptr() -> *const f32 {
    STATE.with(|s| {
        let state = s.borrow();
        if state.vertex_pressure.is_empty() {
            std::ptr::null()
        } else {
            state.vertex_pressure.as_ptr()
        }
    })
}

/// Length of the per-vertex pressure buffer (`== vertex_count`).
#[wasm_bindgen]
pub fn vertex_pressure_len() -> u32 {
    STATE.with(|s| s.borrow().vertex_pressure.len() as u32)
}

/// Normalization anchors for F015's legend: min/max vertex pressure [Pa]
/// (relative to the running mean lattice density) plus the stagnation
/// reference `q_ref = ½·ρ·U²` [Pa]. All zeros when no mesh is set.
#[wasm_bindgen]
pub struct PressureAnchors {
    pub(crate) p_min_pa: f64,
    pub(crate) p_max_pa: f64,
    pub(crate) q_ref_pa: f64,
}

#[wasm_bindgen]
impl PressureAnchors {
    /// Minimum vertex pressure [Pa] (≤ 0 by construction).
    #[wasm_bindgen(getter)]
    pub fn p_min_pa(&self) -> f64 {
        self.p_min_pa
    }
    /// Maximum vertex pressure [Pa] (≥ 0 by construction).
    #[wasm_bindgen(getter)]
    pub fn p_max_pa(&self) -> f64 {
        self.p_max_pa
    }
    /// Stagnation reference `½·ρ·U²` [Pa] (0 with no mesh).
    #[wasm_bindgen(getter)]
    pub fn q_ref_pa(&self) -> f64 {
        self.q_ref_pa
    }
}

/// Current pressure anchors (see [`PressureAnchors`]). Cheap enough to poll
/// at legend rate. Never panics.
#[wasm_bindgen]
pub fn pressure_anchors() -> PressureAnchors {
    STATE.with(|s| {
        let state = s.borrow();
        if state.vertex_count == 0 || state.vertex_pressure.is_empty() {
            PressureAnchors {
                p_min_pa: 0.0,
                p_max_pa: 0.0,
                q_ref_pa: 0.0,
            }
        } else {
            PressureAnchors {
                p_min_pa: state.p_min_pa,
                p_max_pa: state.p_max_pa,
                q_ref_pa: state.q_ref_pa,
            }
        }
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
        // 2026-09-08): best-effort start-u values + assist τ + unstable flag
        // (2026-09-09: the 0.505 floor itself diverges, so the fallback runs
        // on TAU_ASSIST instead).
        assert!(p.unstable());
        assert!((p.u_lattice() - 0.07372881355932204).abs() < 1e-12);
        assert_eq!(p.tau(), crate::units::TAU_ASSIST);
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
    /// stays usable for subsequent calls. F022: malformed input yields a
    /// zeroed [`SetMeshResult`] (both channels zero).
    #[test]
    fn malformed_set_mesh_keeps_valid_state() {
        init_sim(16, 16, 16, 100);
        let empty = set_mesh(&[]);
        assert_eq!(empty.solid_count, 0);
        assert_eq!(empty.skipped_triangles, 0);
        let bad_len = set_mesh(&[1.0, 2.0, 3.0, 4.0]);
        assert_eq!(bad_len.solid_count, 0);
        assert_eq!(bad_len.skipped_triangles, 0);
        assert_eq!(occupancy_len(), 16 * 16 * 16);
        assert!(!surface_mode_flag());
        // A subsequent valid call still works (single triangle → shell mode).
        let tri: Vec<f32> = vec![1.0, 1.0, 1.0, 2.0, 1.0, 1.0, 1.0, 2.0, 1.0];
        let ok = set_mesh(&tri);
        assert!(ok.solid_count > 0);
        assert_eq!(ok.skipped_triangles, 0);
        assert!(surface_mode_flag());
        clear_mesh();
        assert_eq!(occupancy_len(), 16 * 16 * 16);
        assert!(STATE.with(|s| s.borrow().occupancy.iter().all(|&c| c == 0)));
    }

    /// F022: an over-swept triangle through the ABI is skipped, counted in
    /// the `skippedTriangles` channel, and never poisons the grid — while a
    /// valid triangle in the same call still voxelizes.
    #[test]
    fn set_mesh_reports_skipped_triangles() {
        init_sim(16, 16, 16, 0);
        let mut tris: Vec<f32> = vec![1.0, 1.0, 1.0, 2.0, 1.0, 1.0, 1.0, 2.0, 1.0];
        tris.extend_from_slice(&[
            -1.0e6, -1.0e6, -1.0e6, 1.0e6, -1.0e6, -1.0e6, -1.0e6, 1.0e6, 1.0e6,
        ]);
        let res = set_mesh(&tris);
        assert_eq!(res.skipped_triangles, 1);
        assert!(res.solid_count > 0, "valid triangle must still voxelize");
        // JS-facing getters agree with the fields.
        assert_eq!(res.solidCount(), res.solid_count);
        assert_eq!(res.skippedTriangles(), res.skipped_triangles);
    }

    // ── F010: step driver, stability & timing ────────────────────────────

    /// Fill an axis-aligned solid box on the thread-local ABI state and freeze
    /// the fresh solids at rest equilibrium (mirrors `set_mesh` retuning,
    /// without touching the flow elsewhere).
    fn place_box_state(
        x0: usize,
        x1: usize,
        y0: usize,
        y1: usize,
        z0: usize,
        z1: usize,
    ) {
        STATE.with(|s| {
            let mut state = s.borrow_mut();
            let (nx, ny) = (state.nx, state.ny);
            for z in z0..z1 {
                for y in y0..y1 {
                    for x in x0..x1 {
                        state.occupancy[x + nx * (y + ny * z)] = 1;
                    }
                }
            }
            state.solid_count = state.occupancy.iter().filter(|&&o| o != 0).count();
            lbm::retune_solid_cells(&mut state, &[]);
        });
    }

    /// Injecting NaN into one distribution latches `is_stable() == false`
    /// within 10 steps; `reset_flow()` clears the latch.
    #[test]
    fn nan_detection_latches() {
        init_sim(16, 8, 8, 0);
        assert!(is_stable(), "fresh sim must report stable");
        // The stride-7 monitor watches cells 0, 7, 14, … — cell 14 (x = 14,
        // interior in x) is observed on the very first collide pass.
        STATE.with(|s| {
            let mut state = s.borrow_mut();
            let n = state.nx * state.ny * state.nz;
            state.f[3 * n + 14] = f32::NAN;
        });
        step(10);
        assert!(
            !is_stable(),
            "NaN injection must latch instability within 10 steps"
        );
        assert!(
            !STATE.with(|s| lbm::verify_stability_full(&s.borrow())),
            "full-grid verification must agree on the NaN field"
        );
        reset_flow();
        assert!(is_stable(), "reset_flow must clear the stability latch");
        assert!(
            STATE.with(|s| lbm::verify_stability_full(&s.borrow())),
            "field must verify healthy after reset_flow"
        );
    }

    /// Forcing ρ = −0.5 in one cell latches instability the same way.
    #[test]
    fn negative_density_detected() {
        init_sim(16, 8, 8, 0);
        assert!(is_stable(), "fresh sim must report stable");
        STATE.with(|s| {
            let mut state = s.borrow_mut();
            let n = state.nx * state.ny * state.nz;
            // Σρ = −0.5 at strided interior cell 7 (7 % 7 == 0); f32 rounding
            // keeps the sum within ~1e-9 of −0.5, still firmly ≤ 0.
            let share = (-0.5f64 / 19.0) as f32;
            for i in 0..19 {
                state.f[i * n + 7] = share;
            }
        });
        step(10);
        assert!(
            !is_stable(),
            "negative density must latch instability within 10 steps"
        );
        reset_flow();
        assert!(is_stable(), "reset_flow must clear the stability latch");
    }

    /// 5 000 steps on the default-grid cube case at default params stay
    /// stable (and advance the step counter exactly).
    #[test]
    fn healthy_run_stays_stable() {
        init_sim(128, 48, 48, 0);
        // 8³ cube at the ARCH §3 placement center (mirrors the F008 fixture).
        let (nx, ny, nz) = (128usize, 48usize, 48usize);
        let cx = (0.35 * nx as f64) as usize;
        let (cy, cz) = (ny / 2, nz / 2);
        place_box_state(cx - 4, cx + 4, cy - 4, cy + 4, cz - 4, cz + 4);
        reset_flow();
        assert!(is_stable(), "fresh cube case must report stable");
        // 78 × 64 + 8 = 5 000 (also exercises the ≤ 64 clamp path per call).
        for _ in 0..78 {
            step(64);
        }
        step(8);
        assert_eq!(steps_done(), 5000, "5000 lattice steps must complete");
        assert!(is_stable(), "healthy 5000-step cube run must stay stable");
        assert!(
            STATE.with(|s| lbm::verify_stability_full(&s.borrow())),
            "full-grid verification must agree on the healthy run"
        );
    }

    /// 2026-09-09 stability assist: real-air `set_conditions` (assist τ)
    /// with a centered obstacle stays stable for 1500 steps on the Low
    /// grid — the production path that latched within ~150 steps at the
    /// 0.505 floor (Re_lat ≈ 120 here vs ≈ 1400 there).
    #[test]
    fn real_air_assist_run_stays_stable() {
        init_sim(64, 24, 24, 0);
        let p = set_conditions(15.0, 101.325, 1.81e-5, 1.0, 0.25);
        assert!(p.unstable(), "real air must flag the assist path");
        assert_eq!(p.tau(), crate::units::TAU_ASSIST);
        // 4³ cube at the ARCH §3 placement center (mirrors the F008 fixture).
        let (nx, ny, nz) = (64usize, 24usize, 24usize);
        let cx = (0.35 * nx as f64) as usize;
        let (cy, cz) = (ny / 2, nz / 2);
        place_box_state(cx - 2, cx + 2, cy - 2, cy + 2, cz - 2, cz + 2);
        reset_flow();
        assert!(is_stable(), "fresh assist-τ cube case must report stable");
        // 23 × 64 + 28 = 1500.
        for _ in 0..23 {
            step(64);
        }
        step(28);
        assert_eq!(steps_done(), 1500, "1500 lattice steps must complete");
        assert!(
            is_stable(),
            "assist-τ 1500-step cube run must stay stable"
        );
        assert!(
            STATE.with(|s| lbm::verify_stability_full(&s.borrow())),
            "full-grid verification must agree on the assist-τ run"
        );
    }

    /// `step(n > 64)` executes exactly 64 steps.
    #[test]
    fn step_clamp() {
        init_sim(16, 16, 16, 0);
        step(1000);
        assert_eq!(steps_done(), 64, "step(1000) must behave as 64 steps");
        step(64);
        assert_eq!(steps_done(), 128, "step(64) passes through unclamped");
        step(0);
        assert_eq!(steps_done(), 128, "step(0) must be a no-op");
        assert!(is_stable(), "small healthy run must stay stable");
    }

    /// After 100 single-step batches the EMA has converged onto the
    /// last-batch reading (sanity: no drift to 0, no stall).
    #[test]
    fn timing_ema_converges() {
        init_sim(16, 8, 8, 0);
        for _ in 0..100 {
            step(1);
        }
        let t = timing();
        assert!(
            t.last_step_ms() > 0.0,
            "last_step_ms must be positive (got {})",
            t.last_step_ms()
        );
        assert!(
            t.avg_step_ms() > 0.0,
            "avg_step_ms must be positive (got {})",
            t.avg_step_ms()
        );
        let ratio = f64::from(t.avg_step_ms()) / f64::from(t.last_step_ms());
        assert!(
            (0.5..=2.0).contains(&ratio),
            "avg_step_ms ({}) must be within 2× of last_step_ms ({})",
            t.avg_step_ms(),
            t.last_step_ms()
        );
    }
}
