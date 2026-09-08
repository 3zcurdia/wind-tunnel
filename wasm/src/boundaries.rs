//! Wind-tunnel boundary conditions (F008).
//!
//! Pure algorithm module — intentionally `wasm_bindgen`-free (see CONVENTIONS.md).
//! Thin ABI exports live in `lib.rs`; the per-step driver (`stream_and_collide`)
//! in `lbm.rs` calls [`apply_all`] after the non-periodic streaming pass.
//!
//! ## BC set (ARCHITECTURE.md §3)
//!
//! - **Inlet** at `x = 0`: fixed-velocity equilibrium injection,
//!   `f = equilibrium(ρ = 1, u = (u_inlet, 0, 0))`, overwritten every step.
//! - **Outlet** at `x = nx-1`: zero-gradient copy from `x = nx-2` every step.
//! - **Walls** at `y = 0`, `y = ny-1`, `z = 0`, `z = nz-1`: free-slip specular
//!   reflection (mirror the wall-normal families, keep tangential).
//! - **Obstacles**: full-way bounce-back on the fluid side (see below).
//!
//! ## Order per step
//!
//! `collide → stream (non-periodic, skips solid destinations)` →
//! [`apply_obstacle_bounce_back`] → [`apply_inlet`] → [`apply_outlet`] →
//! [`apply_walls`]. This is the fixed precedence, highest first:
//!
//! **obstacle > inlet > outlet > walls**
//!
//! - Obstacle wins because every BC below skips solid cells (they stay frozen);
//!   bounce-back itself only writes fluid cells.
//! - Inlet (at `x = 0`) runs before outlet (at `x = nx-1`); the faces never
//!   overlap except in degenerate `nx < 2` domains (guarded, no panic).
//! - Walls run last, including the outlet-face edge cells. This preserves the
//!   outlet zero-gradient property: the outlet copy makes `nx-1 == nx-2` per
//!   channel, then walls apply the *same* pairwise permutation to both the
//!   `nx-1` and `nx-2` wall cells, so equality is retained exactly.
//!   Inlet-face corners also receive the wall permutation, but the inlet
//!   equilibrium at `(u_inlet, 0, 0)` is invariant under wall swaps (mirrored
//!   pairs carry identical populations when `u_y = u_z = 0`), so the inlet
//!   velocity clamp still holds — inlet effectively wins.
//!
//! ## Implemented variants
//!
//! - *Bounce-back (fluid-side full-way, on-node):* after streaming, for every
//!   fluid cell `c` and direction `i` with neighbor `c + e[i]` solid (in-bounds),
//!   set `f[reverse(i)][c] = f[i][c]` using the post-streaming values in the
//!   live buffer `f` (the spec text calls this buffer `f_next`; ours is `f`
//!   because our collide-then-pull-stream scheme streams `f_next → f`).
//!   Directions pointing into a solid (`f[i]` valid, pulled from the interior)
//!   overwrite the opposite population (`f[reverse(i)]`, pulled from the solid
//!   mirror). To avoid in-place ordering hazards when two opposite directions
//!   both face solids, each affected cell snapshots its 19 populations first,
//!   then writes. Only cells adjacent to a solid pay the snapshot cost.
//! - *Inlet:* overwrite, including flux accounting
//!   `mass_in_flux += 1.0 · u_inlet · (ny-2)·(nz-2)` per step (ρ = 1).
//! - *Outlet:* copy, then measure
//!   `mass_out_flux += Σ ρ·u_x` over the interior outlet face
//!   (`y ∈ [1, ny-1)`, `z ∈ [1, nz-1)`, fluid cells only, via `Σ f_i·e_x`).
//!   Interior-only on both sides keeps in/out comparable for F013.
//! - *Walls (specular as pairwise swap):* for a `y`-wall cell, exchange each
//!   mirrored pair (same `e_x, e_z`, opposite `e_y`); for a `z`-wall cell,
//!   exchange each pair with same `e_x, e_y`, opposite `e_z`. A swap is a
//!   permutation: mass is conserved exactly, tangential momentum is preserved,
//!   normal momentum reverses — the specular rule the unit test asserts.
//!   Corner cells (both a `y`- and `z`-wall) receive both swaps in sequence
//!   (`y` then `z`), mirroring both normals.
//!
//! All functions take `&mut SimState` and allocate nothing (stack arrays only).

use crate::SimState;
use crate::lbm::{EX, EY, EZ, REVERSE, equilibrium};

