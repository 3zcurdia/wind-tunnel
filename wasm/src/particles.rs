//! Fixed-capacity particle pool for streamlines/smoke (F011 substrate).
//!
//! Pool module — intentionally `wasm_bindgen`-free (see CONVENTIONS.md); the
//! ABI (`spawn_particles`, `respawn`, `advect_particles`, `particles_ptr`,
//! `speeds_ptr`, `active_particle_count`) lives in `lib.rs`, and the sampling
//! kernel in `advection.rs`.
//!
//! ## Layout
//!
//! `pos` / `vel` / `speed` / `stall` are preallocated once in `init_sim`
//! (capacity from there) and **never reallocated** — `spawn`/`respawn` only
//! write within capacity, so the `particles_ptr` / `speeds_ptr` views stay
//! valid until the next `init_sim`. Buffers are active-first: kills compact
//! via swap-with-last, and JS must only read the first `alive` entries.
//!
//! ## Spawning
//!
//! `spawn` clears the pool (and reseeds the deterministic xorshift64 RNG, so
//! repeated probes reproduce identical clouds); `respawn` appends with the
//! continuing RNG state. Points land in the inlet slab `x ∈ [0.5, 2.5)` on a
//! uniform-jittered stratified grid over the full `y/z` interior
//! (`[1, ny−1) × [1, nz−1)`; degenerate axes fall back to the full range).
//! Points landing inside solids are re-rolled (up to 8 attempts) and otherwise
//! skipped — `alive` never exceeds `capacity`.
//!
//! ## Advection (RK1, v1 behaviour)
//!
//! Per alive particle: `v = sample(p)`; `p += v·dt`. A particle dies when its
//! new position leaves through `+X` (`p.x > nx`), leaves the `y/z` interior
//! by more than 1 cell, lands in a solid cell, or reports speed `< 1e-4` for
//! 30 consecutive calls (trapped in a recirculation pocket — the `stall`
//! counter resets on any faster sample). Killed particles simply disappear
//! from the active set (F014 tops the pool back up via `respawn`); there is
//! no bounce-off-surface reflection in v1. The `exited_outlet` /
//! `killed_solid` / `killed_stall` / `killed_edge` counters are
//! crate-internal fate diagnostics (reset by `spawn`, cumulative across
//! `respawn`) used by the unit tests below.
//!
//! Steady-state `advect_in` allocates nothing (index loop over preallocated
//! buffers; see `no_allocation_in_advect`).

use crate::SimState;
use crate::advection::{FlowView, sample_in};

/// Fixed RNG seed: every `spawn` reproduces the identical inlet cloud.
const SPAWN_SEED: u64 = 0x9E37_79B9_7F4A_7C15;
/// Speed below which a particle counts as trapped (lattice units / step).
const STALL_SPEED: f32 = 1e-4;
/// Consecutive slow samples before a trapped particle is killed.
const STALL_STEPS: u8 = 30;
/// Solid re-roll attempts per particle before it is skipped.
const SPAWN_RETRIES: u32 = 8;

/// Particle pool state (see module docs). Field order mirrors the F011 spec;
/// `stall` / `rng` / fate counters are documented implementation details.
pub struct ParticlePool {
    capacity: usize,
    pos: Vec<f32>,
    vel: Vec<f32>,
    speed: Vec<f32>,
    alive: usize,
    stall: Vec<u8>,
    rng: u64,
    pub(crate) exited_outlet: u64,
    pub(crate) killed_solid: u64,
    pub(crate) killed_stall: u64,
    pub(crate) killed_edge: u64,
}

