//! Batched trilinear velocity sampling + particle advection driver (F011).
//!
//! Algorithm module — intentionally `wasm_bindgen`-free (see CONVENTIONS.md).
//! Thin ABI exports (`sample_velocity_batch`, `spawn_particles`, `respawn`,
//! `advect_particles`, …) live in `lib.rs`; the particle pool itself lives in
//! `particles.rs`.
//!
//! ## Sample coordinate convention (binding for F016)
//!
//! Domain space is in lattice units. Cell `(i, j, k)` occupies
//! `[i, i+1) × [j, j+1) × [k, k+1)` and its macroscopic velocity is located at
//! its center `(i+0.5, j+0.5, k+0.5)`. Sampling maps a point `p` to fractional
//! center coordinates `f = p − 0.5`, takes the surrounding `(i0, i0+1)` cell
//! triplet per axis, and blends the 8 corner velocities trilinearly.
//!
//! ## Corner / bounds rules
//!
//! - Sample point with `x < 0` (upstream of the inlet) → `(u_inlet, 0, 0)`.
//! - Sample point with `x ≥ nx` or outside `y/z` → `(0, 0, 0)`.
//! - Sample point whose containing cell (`floor(p)`) is solid → `(0, 0, 0)`.
//! - Corner cells that are solid contribute **zero velocity** with their full
//!   trilinear weight (no renormalization — flow correctly decays to zero at
//!   walls/obstacles instead of being clamped).
//! - Corner cells upstream of the inlet (`ix < 0`, reachable only when sampling
//!   within half a cell of the inlet face) contribute `(u_inlet, 0, 0)`;
//!   corners out of bounds anywhere else contribute zero.
//! - Macroscopic moments are computed on demand from `f` — no velocity cache
//!   is kept this feature (F019 budgets the cost; see ARCHITECTURE.md §7).
//!
//! ## Advection integration
//!
//! [`advect`] integrates the whole pool one substep with explicit Euler (RK1):
//! `p += v·dt` with `v = sample(p)` — documented v1 behaviour (no RK2/RK4,
//! no bounce-off-surface reflection; particles entering solids die).

use crate::SimState;
use crate::lbm::macroscopic;

/// Shared read-only view of the flow field for sampling (bundles the
/// stencil arguments so call sites stay lean; see `sample_in`).
pub(crate) struct FlowView<'a> {
    pub(crate) f: &'a [f32],
    pub(crate) occupancy: &'a [u8],
    pub(crate) nx: usize,
    pub(crate) ny: usize,
    pub(crate) nz: usize,
    pub(crate) u_inlet: f64,
}

impl<'a> FlowView<'a> {
    pub(crate) fn cells(&self) -> usize {
        self.nx * self.ny * self.nz
    }
}

/// Macroscopic velocity of one stencil corner cell, with the solid and
/// out-of-domain rules from the module docs. Always returns finite values
/// (degenerate moments fall back to zero instead of propagating NaN).
fn corner_velocity(view: &FlowView<'_>, n: usize, ix: i32, iy: i32, iz: i32) -> (f64, f64, f64) {
    if ix < 0 {
        return (view.u_inlet, 0.0, 0.0);
    }
    if ix >= view.nx as i32 || iy < 0 || iy >= view.ny as i32 || iz < 0 || iz >= view.nz as i32 {
        return (0.0, 0.0, 0.0);
    }
    let c = ix as usize + view.nx * (iy as usize + view.ny * iz as usize);
    if view.occupancy[c] != 0 {
        return (0.0, 0.0, 0.0);
    }
    let (_, ux, uy, uz) = macroscopic(view.f, n, c);
    if !ux.is_finite() || !uy.is_finite() || !uz.is_finite() {
        return (0.0, 0.0, 0.0);
    }
    (ux, uy, uz)
}