// ── Wall-mirror tables ──────────────────────────────────────────────
// Derived from the D3Q19 velocity set in `lbm.rs` (`EX/EY/EZ`):
//
// ```text
// i:  0         1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18
// e:  .        +x -x +y -y +z -z +x -x +x -x +x -x +x -x +y -y +y -y
//                     +y -y          +y -y -y +y          +z -z +z -z
//                     .  .  +z -z .  .  .  .  .  +z -z -z +z +z -z -z +z
// ```
//
// - `Y_WALL_PAIRS`: same `e_x, e_z`, opposite `e_y`
//   (3↔4, 7↔9, 8↔10, 15↔18, 16↔17; the rest have `e_y = 0`).
// - `Z_WALL_PAIRS`: same `e_x, e_y`, opposite `e_z`
//   (5↔6, 11↔13, 12↔14, 15↔17, 16↔18; the rest have `e_z = 0`).

/// Mirrored pairs for `y`-walls: same `(e_x, e_z)`, opposite `e_y`.
pub(crate) const Y_WALL_PAIRS: [(usize, usize); 5] =
    [(3, 4), (7, 9), (8, 10), (15, 18), (16, 17)];

/// Mirrored pairs for `z`-walls: same `(e_x, e_y)`, opposite `e_z`.
pub(crate) const Z_WALL_PAIRS: [(usize, usize); 5] =
    [(5, 6), (11, 13), (12, 14), (15, 17), (16, 18)];

/// Row-major lattice index: `idx = x + nx·(y + ny·z)`.
#[inline]
fn idx(x: usize, y: usize, z: usize, nx: usize, ny: usize) -> usize {
    x + nx * (y + ny * z)
}

fn state_ok(state: &SimState) -> Option<usize> {
    let n = state.nx * state.ny * state.nz;
    if n == 0 || state.f.len() != 19 * n || state.f_next.len() != 19 * n {
        return None;
    }
    if state.occupancy.len() != n {
        return None;
    }
    Some(n)
}

// ── Obstacles ───────────────────────────────────────────────────────

/// Fluid-side full-way bounce-back (see module docs). Skips solid cells;
/// out-of-bounds neighbors are not solid (walls handle the domain edge).
/// No allocation: two small stack arrays per solid-adjacent fluid cell only.
///
/// F013 drag hook: returns the per-step lattice drag force `F_lat` — the
/// x-momentum exchange summed over every reflecting link,
/// `Σ (f[i] + f[rev(i)]) · e_x[i]` from the pre-bounce snapshot (see
/// `crate::stats` for the EMA + physical conversion). The accumulation is
/// branch-free inside the link loop (the `e_x == 0` links contribute exactly
/// 0 via the multiply). Non-finite populations propagate into the sum; the
/// EMA update in [`apply_all`] guards against poisoning.
pub(crate) fn apply_obstacle_bounce_back(state: &mut SimState) -> f64 {
    let n = match state_ok(state) {
        Some(n) => n,
        None => return 0.0,
    };
    let (nx, ny, nz) = (state.nx, state.ny, state.nz);
    let nx_i = nx as i32;
    let ny_i = ny as i32;
    let nz_i = nz as i32;
    let mut drag_lat_step = 0.0f64;
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let c = idx(x, y, z, nx, ny);
                if state.occupancy[c] != 0 {
                    continue;
                }
                // Fast path: any solid neighbour?
                let mut adjacent = false;
                for i in 1..19 {
                    let sx = x as i32 + EX[i];
                    let sy = y as i32 + EY[i];
                    let sz = z as i32 + EZ[i];
                    if sx < 0 || sx >= nx_i || sy < 0 || sy >= ny_i || sz < 0 || sz >= nz_i {
                        continue;
                    }
                    // SAFETY-free index: bounds checked above.
                    let nb = idx(sx as usize, sy as usize, sz as usize, nx, ny);
                    if state.occupancy[nb] != 0 {
                        adjacent = true;
                        break;
                    }
                }
                if !adjacent {
                    continue;
                }
                let mut snap = [0f32; 19];
                for i in 0..19 {
                    snap[i] = state.f[i * n + c];
                }
                for i in 1..19 {
                    let sx = x as i32 + EX[i];
                    let sy = y as i32 + EY[i];
                    let sz = z as i32 + EZ[i];
                    if sx < 0 || sx >= nx_i || sy < 0 || sy >= ny_i || sz < 0 || sz >= nz_i {
                        continue;
                    }
                    let nb = idx(sx as usize, sy as usize, sz as usize, nx, ny);
                    if state.occupancy[nb] != 0 {
                        let r = REVERSE[i];
                        // F013: x-momentum exchange for this reflecting link,
                        // from the pre-bounce snapshot. Branch-free: links
                        // with `e_x == 0` contribute exactly 0.
                        drag_lat_step +=
                            (snap[i] as f64 + snap[r] as f64) * EX[i] as f64;
                        state.f[r * n + c] = snap[i];
                    }
                }
            }
        }
    }
    drag_lat_step
}

