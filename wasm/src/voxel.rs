//! Mesh → obstacle voxel grid (F006).
//!
//! Algorithm module — intentionally `wasm_bindgen`-free (see CONVENTIONS.md).
//! Thin ABI exports live in `lib.rs`.
//!
//! Conventions (ARCHITECTURE.md §3):
//! - Cell `(x, y, z)` occupies `[x, x+1) × [y, y+1) × [z, z+1)` in domain space,
//!   i.e. box center `(x+0.5, y+0.5, z+0.5)` with half-extent `0.5`.
//! - Row-major indexing: `idx = x + nx * (y + ny * z)`.
//!
//! Pipeline:
//! 1. Surface rasterization — Akenine-Möller triangle-box overlap test over each
//!    triangle's clamped AABB voxel range (conservative; touching counts).
//! 2. Interior determination — BFS flood fill from all six domain faces over
//!    non-surface cells; unreached non-surface cells are interior.
//! 3. Leak fallback — if `interior < 0.05 × bbox_cell_volume` (bbox of surface
//!    cells), the mesh is assumed non-watertight: `surface_mode = true` and only
//!    surface cells are solid.

/// Row-major lattice index: `idx = x + nx * (y + ny * z)`.
#[inline]
pub fn grid_index(x: usize, y: usize, z: usize, nx: usize, ny: usize) -> usize {
    x + nx * (y + ny * z)
}

/// Output of [`voxelize`].
pub struct VoxelizationResult {
    /// Length `nx*ny*nz`; `1` = solid, `0` = fluid.
    pub occupancy: Vec<u8>,
    /// Total solid cells (`surface + interior`, or surface-only in fallback).
    pub solid_count: usize,
    /// Cells intersected by at least one triangle (diagnostic; asserted in tests).
    #[allow(dead_code)]
    pub surface_count: usize,
    /// Filled interior cells (0 when `surface_mode` is true; asserted in tests).
    #[allow(dead_code)]
    pub interior_count: usize,
    /// True when the mesh looked leaky and only the shell was kept.
    pub surface_mode: bool,
}