impl ParticlePool {
    /// Preallocate all buffers (zeroed, hence finite — an untouched pool
    /// exposes no NaNs). Never reallocates afterwards.
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            capacity,
            pos: vec![0.0; capacity.saturating_mul(3)],
            vel: vec![0.0; capacity.saturating_mul(3)],
            speed: vec![0.0; capacity],
            alive: 0,
            stall: vec![0; capacity],
            rng: SPAWN_SEED,
            exited_outlet: 0,
            killed_solid: 0,
            killed_stall: 0,
            killed_edge: 0,
        }
    }

    pub(crate) fn capacity(&self) -> usize {
        self.capacity
    }

    pub(crate) fn alive(&self) -> usize {
        self.alive
    }

    pub(crate) fn positions(&self) -> &[f32] {
        &self.pos
    }

    pub(crate) fn speeds(&self) -> &[f32] {
        &self.speed
    }

    /// One xorshift64 step (no `rand` crate per the spec).
    fn rng_next(&mut self) -> u64 {
        let mut x = self.rng;
        // A zero state would stick; the seed is nonzero and xorshift never
        // reaches zero from a nonzero state, but guard anyway (no panic path).
        if x == 0 {
            x = SPAWN_SEED;
        }
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rng = x;
        x
    }

    /// Uniform `f32` in `[0, 1)` from the top 24 mantissa bits.
    fn rng_unit(&mut self) -> f32 {
        const SCALE: f32 = 1.0 / 16_777_216.0; // 2^-24
        ((self.rng_next() >> 40) as u32 as f32) * SCALE
    }

    /// Shared placement core: append up to `count` inlet particles; when
    /// `clear`, the pool (RNG, stall states, fate counters) is reset first.
    /// Returns how many were placed.
    fn place(
        &mut self,
        occupancy: &[u8],
        nx: usize,
        ny: usize,
        nz: usize,
        count: usize,
        clear: bool,
    ) -> usize {
        if clear {
            self.alive = 0;
            self.rng = SPAWN_SEED;
            self.exited_outlet = 0;
            self.killed_solid = 0;
            self.killed_stall = 0;
            self.killed_edge = 0;
        }
        if self.capacity == 0 || nx == 0 || ny == 0 || nz == 0 {
            return 0;
        }
        let room = self.capacity.saturating_sub(self.alive);
        let m = count.min(room);
        if m == 0 {
            return 0;
        }
        let (fnx, fny, fnz) = (nx as f32, ny as f32, nz as f32);
        let (mut y_lo, mut y_hi) = (1.0f32, fny - 1.0);
        if y_hi <= y_lo {
            (y_lo, y_hi) = (0.0, fny);
        }
        let (mut z_lo, mut z_hi) = (1.0f32, fnz - 1.0);
        if z_hi <= z_lo {
            (z_lo, z_hi) = (0.0, fnz);
        }
        let (y_ext, z_ext) = ((y_hi - y_lo).max(1e-6), (z_hi - z_lo).max(1e-6));
        let n_y = ((m as f32 * y_ext / z_ext).sqrt().ceil() as usize).max(1);
        let n_z = m.div_ceil(n_y).max(1);
        let mut placed = 0usize;
        for k in 0..m {
            let gy = (k % n_y) as f32;
            let gz = ((k / n_y) % n_z) as f32;
            let mut accepted: Option<(f32, f32, f32)> = None;
            for _ in 0..SPAWN_RETRIES {
                let x = 0.5 + self.rng_unit() * 2.0;
                let y = y_lo + ((gy + self.rng_unit()) / n_y as f32) * y_ext;
                let z = z_lo + ((gz + self.rng_unit()) / n_z as f32) * z_ext;
                let (cx, cy, cz) = (x.floor() as i32, y.floor() as i32, z.floor() as i32);
                let solid = cx >= 0
                    && cx < fnx as i32
                    && cy >= 0
                    && cy < fny as i32
                    && cz >= 0
                    && cz < fnz as i32
                    && occupancy[cx as usize + nx * (cy as usize + ny * cz as usize)] != 0;
                if !solid {
                    accepted = Some((x, y, z));
                    break;
                }
            }
            let (x, y, z) = match accepted {
                Some(p) => p,
                None => continue,
            };
            let a = self.alive;
            // `a < capacity` by the `room` bound above; indexing is in-bounds.
            self.pos[3 * a] = x;
            self.pos[3 * a + 1] = y;
            self.pos[3 * a + 2] = z;
            self.vel[3 * a] = 0.0;
            self.vel[3 * a + 1] = 0.0;
            self.vel[3 * a + 2] = 0.0;
            self.speed[a] = 0.0;
            self.stall[a] = 0;
            self.alive += 1;
            placed += 1;
        }
        placed
    }

    /// Integrate every alive particle one RK1 substep (see module docs).
    /// Kills compact via swap-with-last across all four buffers. No
    /// allocation; stale entries past `alive` are never read by JS.
    pub(crate) fn advect_in(&mut self, view: &FlowView<'_>, dt: f32) {
        let (nx, ny, nz) = (view.nx, view.ny, view.nz);
        let n = view.cells();
        if n == 0 || view.f.len() != 19 * n || view.occupancy.len() != n {
            return;
        }
        let (fnx, fny, fnz) = (nx as f64, ny as f64, nz as f64);
        let dt = dt as f64;
        let mut i = 0usize;
        while i < self.alive {
            let (px, py, pz) = (
                self.pos[3 * i] as f64,
                self.pos[3 * i + 1] as f64,
                self.pos[3 * i + 2] as f64,
            );
            let v = sample_in(view, px as f32, py as f32, pz as f32);
            let sp = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            self.vel[3 * i] = v[0];
            self.vel[3 * i + 1] = v[1];
            self.vel[3 * i + 2] = v[2];
            self.speed[i] = sp;
            let stalled = if sp < STALL_SPEED {
                let s = self.stall[i].saturating_add(1);
                self.stall[i] = s;
                s >= STALL_STEPS
            } else {
                self.stall[i] = 0;
                false
            };
            let qx = px + v[0] as f64 * dt;
            let qy = py + v[1] as f64 * dt;
            let qz = pz + v[2] as f64 * dt;
            // Fate of the moved particle.
            let mut kill: Option<u8> = None; // 0 outlet, 1 edge, 2 solid, 3 stall
            if qx > fnx {
                kill = Some(0);
            } else if qy < -1.0 || qy > fny + 1.0 || qz < -1.0 || qz > fnz + 1.0 {
                kill = Some(1);
            } else if stalled {
                kill = Some(3);
            } else if qx >= 0.0 && qy >= 0.0 && qz >= 0.0 && qx < fnx && qy < fny && qz < fnz {
                let (cx, cy, cz) = (qx.floor() as usize, qy.floor() as usize, qz.floor() as usize);
                if view.occupancy[cx + nx * (cy + ny * cz)] != 0 {
                    kill = Some(2);
                }
            }
            match kill {
                Some(0) => self.exited_outlet += 1,
                Some(1) => self.killed_edge += 1,
                Some(2) => self.killed_solid += 1,
                Some(3) => self.killed_stall += 1,
                _ => {}
            }
            if kill.is_some() {
                // Swap-with-last compaction across every buffer.
                let last = self.alive - 1;
                if i != last {
                    for c in 0..3 {
                        self.pos[3 * i + c] = self.pos[3 * last + c];
                        self.vel[3 * i + c] = self.vel[3 * last + c];
                    }
                    self.speed[i] = self.speed[last];
                    self.stall[i] = self.stall[last];
                }
                self.alive = last;
            } else {
                self.pos[3 * i] = qx as f32;
                self.pos[3 * i + 1] = qy as f32;
                self.pos[3 * i + 2] = qz as f32;
                i += 1;
            }
        }
    }
}