// ── Inlet ───────────────────────────────────────────────────────────

/// Fixed-velocity equilibrium injection at `x = 0` (skips solid cells, so
/// obstacles win). Adds `ρ·u_inlet·(ny-2)(nz-2)` with `ρ = 1` to
/// `mass_in_flux`. No allocation.
pub(crate) fn apply_inlet(state: &mut SimState) {
    let n = match state_ok(state) {
        Some(n) => n,
        None => return,
    };
    let (nx, ny, nz) = (state.nx, state.ny, state.nz);
    if nx == 0 || ny == 0 || nz == 0 {
        return;
    }
    let u = state.u_inlet;
    let mut feq = [0f32; 19];
    for i in 0..19 {
        feq[i] = equilibrium(1.0, u, 0.0, 0.0, i) as f32;
    }
    for z in 0..nz {
        for y in 0..ny {
            let c = idx(0, y, z, nx, ny);
            if state.occupancy[c] != 0 {
                continue;
            }
            for i in 0..19 {
                state.f[i * n + c] = feq[i];
            }
        }
    }
    let iy = ny.saturating_sub(2) as f64;
    let iz = nz.saturating_sub(2) as f64;
    if u.is_finite() {
        state.mass_in_flux += u * iy * iz;
    }
}

// ── Outlet ──────────────────────────────────────────────────────────

/// Zero-gradient copy `x = nx-1 ← x = nx-2` (skips solid destinations).
/// Measures `Σ ρ·u_x` over the interior outlet face into `mass_out_flux`.
/// No allocation.
pub(crate) fn apply_outlet(state: &mut SimState) {
    let n = match state_ok(state) {
        Some(n) => n,
        None => return,
    };
    let (nx, ny, nz) = (state.nx, state.ny, state.nz);
    if nx < 2 || ny == 0 || nz == 0 {
        return;
    }
    let (xo, xs) = (nx - 1, nx - 2);
    for z in 0..nz {
        for y in 0..ny {
            let dst = idx(xo, y, z, nx, ny);
            if state.occupancy[dst] != 0 {
                continue;
            }
            let src = idx(xs, y, z, nx, ny);
            for i in 0..19 {
                state.f[i * n + dst] = state.f[i * n + src];
            }
        }
    }
    // Interior-face mass flux Σ ρ·u_x = Σ_cells Σ_i f_i·e_x(i).
    if ny >= 3 && nz >= 3 {
        let mut sum = 0.0f64;
        for z in 1..nz - 1 {
            for y in 1..ny - 1 {
                let c = idx(xo, y, z, nx, ny);
                if state.occupancy[c] != 0 {
                    continue;
                }
                let mut mom = 0.0f64;
                for i in 0..19 {
                    let ex = EX[i] as f64;
                    if ex != 0.0 {
                        mom += state.f[i * n + c] as f64 * ex;
                    }
                }
                if mom.is_finite() {
                    sum += mom;
                }
            }
        }
        if sum.is_finite() {
            state.mass_out_flux += sum;
        }
    }
}

// ── Walls ───────────────────────────────────────────────────────────

/// Swap the populations of one mirrored pair at one fluid cell.
#[inline]
fn swap_pair(f: &mut [f32], n: usize, cell: usize, a: usize, b: usize) {
    let ia = a * n + cell;
    let ib = b * n + cell;
    let tmp = f[ia];
    f[ia] = f[ib];
    f[ib] = tmp;
}