/// Sampling core over split borrows (lets [`advect`] and the pool share it
/// without fighting the borrow checker).
pub(crate) fn sample_in(view: &FlowView<'_>, x: f32, y: f32, z: f32) -> [f32; 3] {
    let (nx, ny, nz) = (view.nx, view.ny, view.nz);
    let n = view.cells();
    if n == 0 || view.f.len() != 19 * n || view.occupancy.len() != n {
        return [0.0, 0.0, 0.0];
    }
    let (xf, yf, zf) = (x as f64, y as f64, z as f64);
    let (fnx, fny, fnz) = (nx as f64, ny as f64, nz as f64);
    if xf < 0.0 {
        let u = if view.u_inlet.is_finite() {
            view.u_inlet as f32
        } else {
            0.0
        };
        return [u, 0.0, 0.0];
    }
    if xf >= fnx || yf < 0.0 || yf >= fny || zf < 0.0 || zf >= fnz {
        return [0.0, 0.0, 0.0];
    }
    let (cx, cy, cz) = (xf.floor() as usize, yf.floor() as usize, zf.floor() as usize);
    if view.occupancy[cx + nx * (cy + ny * cz)] != 0 {
        return [0.0, 0.0, 0.0];
    }
    // Fractional coordinates in "cell-center space" (center of cell i at i).
    let (fx, fy, fz) = (xf - 0.5, yf - 0.5, zf - 0.5);
    let (ix0, iy0, iz0) = (fx.floor() as i32, fy.floor() as i32, fz.floor() as i32);
    let (tx, ty, tz) = (fx - ix0 as f64, fy - iy0 as f64, fz - iz0 as f64);
    let mut vx = 0.0f64;
    let mut vy = 0.0f64;
    let mut vz = 0.0f64;
    for dz in 0..2i32 {
        let wz = if dz == 0 { 1.0 - tz } else { tz };
        for dy in 0..2i32 {
            let wy = if dy == 0 { 1.0 - ty } else { ty };
            for dx in 0..2i32 {
                let wx = if dx == 0 { 1.0 - tx } else { tx };
                let (cux, cuy, cuz) = corner_velocity(view, n, ix0 + dx, iy0 + dy, iz0 + dz);
                let w = wx * wy * wz;
                vx += w * cux;
                vy += w * cuy;
                vz += w * cuz;
            }
        }
    }
    [vx as f32, vy as f32, vz as f32]
}

/// Trilinear velocity sample at domain-space `(x, y, z)` (see module docs
/// for the convention and bounds rules). Never panics, even on an empty
/// domain.
pub fn sample_velocity(state: &SimState, x: f32, y: f32, z: f32) -> [f32; 3] {
    let view = FlowView {
        f: &state.f,
        occupancy: &state.occupancy,
        nx: state.nx,
        ny: state.ny,
        nz: state.nz,
        u_inlet: state.u_inlet,
    };
    sample_in(&view, x, y, z)
}

/// Batch sampling: `points` holds `n×3` domain-space coords, `out` receives
/// `n×3` velocities. Length mismatch (or a length that is not a multiple of
/// 3) writes nothing — panics are forbidden. Allocates nothing.
pub fn sample_velocity_batch(state: &SimState, points: &[f32], out: &mut [f32]) {
    if points.len() != out.len() || !points.len().is_multiple_of(3) {
        return;
    }
    let n = points.len() / 3;
    for k in 0..n {
        let v = sample_velocity(state, points[3 * k], points[3 * k + 1], points[3 * k + 2]);
        out[3 * k] = v[0];
        out[3 * k + 1] = v[1];
        out[3 * k + 2] = v[2];
    }
}