/// Rasterize a triangle soup (flat `[x0,y0,z0, x1,y1,z1, x2,y2,z2, …]`, domain
/// space) into an obstacle grid.
///
/// Malformed input (`triangles.len() % 9 != 0`, including the empty slice)
/// yields an all-fluid grid with `solid_count == 0` — never a panic. Triangles
/// containing non-finite coordinates are skipped individually. Deterministic:
/// same input always produces the same grid (input-order iteration only, no
/// hash-order dependence).
pub fn voxelize(nx: usize, ny: usize, nz: usize, triangles: &[f32]) -> VoxelizationResult {
    let total = nx.saturating_mul(ny).saturating_mul(nz);
    let empty = || VoxelizationResult {
        occupancy: vec![0u8; total],
        solid_count: 0,
        surface_count: 0,
        interior_count: 0,
        surface_mode: false,
    };
    if total == 0 || triangles.is_empty() || triangles.len() % 9 != 0 {
        return empty();
    }
    let tri_count = triangles.len() / 9;

    // ── Step 1 — surface rasterization ──────────────────────────────
    let mut is_surface = vec![false; total];
    for t in 0..tri_count {
        let base = t * 9;
        let v0 = [
            triangles[base],
            triangles[base + 1],
            triangles[base + 2],
        ];
        let v1 = [
            triangles[base + 3],
            triangles[base + 4],
            triangles[base + 5],
        ];
        let v2 = [
            triangles[base + 6],
            triangles[base + 7],
            triangles[base + 8],
        ];
        if !(v0.iter().chain(v1.iter()).chain(v2.iter()).all(|c| c.is_finite())) {
            continue; // skip NaN/inf triangles without poisoning the grid
        }
        let min_x = v0[0].min(v1[0]).min(v2[0]);
        let max_x = v0[0].max(v1[0]).max(v2[0]);
        let min_y = v0[1].min(v1[1]).min(v2[1]);
        let max_y = v0[1].max(v1[1]).max(v2[1]);
        let min_z = v0[2].min(v1[2]).min(v2[2]);
        let max_z = v0[2].max(v1[2]).max(v2[2]);

        let x0 = (min_x.floor() as i64).clamp(0, nx as i64 - 1);
        let x1 = (max_x.floor() as i64).clamp(0, nx as i64 - 1);
        let y0 = (min_y.floor() as i64).clamp(0, ny as i64 - 1);
        let y1 = (max_y.floor() as i64).clamp(0, ny as i64 - 1);
        let z0 = (min_z.floor() as i64).clamp(0, nz as i64 - 1);
        let z1 = (max_z.floor() as i64).clamp(0, nz as i64 - 1);
        if x0 > x1 || y0 > y1 || z0 > z1 {
            continue; // entirely outside the domain
        }
        for z in z0..=z1 {
            for y in y0..=y1 {
                for x in x0..=x1 {
                    let center = [x as f32 + 0.5, y as f32 + 0.5, z as f32 + 0.5];
                    if tri_box_overlap(center, [0.5, 0.5, 0.5], v0, v1, v2) {
                        let idx = grid_index(x as usize, y as usize, z as usize, nx, ny);
                        is_surface[idx] = true;
                    }
                }
            }
        }
    }
    let surface_count = is_surface.iter().filter(|&&s| s).count();

    // ── Step 2 — flood fill exterior from all six faces ─────────────
    let mut visited = vec![false; total];
    let mut queue: Vec<usize> = Vec::new();
    let mut push_seed = |idx: usize| {
        if !is_surface[idx] && !visited[idx] {
            visited[idx] = true;
            queue.push(idx);
        }
    };
    if nx > 0 && ny > 0 && nz > 0 {
        for y in 0..ny {
            for z in 0..nz {
                push_seed(grid_index(0, y, z, nx, ny));
                push_seed(grid_index(nx - 1, y, z, nx, ny));
            }
        }
        for x in 0..nx {
            for z in 0..nz {
                push_seed(grid_index(x, 0, z, nx, ny));
                push_seed(grid_index(x, ny - 1, z, nx, ny));
            }
        }
        for x in 0..nx {
            for y in 0..ny {
                push_seed(grid_index(x, y, 0, nx, ny));
                push_seed(grid_index(x, y, nz - 1, nx, ny));
            }
        }
    }
    let mut head = 0usize;
    while head < queue.len() {
        let idx = queue[head];
        head += 1;
        let z = idx / (nx * ny);
        let rem = idx % (nx * ny);
        let y = rem / nx;
        let x = rem % nx;
        // 6-neighbourhood
        if x > 0 {
            let n = idx - 1;
            if !is_surface[n] && !visited[n] {
                visited[n] = true;
                queue.push(n);
            }
        }
        if x + 1 < nx {
            let n = idx + 1;
            if !is_surface[n] && !visited[n] {
                visited[n] = true;
                queue.push(n);
            }
        }
        if y > 0 {
            let n = idx - nx;
            if !is_surface[n] && !visited[n] {
                visited[n] = true;
                queue.push(n);
            }
        }
        if y + 1 < ny {
            let n = idx + nx;
            if !is_surface[n] && !visited[n] {
                visited[n] = true;
                queue.push(n);
            }
        }
        let stride = nx * ny;
        if z > 0 {
            let n = idx - stride;
            if !is_surface[n] && !visited[n] {
                visited[n] = true;
                queue.push(n);
            }
        }
        if z + 1 < nz {
            let n = idx + stride;
            if !is_surface[n] && !visited[n] {
                visited[n] = true;
                queue.push(n);
            }
        }
    }

    // Model bbox from surface cells (for the leak heuristic).
    let mut bbox_min = [usize::MAX, usize::MAX, usize::MAX];
    let mut bbox_max = [0usize, 0usize, 0usize];
    let mut interior_count = 0usize;
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let idx = grid_index(x, y, z, nx, ny);
                if is_surface[idx] {
                    bbox_min[0] = bbox_min[0].min(x);
                    bbox_min[1] = bbox_min[1].min(y);
                    bbox_min[2] = bbox_min[2].min(z);
                    bbox_max[0] = bbox_max[0].max(x);
                    bbox_max[1] = bbox_max[1].max(y);
                    bbox_max[2] = bbox_max[2].max(z);
                } else if !visited[idx] {
                    interior_count += 1;
                }
            }
        }
    }

    // ── Documented leak rule (implement exactly this) ───────────────
    // A properly closed mesh yields interior ≥ 0.05 × bbox_cell_volume.
    // Otherwise assume leaky → surface cells only.
    let (occupancy, solid_count, final_interior, surface_mode) = if surface_count == 0 {
        (vec![0u8; total], 0, 0, false)
    } else {
        let bbox_volume = ((bbox_max[0] - bbox_min[0] + 1) as u64)
            * ((bbox_max[1] - bbox_min[1] + 1) as u64)
            * ((bbox_max[2] - bbox_min[2] + 1) as u64);
        let threshold = 0.05 * bbox_volume as f64;
        if (interior_count as f64) < threshold {
            let mut occ = vec![0u8; total];
            for (i, s) in is_surface.iter().enumerate() {
                if *s {
                    occ[i] = 1;
                }
            }
            (occ, surface_count, 0, true)
        } else {
            let mut occ = vec![0u8; total];
            let mut solid = 0usize;
            for idx in 0..total {
                if is_surface[idx] || !visited[idx] {
                    occ[idx] = 1;
                    solid += 1;
                }
            }
            (occ, solid, interior_count, false)
        }
    };

    VoxelizationResult {
        occupancy,
        solid_count,
        surface_count,
        interior_count: final_interior,
        surface_mode,
    }
}