/// Free-slip specular reflection via pairwise swaps (see module docs).
/// Applies to `y = 0 / ny-1` (all `x, z`) then `z = 0 / nz-1` (all `x, y`);
/// solid cells are skipped (obstacles win). Degenerate single-row/plane
/// domains (`ny == 1` / `nz == 1`) skip that axis — swapping a cell with
/// itself twice would be a no-op anyway. No allocation.
pub(crate) fn apply_walls(state: &mut SimState) {
    let n = match state_ok(state) {
        Some(n) => n,
        None => return,
    };
    let (nx, ny, nz) = (state.nx, state.ny, state.nz);
    if nx == 0 || ny == 0 || nz == 0 {
        return;
    }
    if ny > 1 {
        for &y in &[0usize, ny - 1] {
            for z in 0..nz {
                for x in 0..nx {
                    let c = idx(x, y, z, nx, ny);
                    if state.occupancy[c] != 0 {
                        continue;
                    }
                    for &(a, b) in Y_WALL_PAIRS.iter() {
                        swap_pair(&mut state.f, n, c, a, b);
                    }
                }
            }
        }
    }
    if nz > 1 {
        for &z in &[0usize, nz - 1] {
            for y in 0..ny {
                for x in 0..nx {
                    let c = idx(x, y, z, nx, ny);
                    if state.occupancy[c] != 0 {
                        continue;
                    }
                    for &(a, b) in Z_WALL_PAIRS.iter() {
                        swap_pair(&mut state.f, n, c, a, b);
                    }
                }
            }
        }
    }
}