/// Clear the pool and seed `count` inlet particles (deterministic).
pub(crate) fn spawn(state: &mut SimState, count: u32) {
    let (pool, occupancy, nx, ny, nz) = (
        &mut state.particles,
        &state.occupancy,
        state.nx,
        state.ny,
        state.nz,
    );
    pool.place(occupancy, nx, ny, nz, count as usize, true);
}

/// Append up to `n` new inlet particles without clearing; returns how many
/// were added (0 when the pool is full).
pub(crate) fn respawn(state: &mut SimState, n: u32) -> u32 {
    let (pool, occupancy, nx, ny, nz) = (
        &mut state.particles,
        &state.occupancy,
        state.nx,
        state.ny,
        state.nz,
    );
    pool.place(occupancy, nx, ny, nz, n as usize, false) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::advection::sample_velocity;
    use crate::lbm::{reset_state_flow, retune_solid_cells, stream_and_collide};

    fn flow_state(nx: usize, ny: usize, nz: usize, cap: usize, u_inlet: f64) -> SimState {
        let mut s = SimState::fresh(nx, ny, nz, cap);
        s.u_inlet = u_inlet;
        s.tau = 0.56;
        reset_state_flow(&mut s);
        s
    }

    fn place_box(s: &mut SimState, x0: usize, x1: usize, y0: usize, y1: usize, z0: usize, z1: usize) {
        for z in z0..z1 {
            for y in y0..y1 {
                for x in x0..x1 {
                    s.occupancy[x + s.nx * (y + s.ny * z)] = 1;
                }
            }
        }
        s.solid_count = s.occupancy.iter().filter(|&&o| o != 0).count();
        retune_solid_cells(s, &[]);
    }

    fn assert_buffer_finite(s: &SimState) {
        for (k, v) in s.particles.positions().iter().enumerate() {
            assert!(v.is_finite(), "pos[{k}] = {v} is not finite");
        }
        for (k, v) in s.particles.speeds().iter().enumerate() {
            assert!(v.is_finite(), "speed[{k}] = {v} is not finite");
        }
    }

    #[test]
    fn particles_transit_domain() {
        // 10-cell domain: 100 advects at u = 0.1, dt = 1 travel 10 cells, so
        // every particle spawned in x ∈ [0.5, 2.5) must exit through +X.
        let mut s = flow_state(10, 8, 8, 1200, 0.1);
        spawn(&mut s, 1000);
        assert_eq!(s.particles.alive(), 1000);
        for _ in 0..100 {
            crate::advection::advect(&mut s, 1.0);
            assert_buffer_finite(&s);
        }
        assert_eq!(
            s.particles.alive(),
            0,
            "all 1000 particles must have exited after travelling 10 cells"
        );
        assert_eq!(s.particles.exited_outlet, 1000);
        assert_eq!(s.particles.killed_solid, 0);
        assert_eq!(s.particles.killed_stall, 0);
        assert_eq!(s.particles.killed_edge, 0);
    }

    #[test]
    fn particles_deflect_around_cube() {
        // 32×16×16 + 4³ block (F008 small fixture); develop the flow, then
        // advect 2000 particles 200× at dt = 2 (≈32 cells of travel at
        // u = 0.08 — enough to transit the 32-cell domain).
        //
        // The deflection proxy is measured at step 60, while the whole cloud
        // is squeezing past the block and nobody has exited yet: the
        // cross-stream spread must exceed the seeded uniform spread. (After
        // mass exit the live set is biased toward slow wake laggards, so a
        // late spread comparison would invert — verified by probe.)
        let (nx, ny, nz) = (32usize, 16usize, 16usize);
        let mut s = flow_state(nx, ny, nz, 2400, 0.08);
        place_box(&mut s, 10, 14, 6, 10, 6, 10);
        for _ in 0..2000 {
            stream_and_collide(&mut s);
        }
        spawn(&mut s, 2000);
        assert_eq!(s.particles.alive(), 2000);
        // Initial cross-stream spread (mean |y − cy| + |z − cz|).
        let (cy, cz) = (ny as f64 / 2.0, nz as f64 / 2.0);
        let spread = |s: &SimState| -> f64 {
            let mut sum = 0.0f64;
            for a in 0..s.particles.alive() {
                let y = s.particles.positions()[3 * a + 1] as f64;
                let z = s.particles.positions()[3 * a + 2] as f64;
                sum += (y - cy).abs() + (z - cz).abs();
            }
            sum / s.particles.alive().max(1) as f64
        };
        let init_spread = spread(&s);
        for _ in 0..60 {
            crate::advection::advect(&mut s, 2.0);
        }
        assert_eq!(
            s.particles.alive(),
            2000,
            "nobody can have exited after ~10 cells of travel"
        );
        let mid_spread = spread(&s);
        assert!(
            mid_spread > init_spread,
            "cross-stream spread must grow squeezing past the cube ({init_spread:.3} → {mid_spread:.3})"
        );
        for _ in 60..200 {
            crate::advection::advect(&mut s, 2.0);
        }
        // Survivors past x = 0.8·nx plus the outlet-exited (which necessarily
        // crossed that plane — motion is continuous at < 0.2 cells/step)
        // all reached downstream without ever entering a solid.
        let line = 0.8 * nx as f32;
        let mut past = 0usize;
        for a in 0..s.particles.alive() {
            let (x, y, z) = (
                s.particles.positions()[3 * a],
                s.particles.positions()[3 * a + 1],
                s.particles.positions()[3 * a + 2],
            );
            if x > line {
                past += 1;
            }
            // Spot-check: no live particle sits inside a solid cell.
            if x >= 0.0 && y >= 0.0 && z >= 0.0
                && x < nx as f32
                && y < ny as f32
                && z < nz as f32
            {
                let c = x.floor() as usize + nx * (y.floor() as usize + ny * z.floor() as usize);
                assert_eq!(
                    s.occupancy[c], 0,
                    "live particle {a} at ({x},{y},{z}) is inside a solid cell"
                );
            }
            assert!(x.is_finite() && y.is_finite() && z.is_finite());
        }
        let reached = s.particles.exited_outlet as usize + past;
        assert!(
            reached * 100 >= 60 * 2000,
            "only {reached}/2000 particles reached x > 0.8·nx (need ≥ 60 %)"
        );
    }

    #[test]
    fn trapped_particles_die() {
        // Wake-centerline pocket behind the 4³ block. At u = 0.08 the eddy
        // minimum is scanned directly; the seeded particle must stall out
        // (30 consecutive sub-threshold samples) well within ~200 advects.
        let (nx, ny, nz) = (32usize, 16usize, 16usize);
        let mut s = flow_state(nx, ny, nz, 8, 0.08);
        place_box(&mut s, 10, 14, 6, 10, 6, 10);
        for _ in 0..2000 {
            stream_and_collide(&mut s);
        }
        let (cy, cz) = (ny as f32 / 2.0, nz as f32 / 2.0);
        // Scan the wake centerline for the slowest fluid cell.
        let mut best = (f32::INFINITY, 14.5f32);
        for x in [14.5f32, 15.5, 16.5, 17.5, 18.5, 19.5, 20.5, 21.5] {
            let v = sample_velocity(&s, x, cy, cz);
            let sp = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            if sp < best.0 {
                best = (sp, x);
            }
        }
        assert!(
            best.0 < 0.02,
            "wake pocket minimum speed {} should be deep (< 0.02)",
            best.0
        );
        // Seed exactly one particle at the pocket minimum (bypassing the
        // inlet distributor — same-module access).
        s.particles.alive = 1;
        s.particles.pos[0] = best.1;
        s.particles.pos[1] = cy;
        s.particles.pos[2] = cz;
        s.particles.stall[0] = 0;
        for _ in 0..200 {
            crate::advection::advect(&mut s, 1.0);
            if s.particles.alive() == 0 {
                break;
            }
        }
        assert_eq!(
            s.particles.alive(),
            0,
            "pocket-seeded particle (min speed {}) must be gone within ~200 steps",
            best.0
        );
    }

    #[test]
    fn respawn_refills() {
        let mut s = flow_state(10, 8, 8, 600, 0.1);
        spawn(&mut s, 1000);
        // Capacity clamps the initial fill.
        assert_eq!(s.particles.alive(), 600);
        for _ in 0..100 {
            crate::advection::advect(&mut s, 1.0);
        }
        assert_eq!(s.particles.alive(), 0);
        assert_eq!(respawn(&mut s, 500), 500);
        assert_eq!(s.particles.alive(), 500);
        // Refilling past capacity clamps; refilling a full pool adds nothing.
        assert_eq!(respawn(&mut s, 500), 100);
        assert_eq!(s.particles.alive(), 600);
        assert_eq!(respawn(&mut s, 1), 0);
        assert_buffer_finite(&s);
    }

    #[test]
    fn spawn_is_deterministic_and_skips_solids() {
        // A block covering most of the inlet slab: settled particles must
        // still avoid solids, and two spawns must agree exactly.
        let mut s = flow_state(16, 8, 8, 64, 0.05);
        place_box(&mut s, 0, 3, 0, 8, 0, 8);
        spawn(&mut s, 64);
        let first = s.particles.positions().to_vec();
        let n0 = s.particles.alive();
        for a in 0..n0 {
            let (x, y, z) = (first[3 * a], first[3 * a + 1], first[3 * a + 2]);
            let c = x.floor() as usize + 16 * (y.floor() as usize + 8 * z.floor() as usize);
            assert_eq!(s.occupancy[c], 0, "spawned particle {a} inside a solid");
        }
        spawn(&mut s, 64);
        assert_eq!(s.particles.alive(), n0);
        assert_eq!(s.particles.positions(), first.as_slice());
    }

    #[test]
    fn no_allocation_in_advect() {
        // Steady-state pressure: a full 100-particle pool on a 16³ grid,
        // dt = 0 (particles hold station, so every one of the 1000 advects
        // does the full sampling work — no exits, no stall deaths at
        // u = 0.1). 100 particles × 1000 advects ≈ 0.8M corner macroscopic
        // evaluations: ~20 ms in release on the dev machine, so the 50 ms
        // budget has ~2× headroom while any per-call allocation (e.g. a
        // 16³ scratch field × 1000) would blow past it. Review assertion:
        // `advect_in` touches only preallocated buffers (no Vec/HashMap/
        // collect calls — verify by inspection).
        let mut s = flow_state(16, 16, 16, 100, 0.1);
        spawn(&mut s, 100);
        assert_eq!(s.particles.alive(), 100);
        let t0 = std::time::Instant::now();
        for _ in 0..1000 {
            crate::advection::advect(&mut s, 0.0);
        }
        let elapsed = t0.elapsed();
        assert_eq!(s.particles.alive(), 100, "dt = 0 must hold the pool full");
        assert_buffer_finite(&s);
        // Timing heuristic catches accidental per-call allocation; gated to
        // release (debug codegen is ~10× slower and would trip it spuriously).
        if !cfg!(debug_assertions) {
            assert!(
                elapsed.as_millis() < 50,
                "1000 advects took {elapsed:?} (≥ 50 ms suggests per-call allocation)"
            );
        }
    }
}