/// Deduplicate triangle-soup vertices with `1e-6` tolerance.
///
/// Quantizes each coordinate at `1e-6`, sorts the keys and maps them back —
/// deterministic for identical input (no hash-iteration dependence). Returns a
/// flat `[x,y,z, …]` vertex list.
pub fn deduplicate_vertices(triangles: &[f32]) -> Vec<f32> {
    const QUANT: f64 = 1_000_000.0;
    if triangles.is_empty() || triangles.len() % 3 != 0 {
        return Vec::new();
    }
    let mut keys: Vec<(i64, i64, i64)> = Vec::with_capacity(triangles.len() / 3);
    for v in triangles.chunks_exact(3) {
        let qx = ((v[0] as f64) * QUANT).round() as i64;
        let qy = ((v[1] as f64) * QUANT).round() as i64;
        let qz = ((v[2] as f64) * QUANT).round() as i64;
        keys.push((qx, qy, qz));
    }
    keys.sort_unstable();
    keys.dedup();
    let mut out = Vec::with_capacity(keys.len() * 3);
    for (qx, qy, qz) in keys {
        out.push((qx as f64 / QUANT) as f32);
        out.push((qy as f64 / QUANT) as f32);
        out.push((qz as f64 / QUANT) as f32);
    }
    out
}

// ── Akenine-Möller triangle vs axis-aligned box ──────────────────────────
// Separating-axis test: 3 box normals (AABB pre-check) + triangle plane +
// 9 edge × box-axis cross products. Touching counts as overlap
// (conservative), matching the spec's "may mark extra cells".

