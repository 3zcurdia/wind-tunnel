//! F010 release-mode step benchmarks (ignored by default).
//!
//! Run with `cargo test --release -- --ignored --nocapture` and record the
//! printed numbers in `.agents/docs/DECISIONS.md`. Asserts nothing; reports
//! mean/p95 wall ms per lattice step through the real ABI (`init_sim` →
//! `step(1)`), so the numbers are directly comparable to the
//! ARCHITECTURE.md §7 budgets (default 128×48×48 ≤ 4 ms/step, low 64×24×24
//! ≤ 0.6 ms/step). Debug builds are far slower — always use `--release`.

use crate::{init_sim, reset_flow, step};
use std::time::Instant;

/// 8³ (default grid) or 4³ (low grid) cube at the ARCH §3 placement center,
/// matching the F008/F010 test fixtures.
fn place_center_cube(nx: usize, ny: usize, nz: usize, half_edge: usize) {
    let cx = (0.35 * nx as f64) as usize;
    let (cy, cz) = (ny / 2, nz / 2);
    crate::STATE.with(|s| {
        let mut state = s.borrow_mut();
        for z in cz - half_edge..cz + half_edge {
            for y in cy - half_edge..cy + half_edge {
                for x in cx - half_edge..cx + half_edge {
                    state.occupancy[x + nx * (y + ny * z)] = 1;
                }
            }
        }
        state.solid_count = state.occupancy.iter().filter(|&&o| o != 0).count();
        crate::lbm::retune_solid_cells(&mut state, &[]);
    });
}

/// Time `reps` ABI `step(1)` calls after a short warmup; returns
/// `(mean_ms_per_step, p95_ms_per_step)`. Stack-allocated samples only.
fn bench_reps(nx: usize, ny: usize, nz: usize, half_edge: usize, reps: usize) -> (f64, f64) {
    init_sim(nx as u32, ny as u32, nz as u32, 0);
    place_center_cube(nx, ny, nz, half_edge);
    reset_flow();
    for _ in 0..5 {
        step(1);
    }
    let mut samples = [0.0f64; 512];
    assert!(reps <= samples.len(), "increase the sample buffer for reps");
    for k in 0..reps {
        let t0 = Instant::now();
        step(1);
        samples[k] = t0.elapsed().as_secs_f64() * 1000.0;
    }
    let mut sorted = samples;
    sorted[..reps].sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mean = samples[..reps].iter().sum::<f64>() / reps as f64;
    let p95 = sorted[((0.95 * reps as f64) as usize).min(reps - 1)];
    (mean, p95)
}

/// Default grid + cube, 200 steps. Budget: mean ≤ 4 ms/step.
#[test]
#[ignore]
fn bench_step_default_grid() {
    let (mean, p95) = bench_reps(128, 48, 48, 4, 200);
    println!("bench_step_default_grid: mean {mean:.3} ms/step, p95 {p95:.3} ms/step over 200 steps at 128x48x48 (+8^3 cube)");
}

/// Low-preset grid + scaled cube, 200 steps. Target: ≤ 0.6 ms/step.
#[test]
#[ignore]
fn bench_step_low_grid() {
    let (mean, p95) = bench_reps(64, 24, 24, 2, 200);
    println!("bench_step_low_grid: mean {mean:.3} ms/step, p95 {p95:.3} ms/step over 200 steps at 64x24x24 (+4^3 cube)");
}