/// Full per-step BC pass in fixed order: bounce-back → inlet → outlet → walls.
///
/// F013: folds the bounce-back drag sum into `state.drag_lat_ema`
/// (EMA, α = [`crate::stats::DRAG_EMA_ALPHA`]) here so `lbm.rs` stays
/// untouched (F013's file list excludes it). Non-finite step sums never touch
/// the EMA (they would poison every future `stats()` read); `stable` is left
/// alone — stability is F010's business.
pub(crate) fn apply_all(state: &mut SimState) {
    let step = apply_obstacle_bounce_back(state);
    if step.is_finite() {
        let base = if state.drag_lat_ema.is_finite() {
            state.drag_lat_ema
        } else {
            0.0
        };
        state.drag_lat_ema = base + crate::stats::DRAG_EMA_ALPHA * (step - base);
    }
    apply_inlet(state);
    apply_outlet(state);
    apply_walls(state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SimState;
    use crate::lbm::{macroscopic, reset_state_flow, retune_solid_cells, stream_and_collide};

    fn test_state(nx: usize, ny: usize, nz: usize, u_inlet: f64, tau: f64) -> SimState {
        let mut s = SimState::new_test(nx, ny, nz);
        s.u_inlet = u_inlet;
        s.tau = tau;
        reset_state_flow(&mut s);
        s
    }

    fn total_mass(s: &SimState) -> f64 {
        let n = s.nx * s.ny * s.nz;
        let mut sum = 0.0f64;
        for c in 0..n {
            let (rho, _, _, _) = macroscopic(&s.f, n, c);
            sum += rho;
        }
        sum
    }

    /// Fill an axis-aligned solid box `[x0,x1)×[y0,y1)×[z0,z1)` and freeze the
    /// fresh solids at rest equilibrium (mirrors `set_mesh` retuning).
    fn place_box(s: &mut SimState, x0: usize, x1: usize, y0: usize, y1: usize, z0: usize, z1: usize) {
        for z in z0..z1 {
            for y in y0..y1 {
                for x in x0..x1 {
                    let c = x + s.nx * (y + s.ny * z);
                    s.occupancy[c] = 1;
                }
            }
        }
        s.solid_count = s.occupancy.iter().filter(|&&o| o != 0).count();
        retune_solid_cells(s, &[]);
    }

    /// Default-grid cube at the ARCH §3 placement center (`x = 0.35·nx`,
    /// `y = ny/2`, `z = nz/2`), 8³ cells. Returns `(cube_min, sample_min)` for
    /// documentation; the sampling box is 8³ directly downstream.
    fn place_center_cube(s: &mut SimState) {
        let cx = (0.35 * s.nx as f64) as usize;
        let cy = s.ny / 2;
        let cz = s.nz / 2;
        let h = 4usize; // half-edge → 8³ cube
        place_box(
            s,
            cx - h,
            cx + h,
            cy - h,
            cy + h,
            cz - h,
            cz + h,
        );
    }

    #[test]
    fn wall_tables_mirror_normals() {
        // Tangential momentum preserved, normal reversed, for every pair.
        for &(a, b) in Y_WALL_PAIRS.iter() {
            assert_eq!(EX[a], EX[b], "y-pair {a}<->{b} must share e_x");
            assert_eq!(EZ[a], EZ[b], "y-pair {a}<->{b} must share e_z");
            assert_eq!(EY[a], -EY[b], "y-pair {a}<->{b} must flip e_y");
            assert_ne!(EY[a], 0, "y-pair {a}<->{b} must carry y-momentum");
        }
        for &(a, b) in Z_WALL_PAIRS.iter() {
            assert_eq!(EX[a], EX[b], "z-pair {a}<->{b} must share e_x");
            assert_eq!(EY[a], EY[b], "z-pair {a}<->{b} must share e_y");
            assert_eq!(EZ[a], -EZ[b], "z-pair {a}<->{b} must flip e_z");
            assert_ne!(EZ[a], 0, "z-pair {a}<->{b} must carry z-momentum");
        }
        // Completeness: every direction with e_y != 0 appears in exactly one
        // y-pair; same for e_z.
        for i in 0..19 {
            let in_y = Y_WALL_PAIRS.iter().any(|&(a, b)| a == i || b == i);
            assert_eq!(in_y, EY[i] != 0, "dir {i} y-pair membership");
            let in_z = Z_WALL_PAIRS.iter().any(|&(a, b)| a == i || b == i);
            assert_eq!(in_z, EZ[i] != 0, "dir {i} z-pair membership");
        }
    }

    #[test]
    fn inlet_is_velocity_clamped() {
        let mut s = test_state(16, 8, 8, 0.05, 0.56);
        for _ in 0..100 {
            stream_and_collide(&mut s);
        }
        let n = s.nx * s.ny * s.nz;
        for z in 0..s.nz {
            for y in 0..s.ny {
                let c = idx(0, y, z, s.nx, s.ny);
                let (_, ux, uy, uz) = macroscopic(&s.f, n, c);
                assert!(
                    (ux - 0.05).abs() < 1e-6,
                    "inlet ux={ux} at (0,{y},{z}) deviates from 0.05 by >= 1e-6"
                );
                assert!(
                    uy.abs() < 1e-6 && uz.abs() < 1e-6,
                    "inlet transverse u=({uy},{uz}) at (0,{y},{z}) >= 1e-6"
                );
            }
        }
    }

    #[test]
    fn outlet_is_zero_gradient() {
        let mut s = test_state(16, 8, 8, 0.05, 0.56);
        for _ in 0..100 {
            stream_and_collide(&mut s);
        }
        let n = s.nx * s.ny * s.nz;
        let mut max_diff = 0.0f64;
        for z in 0..s.nz {
            for y in 0..s.ny {
                let dst = idx(s.nx - 1, y, z, s.nx, s.ny);
                let src = idx(s.nx - 2, y, z, s.nx, s.ny);
                for i in 0..19 {
                    let d = (s.f[i * n + dst] - s.f[i * n + src]).abs() as f64;
                    max_diff = max_diff.max(d);
                }
            }
        }
        assert!(
            max_diff < 1e-9,
            "outlet zero-gradient max diff {max_diff} >= 1e-9"
        );
    }

    #[test]
    fn free_slip_preserves_tangential_momentum() {
        // Shear-free uniform tangential flow (u_x = 0.05, tangential to the
        // y/z walls). Wall-adjacent (y == 1) tangential velocity must survive
        // 50 steps unchanged to < 1e-6 (specular property).
        let mut s = test_state(16, 8, 8, 0.05, 0.56);
        let n = s.nx * s.ny * s.nz;
        let mut initial = Vec::new();
        for z in 0..s.nz {
            for x in 0..s.nx {
                let c = idx(x, 1, z, s.nx, s.ny);
                let (_, ux, _, _) = macroscopic(&s.f, n, c);
                initial.push(ux);
            }
        }
        for _ in 0..50 {
            stream_and_collide(&mut s);
        }
        let mut k = 0usize;
        let mut max_dev = 0.0f64;
        for z in 0..s.nz {
            for x in 0..s.nx {
                let c = idx(x, 1, z, s.nx, s.ny);
                let (_, ux, _, _) = macroscopic(&s.f, n, c);
                max_dev = max_dev.max((ux - initial[k]).abs());
                k += 1;
            }
        }
        assert!(
            max_dev < 1e-6,
            "wall-adjacent tangential drift {max_dev} >= 1e-6"
        );
    }

    #[test]
    fn no_flow_through_solid() {
        // 32×16×16 + F006-style 4³ block; total mass Σρ must change < 0.5 %
        // over 500 steps with BCs on (bounce-back verified by construction).
        let (nx, ny, nz) = (32usize, 16usize, 16usize);
        let mut s = test_state(nx, ny, nz, 0.05, 0.56);
        place_box(&mut s, 10, 14, 6, 10, 6, 10);
        let m0 = total_mass(&s);
        for _ in 0..500 {
            stream_and_collide(&mut s);
        }
        let m1 = total_mass(&s);
        assert!(m0.is_finite() && m1.is_finite(), "non-finite mass {m0} → {m1}");
        let rel = ((m1 - m0) / m0).abs();
        assert!(rel < 0.005, "relative mass change {rel} >= 0.5 % ({m0} → {m1})");
    }

    #[test]
    fn wake_exists_downstream_of_cube() {
        // Default 128×48×48 grid, 8³ cube at the placement center,
        // u_inlet = 0.08, τ = 0.56, 1000 steps.
        let (nx, ny, nz) = (128usize, 48usize, 48usize);
        let mut s = test_state(nx, ny, nz, 0.08, 0.56);
        place_center_cube(&mut s);
        for _ in 0..1000 {
            stream_and_collide(&mut s);
        }
        let n = nx * ny * nz;
        let cx = (0.35 * nx as f64) as usize;
        let cy = ny / 2;
        let cz = nz / 2;
        // 8×8×8 sampling box directly behind the cube.
        let (sx0, sx1) = (cx + 4, cx + 12);
        let (sy0, sy1) = (cy - 4, cy + 4);
        let (sz0, sz1) = (cz - 4, cz + 4);
        let mut sum_ux = 0.0f64;
        let mut count = 0usize;
        let mut max_transverse = 0.0f64;
        let mut any_nan = false;
        for z in sz0..sz1 {
            for y in sy0..sy1 {
                for x in sx0..sx1 {
                    let c = x + nx * (y + ny * z);
                    if s.occupancy[c] != 0 {
                        continue;
                    }
                    let (rho, ux, uy, uz) = macroscopic(&s.f, n, c);
                    if !rho.is_finite() || !ux.is_finite() || !uy.is_finite() || !uz.is_finite() {
                        any_nan = true;
                        continue;
                    }
                    sum_ux += ux;
                    count += 1;
                    max_transverse = max_transverse.max(uy.abs() + uz.abs());
                }
            }
        }
        assert!(!any_nan, "NaN in wake sampling box");
        assert!(count > 0, "wake sampling box must contain fluid cells");
        let mean_ux = sum_ux / count as f64;
        assert!(
            mean_ux < 0.6 * 0.08,
            "wake mean ux={mean_ux} should be < 0.6 × 0.08 = 0.048"
        );
        assert!(
            max_transverse > 0.005,
            "wake max |uy|+|uz|={max_transverse} should exceed 0.005 (deflection)"
        );
    }

    #[test]
    fn steady_state_reached() {
        // Same cube case; relative change of Σρ over the last 1000 of 5000
        // steps must be < 1e-3.
        let (nx, ny, nz) = (128usize, 48usize, 48usize);
        let mut s = test_state(nx, ny, nz, 0.08, 0.56);
        place_center_cube(&mut s);
        for _ in 0..4000 {
            stream_and_collide(&mut s);
        }
        let m4000 = total_mass(&s);
        for _ in 0..1000 {
            stream_and_collide(&mut s);
        }
        let m5000 = total_mass(&s);
        assert!(m4000.is_finite() && m5000.is_finite(), "non-finite mass");
        let rel = ((m5000 - m4000) / m4000).abs();
        assert!(rel < 1e-3, "relative mass drift {rel} >= 1e-3 ({m4000} → {m5000})");
    }

    #[test]
    fn no_nan_after_long_run() {
        // No NaN after 10 000 steps at defaults with the cube (u = 0.05).
        let (nx, ny, nz) = (128usize, 48usize, 48usize);
        let mut s = test_state(nx, ny, nz, 0.05, 0.56);
        place_center_cube(&mut s);
        for _ in 0..10_000 {
            stream_and_collide(&mut s);
        }
        let n = nx * ny * nz;
        for c in 0..n {
            let (rho, ux, uy, uz) = macroscopic(&s.f, n, c);
            assert!(rho.is_finite() && rho > 0.0, "bad rho={rho} at cell {c}");
            assert!(
                ux.is_finite() && uy.is_finite() && uz.is_finite(),
                "non-finite u at cell {c}"
            );
        }
    }
}