/// Integrate the whole particle pool one lattice-Δt substep (RK1 in
/// `particles.rs`). Non-finite `dt` is a no-op. Allocates nothing.
pub fn advect(state: &mut SimState, dt: f32) {
    if !dt.is_finite() {
        return;
    }
    // Disjoint field borrows: the pool mutably, the flow field shared.
    let view = FlowView {
        f: &state.f,
        occupancy: &state.occupancy,
        nx: state.nx,
        ny: state.ny,
        nz: state.nz,
        u_inlet: state.u_inlet,
    };
    state.particles.advect_in(&view, dt);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SimState;
    use crate::lbm::{equilibrium, reset_state_flow, retune_solid_cells};

    fn uniform_state(nx: usize, ny: usize, nz: usize, u_inlet: f64) -> SimState {
        let mut s = SimState::fresh(nx, ny, nz, 0);
        s.u_inlet = u_inlet;
        s.tau = 0.56;
        reset_state_flow(&mut s);
        s
    }

    /// Fill every cell with equilibrium at `(1, u_of(j), 0, 0)` where the
    /// profile varies linearly across cell-center y coordinates.
    fn fill_shear_profile(s: &mut SimState, u_at_center: impl Fn(f64) -> f64) {
        let n = s.nx * s.ny * s.nz;
        for k in 0..s.nz {
            for j in 0..s.ny {
                let u = u_at_center(j as f64 + 0.5);
                for i in 0..s.nx {
                    let c = i + s.nx * (j + s.ny * k);
                    for d in 0..19 {
                        s.f[d * n + c] = equilibrium(1.0, u, 0.0, 0.0, d) as f32;
                    }
                }
            }
        }
    }

    #[test]
    fn sample_at_cell_center_exact() {
        let s = uniform_state(16, 8, 8, 0.05);
        // Interior, wall-adjacent, inlet-face and outlet-face centers.
        let probes = [
            (4.5f32, 4.5f32, 4.5f32),
            (0.5, 1.5, 1.5),
            (15.5, 6.5, 6.5),
            (8.5, 0.5, 7.5),
            (11.5, 7.5, 0.5),
        ];
        for (x, y, z) in probes {
            let v = sample_velocity(&s, x, y, z);
            assert!(
                (v[0] as f64 - 0.05).abs() < 1e-6,
                "ux={} at ({x},{y},{z}) deviates from 0.05 by >= 1e-6",
                v[0]
            );
            assert!(
                (v[1] as f64).abs() < 1e-6 && (v[2] as f64).abs() < 1e-6,
                "transverse u=({},{}) at ({x},{y},{z}) >= 1e-6",
                v[1],
                v[2]
            );
        }
    }

    #[test]
    fn sample_trilinear_interpolates() {
        // Linear shear: u_x = 0.04 + 0.002 * y_center across the y rows.
        let mut s = uniform_state(16, 8, 8, 0.05);
        fill_shear_profile(&mut s, |yc| 0.04 + 0.002 * yc);
        // Halfway between row centers j=3 (yc=3.5, u=0.047) and j=4 (yc=4.5,
        // u=0.049): hand-derived expectation 0.048.
        let v = sample_velocity(&s, 7.5, 4.0, 3.5);
        assert!(
            (v[0] as f64 - 0.048).abs() < 1e-5,
            "shear sample ux={} should reproduce the linear profile 0.048 ± 1e-5",
            v[0]
        );
        assert!(
            (v[1] as f64).abs() < 1e-5 && (v[2] as f64).abs() < 1e-5,
            "shear transverse u=({},{}) >= 1e-5",
            v[1],
            v[2]
        );
        // Quarter point: 0.75 * u(3.5) + 0.25 * u(4.5) = 0.0475.
        let w = sample_velocity(&s, 7.5, 3.75, 3.5);
        assert!(
            (w[0] as f64 - 0.0475).abs() < 1e-5,
            "shear sample ux={} should be 0.0475 ± 1e-5",
            w[0]
        );
    }

    #[test]
    fn sample_in_solid_is_zero() {
        let mut s = uniform_state(16, 8, 8, 0.05);
        // 4³ solid block [6..10)×[2..6)×[2..6), frozen at rest.
        for z in 2..6usize {
            for y in 2..6usize {
                for x in 6..10usize {
                    s.occupancy[x + s.nx * (y + s.ny * z)] = 1;
                }
            }
        }
        s.solid_count = s.occupancy.iter().filter(|&&o| o != 0).count();
        retune_solid_cells(&mut s, &[]);
        let v = sample_velocity(&s, 7.5, 3.5, 3.5);
        assert_eq!(
            v,
            [0.0, 0.0, 0.0],
            "sample inside a solid cell must be exactly zero, got {v:?}"
        );
        // A fluid center next to the block still sees the free stream.
        let w = sample_velocity(&s, 3.5, 3.5, 3.5);
        assert!(
            (w[0] as f64 - 0.05).abs() < 1e-6,
            "fluid sample ux={} should be 0.05 ± 1e-6",
            w[0]
        );
    }

    #[test]
    fn sample_upstream_is_inlet() {
        let s = uniform_state(16, 8, 8, 0.05);
        for (x, y, z) in [(-1.5f32, 4.0f32, 4.0f32), (-0.1, 0.0, 7.9), (-100.0, 4.0, 4.0)]
        {
            let v = sample_velocity(&s, x, y, z);
            assert!(
                (v[0] as f64 - 0.05).abs() < 1e-6,
                "upstream ux={} at x={x} should be u_inlet ± 1e-6",
                v[0]
            );
            assert_eq!((v[1], v[2]), (0.0, 0.0));
        }
    }

    #[test]
    fn sample_downstream_is_zero() {
        let s = uniform_state(16, 8, 8, 0.05);
        // Past the outlet, above/below the walls, and exactly on x = nx.
        for (x, y, z) in [
            (16.0f32, 4.0f32, 4.0f32),
            (20.5, 4.0, 4.0),
            (8.5, -0.5, 4.0),
            (8.5, 4.0, 8.0),
            (8.5, 8.0, 4.0),
        ] {
            assert_eq!(
                sample_velocity(&s, x, y, z),
                [0.0, 0.0, 0.0],
                "out-of-domain sample at ({x},{y},{z}) must be zero"
            );
        }
    }

    #[test]
    fn batch_matches_single_and_rejects_mismatch() {
        let s = uniform_state(16, 8, 8, 0.05);
        let points: Vec<f32> = vec![4.5, 4.5, 4.5, 7.25, 3.1, 6.8, -2.0, 1.0, 1.0];
        let mut out = vec![-1.0f32; 9];
        sample_velocity_batch(&s, &points, &mut out);
        for k in 0..3 {
            let v = sample_velocity(&s, points[3 * k], points[3 * k + 1], points[3 * k + 2]);
            assert_eq!(
                [out[3 * k], out[3 * k + 1], out[3 * k + 2]],
                v,
                "batch lane {k} must equal the single-point sample"
            );
        }
        // Mismatched lengths (and non-multiples of 3) write nothing.
        let mut guard = vec![7.0f32; 6];
        sample_velocity_batch(&s, &points, &mut guard);
        assert_eq!(guard, vec![7.0f32; 6]);
        let mut guard2 = vec![7.0f32; 4];
        sample_velocity_batch(&s, &[1.0, 2.0, 3.0, 4.0], &mut guard2);
        assert_eq!(guard2, vec![7.0f32; 4]);
    }
}