#[inline]
fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn tri_box_overlap(
    box_center: [f32; 3],
    box_half: [f32; 3],
    in_v0: [f32; 3],
    in_v1: [f32; 3],
    in_v2: [f32; 3],
) -> bool {
    // Move so the box center is at the origin.
    let v0 = sub(in_v0, box_center);
    let v1 = sub(in_v1, box_center);
    let v2 = sub(in_v2, box_center);

    // Test the 3 box normals (AABB of the triangle vs the box).
    let (mut mn, mut mx) = (v0[0], v0[0]);
    mn = mn.min(v1[0]).min(v2[0]);
    mx = mx.max(v1[0]).max(v2[0]);
    if mn > box_half[0] || mx < -box_half[0] {
        return false;
    }
    (mn, mx) = (v0[1], v0[1]);
    mn = mn.min(v1[1]).min(v2[1]);
    mx = mx.max(v1[1]).max(v2[1]);
    if mn > box_half[1] || mx < -box_half[1] {
        return false;
    }
    (mn, mx) = (v0[2], v0[2]);
    mn = mn.min(v1[2]).min(v2[2]);
    mx = mx.max(v1[2]).max(v2[2]);
    if mn > box_half[2] || mx < -box_half[2] {
        return false;
    }

    // Triangle edges.
    let e0 = sub(v1, v0);
    let e1 = sub(v2, v0);
    let e2 = sub(v0, v2); // third edge direction (v0 - v2)

    // 9 edge × coordinate-axis tests. For edge e, the axes are
    // e×(1,0,0) = (0, ez, -ey), e×(0,1,0) = (-ez, 0, ex),
    // e×(0,0,1) = (ey, -ex, 0). Project the triangle and the box
    // (radius r = Σ h_i·|L_i|) onto each axis.
    let edges = [e0, e1, e2];
    for e in edges {
        let axes = [
            [0.0, e[2], -e[1]],
            [-e[2], 0.0, e[0]],
            [e[1], -e[0], 0.0],
        ];
        for axis in axes {
            if axis[0] == 0.0 && axis[1] == 0.0 && axis[2] == 0.0 {
                continue; // degenerate edge parallel — no separating info
            }
            let p0 = dot(v0, axis);
            let p1 = dot(v1, axis);
            let p2 = dot(v2, axis);
            let mn = p0.min(p1).min(p2);
            let mx = p0.max(p1).max(p2);
            let r = box_half[0] * axis[0].abs()
                + box_half[1] * axis[1].abs()
                + box_half[2] * axis[2].abs();
            if mn > r || mx < -r {
                return false;
            }
        }
    }

    // Triangle-plane vs box. Skip when degenerate (zero-area triangle:
    // axis tests above already decided overlap).
    let n = cross(e0, e1);
    if dot(n, n) > 1e-20 {
        let d = -dot(n, v0);
        let mut vmin = [0.0f32; 3];
        let mut vmax = [0.0f32; 3];
        for q in 0..3 {
            if n[q] > 0.0 {
                vmin[q] = -box_half[q];
                vmax[q] = box_half[q];
            } else {
                vmin[q] = box_half[q];
                vmax[q] = -box_half[q];
            }
        }
        if dot(n, vmin) + d > 0.0 {
            return false;
        }
        if dot(n, vmax) + d < 0.0 {
            return false;
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    /// 12-triangle axis-aligned box soup spanning [lo, hi] on each axis.
    fn box_triangles(lo: f32, hi: f32) -> Vec<f32> {
        let c = [
            [lo, lo, lo],
            [hi, lo, lo],
            [hi, hi, lo],
            [lo, hi, lo],
            [lo, lo, hi],
            [hi, lo, hi],
            [hi, hi, hi],
            [lo, hi, hi],
        ];
        // Two triangles per face (winding irrelevant — overlap test is double-sided).
        let quads: [[usize; 4]; 6] = [
            [0, 1, 2, 3], // z = lo
            [4, 6, 5, 7], // placeholder, replaced below (z = hi)
            [0, 4, 5, 1], // y = lo
            [3, 2, 6, 7], // y = hi
            [0, 3, 7, 4], // x = lo
            [1, 5, 6, 2], // x = hi
        ];
        let faces: [[usize; 4]; 6] = [
            [0, 1, 2, 3],
            [4, 5, 6, 7],
            [0, 1, 5, 4],
            [3, 2, 6, 7],
            [0, 3, 7, 4],
            [1, 2, 6, 5],
        ];
        let _ = quads;
        let mut out = Vec::with_capacity(12 * 9);
        for f in faces {
            for tri in [[f[0], f[1], f[2]], [f[0], f[2], f[3]]] {
                for vi in tri {
                    out.extend_from_slice(&c[vi]);
                }
            }
        }
        out
    }

    /// UV sphere triangle soup. `skip_top` removes whole top ring bands
    /// (open-shell fixture): skips the top fan plus the first `skip_top - 1`
    /// quad bands, leaving a wide pole hole that must leak.
    fn sphere_triangles(
        cx: f32,
        cy: f32,
        cz: f32,
        r: f32,
        stacks: usize,
        slices: usize,
        skip_top: usize,
    ) -> Vec<f32> {
        let pt = |stack: usize, slice: usize| -> [f32; 3] {
            let phi = PI * stack as f32 / stacks as f32;
            let theta = 2.0 * PI * slice as f32 / slices as f32;
            [
                cx + r * phi.sin() * theta.cos(),
                cy + r * phi.sin() * theta.sin(),
                cz + r * phi.cos(),
            ]
        };
        let mut out = Vec::new();
        // Top fan (stack 0 = north pole).
        if skip_top == 0 {
            let pole = [cx, cy, cz + r];
            for j in 0..slices {
                let a = pt(1, j);
                let b = pt(1, (j + 1) % slices);
                out.extend_from_slice(&pole);
                out.extend_from_slice(&a);
                out.extend_from_slice(&b);
            }
        }
        let first_band = if skip_top == 0 { 1 } else { skip_top };
        for i in first_band..stacks - 1 {
            for j in 0..slices {
                let j1 = (j + 1) % slices;
                let a = pt(i, j);
                let b = pt(i, j1);
                let c2 = pt(i + 1, j);
                let d = pt(i + 1, j1);
                out.extend_from_slice(&a);
                out.extend_from_slice(&c2);
                out.extend_from_slice(&b);
                out.extend_from_slice(&b);
                out.extend_from_slice(&c2);
                out.extend_from_slice(&d);
            }
        }
        // Bottom fan (stacks = south pole).
        {
            let pole = [cx, cy, cz - r];
            let last = stacks - 1;
            for j in 0..slices {
                let a = pt(last, j);
                let b = pt(last, (j + 1) % slices);
                out.extend_from_slice(&pole);
                out.extend_from_slice(&b);
                out.extend_from_slice(&a);
            }
        }
        out
    }

    #[test]
    fn empty_grid_has_no_solids() {
        let res = voxelize(16, 16, 16, &[]);
        assert_eq!(res.solid_count, 0);
        assert_eq!(res.surface_mode, false);
        assert!(res.occupancy.iter().all(|&c| c == 0));
    }

    #[test]
    fn axis_aligned_box_produces_expected_solid_count() {
        let tris = box_triangles(10.0, 14.0);
        let res = voxelize(32, 32, 32, &tris);
        assert!(
            (90..=160).contains(&res.solid_count),
            "box solid count {} not in [90, 160]",
            res.solid_count
        );
        assert_eq!(res.surface_mode, false);
        // All occupied cells lie within the expected bbox (allow a 1-cell
        // conservative margin around [10..14]).
        for z in 0..32 {
            for y in 0..32 {
                for x in 0..32 {
                    if res.occupancy[grid_index(x, y, z, 32, 32)] == 1 {
                        assert!(
                            (9..=15).contains(&(x as i32))
                                && (9..=15).contains(&(y as i32))
                                && (9..=15).contains(&(z as i32)),
                            "solid cell ({x},{y},{z}) outside expected bbox"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn sphere_volume_within_tolerance() {
        let tris = sphere_triangles(24.0, 24.0, 24.0, 12.0, 24, 48, 0);
        let res = voxelize(48, 48, 48, &tris);
        let analytic = (4.0 / 3.0) * PI * 12.0f32.powi(3);
        let lo = 0.6 * analytic;
        let hi = 1.3 * analytic;
        assert!(
            res.solid_count as f32 >= lo && res.solid_count as f32 <= hi,
            "sphere solid count {} not in [{lo:.0}, {hi:.0}] (analytic {analytic:.0})",
            res.solid_count
        );
        assert_eq!(res.surface_mode, false);
    }

    #[test]
    fn open_shell_falls_back_to_surface_mode() {
        let closed = sphere_triangles(24.0, 24.0, 24.0, 12.0, 24, 48, 0);
        let open = sphere_triangles(24.0, 24.0, 24.0, 12.0, 24, 48, 3);
        assert!(open.len() < closed.len(), "open fixture must drop triangles");
        let res_closed = voxelize(48, 48, 48, &closed);
        let res = voxelize(48, 48, 48, &open);
        assert_eq!(res.surface_mode, true, "open shell must trigger fallback");
        assert_eq!(res.interior_count, 0);
        // Solid ≈ shell voxel count: well below the filled volume but nontrivial.
        assert!(
            res.solid_count > 500,
            "open shell solid count {} suspiciously small",
            res.solid_count
        );
        assert!(
            res.solid_count < res_closed.solid_count,
            "open shell {} should be smaller than closed {}",
            res.solid_count,
            res_closed.solid_count
        );
    }

    #[test]
    fn malformed_input_returns_zero() {
        // Length not divisible by 9.
        let res = voxelize(16, 16, 16, &[1.0, 2.0, 3.0, 4.0]);
        assert_eq!(res.solid_count, 0);
        assert!(res.occupancy.iter().all(|&c| c == 0));
        // Empty array.
        let res = voxelize(16, 16, 16, &[]);
        assert_eq!(res.solid_count, 0);
    }
}
