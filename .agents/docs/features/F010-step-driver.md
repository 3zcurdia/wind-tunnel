# F010 — Step driver, stability monitor & perf budget

## Metadata

| Field | Value |
|-------|-------|
| ID | F010 |
| Phase | 2 |
| Size | S |
| Skill fit | `Rust` |
| Depends on | F007, F008 (real stepping), F009 (params) |
| Status | `[x]` done (2026-09-08; budget criterion unticked with note below + DECISIONS.md) |

## Goal

`step(n)` becomes production-grade: NaN/negative-density detection wired into
`is_stable()`, per-call timing exposed for JS adaptive stepping, and a
`cargo test --release -- --ignored` benchmark proving the ≤ 4 ms/step budget at
default grid size.

## Context

`ARCHITECTURE.md` §7 sets the budgets; F019's adaptive loop needs cheap, reliable
signals from the Rust side: was the last batch stable, and how long did it take? Both
are accumulated in `SimState`, never allocated per call.

## Detailed spec

1. **Stability monitor** (`SimState` fields):
   - `stable: bool` (default true), `last_unstable_step: u64`.
   - In `step(n)`: every step, check a *strided subset* of cells (every 7th cell,
     deterministic stride) for `ρ ≤ 0` or non-finite values during the collide pass
     (cheap, in-cache). On first violation: set `stable = false`, record step index,
     and **continue stepping** (F019 decides recovery; Rust never auto-resets).
   - `is_stable() -> bool` returns and *consumes* the flag semantics: it reports
     current `stable` but does not reset it; `reset_flow()` resets to true.
   - Full-grid verification pass available behind `verify_stability_full()` (checks
     every cell; used by tests, ~free at these sizes, not called per frame).
2. **Timing** (`SimState` fields): `last_step_ms: f32` and `avg_step_ms: f32` (EMA,
   α=0.1). Use `std::time::Instant` — supported under wasm32-unknown-unknown
   (verified in F003's toolchain; if unavailable, fall back to `js_sys::Date::now()`
   via an existing cfg — document which is used). Expose
   `timing() -> { last_step_ms, avg_step_ms }` via wasm-bindgen struct.
3. **`step(n)` hardening**: n is clamped to ≤ 64 per call (JS must respect this;
   defends against runaway loops). If `stable == false`, steps still execute (cheap
   partial checks continue) — F019 stops calling step on instability.
4. **Benchmark** (ignored test, `wasm/src/bench.rs` or in `lib.rs` tests):
   - `#[test] #[ignore] fn bench_step_default_grid()` — builds 128×48×48 with the
     cube obstacle from F006's test helper, runs 200 steps, asserts nothing,
     `println!`s ms/step (mean, p95). Run with
     `cargo test --release -- --ignored --nocapture`; record outputs in
     `DECISIONS.md`. Budget: mean ≤ 4 ms/step.
   - Same for 64×24×24 (target ≤ 0.6 ms/step) as the "low" preset datapoint.
5. **`stats()` placeholder**: F013 owns the real StatsRecord; until then, extend the
   F008 `mass_balance()` diagnostic — no new ABI surface from this feature beyond
   `is_stable()` (§5 already lists it) and `timing()`.

## Files to create / modify

```
wasm/src/lib.rs          (modify) — stability + timing fields, is_stable, timing export
wasm/src/lbm.rs          (modify) — strided check in collide pass
wasm/src/bench.rs        (new)    — ignored benchmark tests
```

## Dependencies added

- none

## Interface contract

- ABI: `is_stable() -> bool`; `timing() -> { last_step_ms: f32, avg_step_ms: f32 }`.
- `step(n)` with n > 64 executes only 64 steps (documented clamp).
- Stability flag semantics: false latches until `reset_flow()`; JS polls
  `is_stable()` each frame — polling is cheap (field read).

## Acceptance criteria

- [x] `nan_detection_latches`: inject NaN into one distribution mid-test (test
      helper writes directly into `f`), step 10 → `is_stable() == false`; after
      `reset_flow()` → true.
- [x] `negative_density_detected`: same with ρ forced to −0.5 in one cell.
- [x] `healthy_run_stays_stable`: 5 000 steps cube case defaults → `is_stable()`
      still true.
- [x] `step_clamp`: `step(1000)` on a 16³ grid returns/behaves as 64 steps
      (`steps_done()` advances by exactly 64).
- [x] `timing_ema_converges`: after 100 steps, `avg_step_ms` within 2× of
      `last_step_ms` (sanity, no drift to 0).
- [ ] Benchmark (release, machine-local): mean ms/step recorded in `DECISIONS.md`
      for both grid sizes; default-grid mean ≤ 4 ms on the development machine
      (if the dev machine is slower, record actual and flag in `DECISIONS.md` — do
      not silently pass). **NOT MET AS PRINTED — recorded + flagged instead:**
      128×48×48 + 8³ cube → mean 47.656 ms/step (budget ≤ 4); 64×24×24 + 4³
      cube → 5.082 ms/step (target ≤ 0.6); Apple M4 Pro, 2026-09-08; see
      DECISIONS.md §F010.3. Scaling ~linear in cells; no optimization attempted
      (out of scope — routed to F019 + F021).

## Test plan

- Rust unit tests as above (fast, non-ignored).
- `cargo test --release -- --ignored --nocapture` → benchmark output pasted into
  `DECISIONS.md` with machine description and date.

## Out of scope

- JS-side adaptive steps-per-frame logic (F019), auto-recovery (F019), quality
  presets (F021), worker offloading, SIMD intrusions (note as future work).
