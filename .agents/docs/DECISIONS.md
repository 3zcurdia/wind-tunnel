# Decisions & Conflict Log

Dated notes recorded when a feature spec conflicted with code/tooling reality, per
`CONVENTIONS.md`. Each entry states the conflict and the smallest change chosen to
stay consistent with `ARCHITECTURE.md`.

---

## 2026-09-08 — F017 (live stats panel)

Headless probes below drive the real `--target web` artifact via `initSync`
(F014/F016 pattern), default physical conditions
(`set_conditions(15, 101.325, 1.81e-5, 1.0, 0.25)` → `u ≈ 0.0737`,
`τ = 0.505` floor-clamped, `unstable: true`, `Re = 249472`), `step(1)` +
`advect_particles(1.0)` per step. All numbers Apple M4 Pro, Node 26.8.1.

1. **Acceptance criterion 1's operating point ("cube + defaults → plausible
   cd after 200+ steps") is unachievable — the run is always unstable by
   then.** Both the 20³ cube ([35..55)×[14..34)²) and the F014 8³ fixture
   ([40..48)×[20..28)²) flip `stable=false` between 60 and 200 steps; by 200
   steps `cd`/`drag_n` are finite garbage (`3.1e35` for 8³, `4.3e35` for
   20³), vertex pressures/anchors zero out (the refresh bails), and particles
   die off (8³: 2000 → 43 alive by 500 steps; 20³: → 16). Cause is the
   documented F009 §2 regime (`τ = 0.505` floor, `Re_lat ≈ 1000` unsteady
   territory — F013's stable numbers used pinned `(0.08, 0.56)` for exactly
   this reason), not a panel bug. Smallest consistent action: implement the
   panel spec-verbatim (sentinel → "—", stats rendered as-is, UNSTABLE badge
   on `stable=false` — no extra magnitude guards, which would deviate from
   the spec and steal F013's cd semantics), leave the "plausible cd" half of
   criterion 1 unticked, and route recovery to F019 (the roadmap risk
   register already assigns "auto-throttle + soft restart" there). The
   UNSTABLE half of the criterion is trivially satisfiable — verified at the
   wasm level; the red pulsing badge itself needs a browser.
2. **Empty tunnel is stable indefinitely** (no mesh: `stable=true` at 200 /
   500 / 1000 steps, `cd` stays `−1`, all 2000 particles alive) — so the
   spec's empty state (placeholders + gray badge, driven by "no model")
   never shows garbage. Verified to 1000 steps.
3. **kPa criterion holds only transiently pre-divergence.** `q_ref` is exact:
   135.46 Pa = 0.135 kPa (`½·1.2041·15²`). 20³ cube at 60 steps (still
   stable): `p_max = 173.8 Pa` = 0.17 kPa, ratio to q 1.28 — inside the
   ±30 % band; but there is no *stable developed* state at defaults, and the
   8³ cube at 60 steps reads `p_max = 32 Pa` (field not yet developed) before
   blowing up. Criterion left unticked with this note.
4. **Panel renders finite-garbage `cd` (~40 chars) once unstable — accepted,
   not guarded.** Clamping absurd-but-finite magnitudes to "—" would be a
   silent spec deviation (`formatCd` only maps the contracted
   null/`−1`/non-finite cases); the red pulsing UNSTABLE badge next to it is
   the designed signal, and the bar's `truncate` + `overflow-x-auto` contain
   the width. F019's auto-recovery removes the condition.
5. **`steps_done()` advances exactly** (60/200/500/1000 on the nose), so the
   bridge's steps/s-from-delta mapping is sound; `fps` comes from the
   JS-side rAF ticker (browser check outstanding — headless has no rAF).

Observed values: `q_ref = 135.46 Pa`; 20³ @60: `p ∈ [−240.9, 173.8] Pa`,
`cd = −1`, `stable=true`; 8³ @60: `p ∈ [−128.5, 32.0] Pa`; 8³ @1000:
`cd = 4.97e38`, `stable=false`, 3 particles alive; empty @1000:
`stable=true`, `cd = −1`, 2000 alive; `step(1)` mean 48.8 ms (matches the
F010 47.7 ms datapoint).

---

## 2026-09-08 — F016 (smoke tracer lines)

1. **Smoke `dt` is 1.0 lattice time unit per step, not `LatticeParams.dt`.**
   The spec's driver note ("dt = current lattice dt from F009 params — the
   bridge supplies it") reads as the `dt` field of `LatticeParams`, but that
   field is physical seconds per lattice step (~3.84e-05 s at the 15 m/s
   default; see `wasm/src/lib.rs::get_lattice_params`). Using it for the
   lattice-space integration `p += v·dt` (v in lattice units, p in cells)
   would move tracers ~4e-6 cells/frame — visibly frozen, failing the
   wrap-around criterion. Smallest consistent reading: the lattice time step
   is definitionally 1 per LBM step, so the bridge supplies
   `SMOKE_DT_LATTICE = 1.0`, matching the particle driver's fixed
   `advect_particles(1.0)` cadence (1 step/frame until F019 owns timing).
   `SmokeTracers.update(dt, …)` stays agnostic — F019 can pass any dt later.

Observed values (headless, Node 26.8.1, real `--target nodejs` artifact,
128×48×48 + 8³ cube at [40..48)×[20..28)², F012 stable point (0.08, 0.56),
25 tracers × 90 history): 240 developed steps + 600 frames, `stable == true`
throughout; 0 non-finite, 0 inside the solid core; mean x 2.0 → 45.7,
y-spread 16 → 21.7; 13/13 center-line tracers wrapped, 4 stalled at the face;
per-frame `sample_velocity_batch` (25 pts) 0.016 ms + `SmokeTracers.update`
0.027 ms — far inside the ≤ 2 ms budget. Unit suite
`node --test src/lib/viz/SmokeTracers.test.mjs` 11/11 pass.

---

## 2026-09-08 — F015 (surface pressure heatmap)

1. **Vertex-pressure order is deduped+sorted, not display order — `attach()`
   rebuilds the index map locally (no ABI change).** The spec's
   `HeatmapOverlay.update(pressure, …)` reads as pressure[i] ↔ color-vertex i
   1:1, but F012 fills the buffer in F006's deduplicated, sorted vertex order
   (see §F012.1 above) while the displayed mesh keeps loader/soup order
   (`showModel` clones order-preservingly). Naive index mapping would permute
   a smooth field into speckle and fail the red-upstream-pole criterion. The
   bridge cannot supply the map (it discards the soup after `set_mesh`, and
   the two pipeline passes complete asynchronously), and ARCH §5 forbids new
   exports without an ARCH update — so `attach(geometry)` replicates F006's
   `quantize(1e-6) → sort → dedup` on lattice positions recovered from the
   world mesh by inverting `showModel`'s transform (uniform scale + offset is
   axis-monotonic, hence order-preserving). Rounding replication is exact
   (`Math.sign(v)·Math.round(|v|)` matches Rust's half-away-from-zero
   `f64::round`; f32→f64 is exact); the residual is f32 round-trip noise
   (~1e-6 vs the 1e-6 quantum), which can only reorder vertices within ~2e-6
   cells of each other — coincident pixels, visually harmless. Out-of-range
   lookups (count drift) and non-finite pressures both map to t = 0.5
   (mid-gray), satisfying the unmapped-vertex and model-swap criteria.
2. **`SceneManager.getModelGeometry()` added (additive getter).** The driver
   must reach the displayed geometry for `attach()`; poking at
   `getLayer('meshModel').children` would break SceneManager's encapsulation.
   `setModelVertexColors(on)` is exactly per spec (no-op without a model).
3. **Per-frame `pressure_anchors()` must be `.free()`d.** The generated
   `PressureAnchors` is a wasm-bindgen class (heap-allocated per call), not a
   plain struct — the F012 probe leaks one per click (fixed with a
   try/finally in the same edit; `voxelBridge.ts` is in this feature's file
   list). The heatmap driver reads + frees every frame, so steady-state holds
   no wasm objects.
4. **Heatmap defaults ON; toggle + legend live in `page.tsx` (Controls rail).**
   `PressureLegend` keeps exactly the spec'd props `{ pMinPa, pMaxPa, qRefPa }`
   (no wasm imports); the checkbox is a sibling in `page.tsx` so the contract
   stays verbatim. F019 relocates both per the spec's TEMPORARY notes.

---

## 2026-09-08 — F014 (particle streamlines)

All numbers below measured headless with Node v26.8.1 against the real
`--target web` wasm artifact (128×48×48 + 8³ cube at [40..48)×[20..28)² unless
noted) and the transpiled `ParticleSystem` (three.js needs no DOM for
`BufferGeometry`/`Points`, so `update()` timing is genuine V8 work).

1. **WASM pool capacity 60k → 100k (slider max needs it).** `voxelBridge`'s
   `ensureEngine` allocated `init_sim(…, 60000)` (F006 era), but F014 §3 fixes
   the count slider at 5k–100k and routes changes to `spawn_particles(n)` —
   targets above 60k would silently clamp to the pool capacity. Smallest
   consistent change, inside the listed `voxelBridge.ts`: allocate 100k
   (`PARTICLE_CAPACITY`, shared with the driver's `ParticleSystem` so views
   and attributes always agree). Cost is ~1.6 MB of pool memory; `runSmokeProbe`
   behavior is unchanged (still spawns 2 000).
2. **Monotonic-red hint vs exact stops (test-plan imprecision).** The Test plan
   suggests asserting a "monotonic red channel across t on speedColor", but the
   normative §1 stops are not red-monotonic end to end (blue→cyan dips red
   29→6; amber→red dips 245→220). The §1 hex stops win; the test asserts exact
   hex at every stop, clamping, and red monotonicity on the genuinely
   monotonic cyan→amber span [0.25, 0.75] (6→229→245), with the rationale in a
   comment.
3. **Frame budget: `update()` fits its ≤ 2 ms budget, the fixed 1 step/frame
   driver cannot hold 60 fps on this machine — criterion unticked, F019/F021
   own the fix (F010 pattern).** `ParticleSystem.update` @100k: mean 0.41 ms
   (positions-only 0.02 ms, color frames 0.96 ms). But the spec'd temporary
   cadence (`step(1)` + `advect_particles(1.0)` per frame) costs `step(1)` ≈
   54.1 ms + advect ≈ 6.2 ms @30k (≈ 20 ms extrapolated @100k) — a ~65 ms+
   frame before rendering, i.e. ~15 fps sustained, on Apple M4 Pro silicon.
   No deviation attempted (adaptive steps-per-frame is F019's job, presets are
   F021's); the 55+ fps slider criterion is left unticked for a browser check
   after those land.
4. **Upstream renders amber, not white, under the spec'd 1.3 headroom
   (expectation wording, not a code change).** `speedNorm = [0, 1.3·u_inlet]`
   puts the freestream at t ≈ 1/1.3 ≈ 0.77 → amber-orange (measured
   (0.953, 0.583, 0.051)); the white band sits at ≈ 0.65·u_inlet (mildly
   slowed flow) and the wake at t ≈ 0.15 renders blue (measured
   (0.058, 0.557, 0.837)). The Detailed-spec formula is implemented verbatim
   (1.3 documented in `ParticleSystem.update`); the criterion's "≈ white" is
   read as qualitative (warm freestream, blue wake).
5. **Headless proxy for the visual criteria (browser checks outstanding).**
   30k particles, 60 steps + advect around the cube: 0 non-finite positions,
   0 non-finite speeds, mean speed 0.0703 ≈ u_inlet 0.0737, **0 live particles
   inside solid cells** (checked against the `occupancy_ptr` snapshot), and
   `respawn(2000)` refills exactly; `stable == true` throughout. Left→right
   transit itself needs ~1 800 steps at u ≈ 0.07 (F011 already proved
   transit); the visual split/acceleration and the voxel cross-check need a
   browser. Node-level disposal is verified (`Points` removed from the layer,
   `dispose()` idempotent); the `renderer.info.memory` baseline check needs a
   browser.

Observed values: `step(1)` 54.12 ms; `advect_particles` 6.23 ms @30k;
`update()` 0.41 ms @100k; u_lattice 0.073729, τ 0.505 (default operating
point); cube 729 solids, surface_mode false; freestream color
(0.953, 0.583, 0.051), wake color (0.058, 0.557, 0.837).

## 2026-09-08 — F013 (drag coefficient & flow stats)

Fixture for everything below: 128×48×48, `(u_inlet, τ) = (0.08, 0.56)`
(`Re_lat ≈ 96` steady — the F012 operating point, pinned directly rather
than via `set_conditions`, whose real-air clamp lands on `τ = 0.505` /
`Re_lat ≈ 1000` unsteady territory — see F009 §2), default-air physical
companions (`U = 15 m/s`, `ρ = 1.2041183`, `Δx = 1/128`,
`Δt = u·Δx/U = 4.1667e-05`). Analytic occupancy (ball r = 12 at the §3
placement center; 20³ face-on cube at the same center) with a stood-in
vertex list (only zero-vs-nonzero matters to `stats()`). All numbers
`cargo test --release` on Apple M4 Pro; one 3 000-step run ≈ 130 s.

1. **Force conversion: `Δx⁴`, not the spec's printed `Δx³` (dimensional
   fix).** `ρ·Δx³/Δt²` is kg/s² = N/m (force per unit length); one lattice
   force unit is `mass·length/time²` with `mass_unit = ρ·Δx³`, i.e.
   `ρ·Δx⁴/Δt²` — the pressure path confirms it (F009's Pa unit is
   `ρ·Δx²/Δt²`; force = pressure × area adds the second `Δx²`). The printed
   form over-reports `Cd` by `1/Δx` (128× at defaults: the sphere would read
   `Cd ≈ 430`). Implemented `F_phys = F_lat·ρ·Δx⁴/Δt²`
   (`cd = 2·F_lat·Δx²/(frontal·U²·Δt²)`, `ρ` cancels); `stats.rs` module docs
   carry the derivation.
2. **Fresh-state `cd` reads `−1.0`, not `0.0` ("all zeros" wording).** The
   spec's `stats_before_mesh_is_zeroed` ("fresh → all zeros") collides with
   its own sentinel rule (`−1.0` when fewer than 200 steps elapsed **or** no
   mesh — a fresh state satisfies both). Smallest consistent reading: every
   physical accumulator is `0.0` with `stable == true`, while `cd` carries
   the sentinel (a fresh panel should show "—", not "0.00"). The test
   asserts exactly that.
3. **Cd brackets exceeded — observed envelopes pinned, spec boxes unticked
   (F009/F012 pattern).** Sphere: observed `Cd = 3.3737` (`F_ema = 4.8365`,
   frontal 448, `drag_n = 12.50 N`) vs printed cap 3.0. Cube: observed
   `Cd = 4.4676` (`F_ema = 5.7186`, frontal 400, `drag_n = 14.78 N`) vs
   printed cap 2.2. The momentum-exchange hook is faithful (spec formula,
   pre-bounce snapshot; the mass books close — item 4), so these are the
   solver's genuine confined-flow answers: 17–20 % blockage in the default
   48×48 cross-section, laminar `Re_lat ≈ 80–96` (literature cube ≈ 1.05 and
   sphere ≈ 0.4 live at unconfined high Re — the physical `Re ≈ 2.5e5` is
   unreachable in the τ envelope, see F009 §2), plus staircase bounce-back
   error. The tests assert the observed envelopes (sphere `[0.35, 3.8]`,
   cube `[0.8, 5.0]` — lower bounds kept) plus `cd > 3.0` / `cd > 2.2` pins
   that fail loudly if a future solver change (curved BCs, finer grids,
   blockage correction) brings `Cd` inside the printed caps.
4. **Mass closes — the flow is healthy.** 20³ cube, 5 000 steps:
   `mass_in = 846400.0`, `mass_out = 823329.9`, relative gap 2.73 % (< 5 %).
   `drag_n` sphere steady-state 12.50 N ∈ (0, 50) ✓.
5. **`lbm.rs` untouched (file-list discipline).** The EMA update lives in
   `boundaries::apply_all` (which owns the bounce-back sum), and the
   drag/silhouette resets ride the `lib.rs` wrappers (`set_mesh` /
   `clear_mesh` / `reset_flow` call `stats::on_new_mesh` /
   `on_mesh_cleared` / `on_flow_reset`). In-process tests mirror the ABI
   `step()` counter (`steps += 1` per `stream_and_collide` — the kernel
   never touches it) and skip the pressure refresh (drag/mass assertions
   don't need it).

Observed values: sphere `Cd = 3.3737`, `drag_n = 12.4963 N`; cube
`Cd = 4.4676`, `drag_n = 14.7754 N`; mass `in = 846400.0`,
`out = 823329.9` (rel 0.0273); sentinel exact `−1.0` at 50 steps;
degenerate (footprintless) mesh `cd = drag_n = 0.0`, stable.

---

## 2026-09-08 — F012 (surface pressure → per-vertex scalars)

Fixture for everything below: 128×48×48, analytic ball fill r = 12 at the §3
placement center (44, 24, 24), 802 Fibonacci-sphere + exact-pole vertices,
u_inlet = 0.08, τ = 0.56 (Re_lat ≈ 96, steady), U = 15 m/s, ρ = 1.2041183,
Δx = 1/128, Δt = u·Δx/U = 4.1667e-05, 2 000 steps with one `refresh` per
64-step batch + a final refresh (mirrors `step(64)` batching). All numbers
`cargo test --release` on Apple M4 Pro; one 2 000-step run ≈ 80 s.

1. **Vertex order follows F006's stored (deduplicated, sorted) list, not the
   raw triangle-soup order.** The spec's interface contract says "order
   identical to the vertices JS sent", but F006 stores `deduplicate_vertices`
   output (quantized, sorted, deduped) and F012 §1 maps "each stored vertex".
   Mapping over soup order would duplicate work and contradict §1, so the
   buffer follows the stored order (documented in `pressure.rs` module docs).
2. **`vertex_pressure_len() -> u32` added (ARCH §5 updated in the same
   commit, as the spec instructs).** ARCH §5 listed `vertex_pressure_ptr()`
   with "length == vertex_count" but no accessor; JS cannot infer the
   *deduped* count from the soup it sent, so a `u32` length export (same shape
   as `occupancy_len()`) is the smallest consistent addition. `pressure_anchors()`
   likewise added to §5 with its `{ p_min_pa, p_max_pa, q_ref_pa }` fields.
3. **Buried-vertex test uses an analytic solid box, not the voxelized star.**
   The genuine star (octahedron shell + center fan) leaks at 32³
   (`surface_mode = true`, shell-only — F006 rasterization fidelity, not F012
   logic), so its interior is fluid and cannot host a buried vertex. Per the
   spec's own test-plan advice (analytic fills over mesh rasterization), the
   test pairs the real star *vertex set* (dedup → shell + buried center) with
   an analytic box [10..22)³: the center is ≥ 6 cells deep (⇒ unmapped → 0.0,
   finite, no panic) while the ±8 shell vertices stick out into fluid (⇒
   mapped) — both code paths in one cheap test.
4. **Stagnation magnitude: observed Cp_max ≈ 1.60, above the spec's 1.4 cap —
   criterion unticked, test pins reality (F009 pattern).** At the fixture
   above: p_max = 217.28 Pa vs q_ref = 135.46 Pa (ratio 1.604), max vertex
   (32.2, 25.0, 25.8) just 9.6° off the −X pole (the 30° half passes with
   20° margin). The overshoot is the solver's genuine coarse-staircase answer
   (verified: the mapped cell holds ρ ≈ 1.0151 vs Bernoulli 1.0096 — a field
   property, not a conversion bug). Operating-point scan: (0.05, 0.6) →
   2.0×, (0.08, 0.8) → 2.4× — raising τ *worsens* the spike (bounce-back wall
   error grows with (τ−½)²), while dropping τ toward 0.505 pushes Re_lat past
   shedding onset (~270) into unsteady, snapshot-fragile territory. So 1.4 is
   unreachable at any steady, accurate operating point. The test asserts the
   observed envelope [0.7, 1.8]×q plus a `ratio > 1.4` pin that fails loudly
   if a future solver change (curved BCs, finer grids) brings the max inside
   the printed cap.
5. **Wake-min location: the literal transverse (±y/±z) reading adopted; the
   x > cx half unticked, test pins reality (F009 pattern).** Observed min:
   p_min = −175.97 Pa (−1.30×q) at (41.6, 25.0, 35.7) — classical shoulder
   suction (~78° from the front stagnation point at Re ≈ 96), 12.9° off the
   +Z axis (the 45° transverse half passes with 30° margin) but 2.4 cells
   *upstream* of the equator plane (x = cx − 2.4). A min on the downstream
   centerline is physically out of reach for steady sphere flow (base pressure
   ≈ −0.5…−0.7×q, measured −72…−98 Pa at the rear pole — always the highest
   of the lows, never the global min), so the "+X axis" alternative reading
   would demand the impossible; the "±z/±y" wording is read literally as the
   transverse axes. Higher-τ scans do push the peak past the equator
   (x = 45.2 at τ = 0.6/0.8) but wreck stagnation (item 4) — no single steady
   operating point satisfies both printed halves. The test asserts transverse
   ≤ 45° + shoulder-away-from-stagnation (> 45° from −X) + suction depth
   (< −0.5×q) exactly, documents the equator band (x > cx − 3), and pins
   `x ≤ cx` for loud future review.
6. **Anchors: `p_min ≤ 0 ≤ p_max` + `q_ref = ½ρU²` exact (all pass);
   the `≤ 1.5×q_ref` cap shares item 4's fate** (observed 1.60×) — asserted
   against the same observed envelope with a pointer to item 4, box unticked.
7. **TEMPORARY probe sets default conditions.** `runSmokeProbe` previously ran
   with whatever lattice params were stored (and no physical companions ⇒
   zero anchors). It now calls `set_conditions(15, 101.325, 1.81e-5, 1.0,
   0.25)` before `reset_flow`, so the returned anchors carry physical
   magnitudes (q_ref ≈ 135.5 Pa at defaults, per the spec's manual check).
   Still deleted in F019.

Observed values: q_ref = 135.46 Pa; p_max = 217.28 Pa (1.604×q, 9.6° off
−X pole); p_min = −175.97 Pa (−1.299×q, 12.9° off +Z, x = cx − 2.4);
ρ̄ = 0.999707 vs domain mean 0.998946 (EMA lag after the start-up mass
transient — converges in continuous running); box ABI wiring (24×16×16, 10
steps): 8 deduped vertices, all pressures finite, q_ref > 0.

## 2026-09-07 — F003 (Rust→WASM pipeline)

1. **wasm-pack flags adapted.** The spec suggested
   `wasm-pack build wasm --target web --out-dir ../src/wasm --out-package windtunnel`,
   but wasm-pack 0.15.0 (installed via `brew install wasm-pack`) has no
   `--out-package` flag. The flag's intent (output named `windtunnel`) is already
   satisfied by the crate name, since output file names default to the package name.
   Working command, recorded as `npm run wasm:build` in `package.json`:
   `wasm-pack build wasm --target web --out-dir ../src/wasm`
   → emits `src/wasm/windtunnel.js`, `windtunnel.d.ts`, `windtunnel_bg.wasm`
   (importable as `@/wasm/windtunnel` via the `@/*` alias).

2. **Bundler check: primary path works, no fallback needed.** Next 16.3.4 production
   build (Turbopack) natively handles the wasm-bindgen `--target web` glue — the
   `new URL('windtunnel_bg.wasm', import.meta.url)` default path is emitted as a
   static asset under `.next/static/media/` and referenced from the lazy client
   chunk. Spec fallback plan (a) (external + `public/wasm/` + manual
   `instantiateStreaming` glue) was **not** implemented. The loader
   (`src/lib/sim/wasm.ts`) uses the plain dynamic `import("@/wasm/windtunnel")` +
   `await mod.default()` pattern; later Rust features should keep this shape.

3. **ESLint ignores `src/wasm/**`.** The generated wasm-bindgen glue triggers lint
   warnings (`@typescript-eslint/no-unused-vars` in the glue, unused
   `eslint-disable` directives in generated `.d.ts`). Generated files can't be
   hand-fixed (regenerated by every `npm run wasm:build`), and the DoD requires zero
   warnings — the same rationale as the spec's tsconfig-exclude escape hatch.
   Smallest change: added `"src/wasm/**"` to `globalIgnores` in `eslint.config.mjs`.
   `tsconfig.json` was **not** modified (the generated output type-checks cleanly
   through its generated `package.json` `types` field), and
   `src/lib/sim/wasm-types.d.ts` was not needed.

4. **`src/components/controls/.gitkeep` kept.** The F003 file list annotates it
   "(delete) — replaced by real files later; keep for now", which is self-contradictory.
   The explicit trailing instruction ("keep for now") wins over the "(delete)" marker;
   F004 removes it when the UploadPanel lands.

## 2026-09-07 — F004 (Upload UI)

1. **ROADMAP diagram vs spec dependencies (UI track order).** The ASCII dependency
   graph draws `F001 ─► F002 ─► F005 ─► F004`, implying F004 comes after F005 —
   but F004's spec says "Depends on F001" only, while F005's spec says
   "Depends on F002 (SceneManager), F004 (LoadedFile + context)". Both specs agree
   F004 comes first; only the diagram disagrees (likely a reversed arrow).
   Resolution: the specs' `Depends on` fields govern — F004 implemented before
   F005. Diagram left untouched (out of this feature's file list).
   Net effect: none on this change; F005 is unblocked next on the UI track.

2. **`ModelContext` carries a `reading` flag not in the spec's shape.** The spec's
   context shape (`file/status/error/setFile/clear`) has no loading indicator, but
   §4 requires a "Reading file…" spinner + disabled input while `arrayBuffer()` is
   in flight. Smallest additive change: exposed `reading: boolean` (and a `meta`
   stub for F005, as §4 requests). No contract removed; `useModel()` shape is a
   superset.

3. **Drop zone is a real `<button>`, not a `<div role="button">`.** §4 calls for a
   "`<button>`-like clickable area" that is focusable with Enter-to-browse.
   A native `<button type="button">` satisfies focus/keyboard/a11y without
   synthetic key handlers; drag handlers (`onDragOver/Leave/Drop`) attach to it
   directly. `aria-label="Upload 3D model file"` preserved.

4. **Removed `src/components/controls/.gitkeep`** per the F003 note above —
   the directory now holds `UploadPanel.tsx`.

## 2026-09-07 — F005 (Parse, display & normalize model)

1. **`ModelContext` gained `setMeta`/`setParseError` (file list omission).** The
   spec's pipeline (§4) must "set `meta { triangles, vertices }` in
   ModelContext" and "on parse error → set context error state", but the Files
   list omits `src/lib/sim/ModelContext.tsx` and F004's context exposes no
   setters. Smallest change consistent with ARCHITECTURE.md (context owns
   UI-agnostic upload state): added two stable setters — `setMeta(m)` (counts
   only, status untouched) and `setParseError(msg)` (status `"invalid"` + error,
   keeps `file` so the failing bytes stay inspectable, clears `meta`). No
   existing contract removed; `useModel()` shape is a superset, same pattern as
   F004's `reading` note above. Parse errors therefore reuse UploadPanel's
   existing invalid-state rendering, and the scene keeps the previous model
   (pipeline never calls `showModel` on failure).

2. **`page.tsx` became a Client Component to host the pipeline hook.** §4 + file
   list say "run pipeline hook" in `page.tsx`, but the page was a Server
   Component and hooks (plus `useModel`, which throws outside the provider)
   cannot run there or above `ModelProvider`. Smallest compliant change within
   the listed files: `"use client"` on `page.tsx` plus a null-rendering
   `ModelPipelineHost` child inside `<ModelProvider>` that calls
   `useModelPipeline()`. No new files; `ViewportMount`'s `ssr: false` dynamic
   import still sits under a Client Component, per the bundled Next guide.

3. **`UploadPanel.tsx` needed no edits.** F004 already renders `meta`
   counts ("—" when absent) and the `status === "invalid"` error state, which
   is exactly what §4/§5 of this spec asks the panel to show. File left
   untouched.

4. **Test-plan scale number is off for a 2-longest-side input.** The optional
   unit suggests a "synthetic 2×1×1 box → assert scale = 32", but the specified
   algorithm (longest side → 0.25·nx = 32 cells) gives scale = 32/2 = **16** for
   that input; scale = 32 holds for a unit (1×1×1) box. Algorithm implemented
   as specified; harness-verified: `BoxGeometry(2,1,1)` → scale 16,
   bbox center (44.8, 24, 24), longest side 32; `BoxGeometry(1,1,1)` →
   scale 32. Spec text left untouched (outside this feature's file list).

5. **`showModel` clones before the lattice→world transform.** The caller's
   domain-space geometry must survive for F006 voxelization, so `showModel`
   clones the input, maps the clone with `(lattice − (64,24,24)) · 0.1`, and
  leaves the passed geometry untouched (verified: input bbox unchanged after
  normalize + world mapping).

## 2026-09-07 — F006 (mesh → obstacle voxel grid)

1. **Debug cube edge is 0.09 world units, not the spec's literal 0.9.** The spec
   asks for `BoxGeometry(0.9, 0.9, 0.9)` with positions at
   `lattice × 0.1 − offset`, but ARCHITECTURE.md §3 fixes 1 cell = 0.1 world
   units — a 0.9-world cube would span 9 cells and bury the silhouette in one
   red blob. Smallest consistent change: 0.9 lattice units × 0.1 = **0.09**
   world (one slightly-gapped cube per cell), implemented in
   `VoxelDebugView.ts`. No spec text touched (outside this feature's list).

2. **`src/lib/sim/wasm.ts` grew beyond F006's file list (additive only).** The
   loader is the single ABI owner until `SimEngine` (F019), and its own header
   says the `WasmApi` type is "grown per feature" — `voxelBridge.ts` cannot
   call `init_sim`/`set_mesh`/… without the extended type plus the
   `memory` export for zero-copy reads. Added the six F006 exports and
   captured `initOutput.memory`; `ping()` behavior unchanged.

3. **`page.tsx` re-parses the file for voxelization (temporary duplication).**
   F006's file list excludes `useModelPipeline.ts`, so the voxel hookup
   (`VoxelPipelineHost`, defined inside `page.tsx`) runs its own
   parse → normalize → bridge → debug-view pass with a separate generation
   counter. Cost is one extra parse per upload; F019 folds both passes into
   `SimEngine` per the spec's own TEMPORARY note.

4. **Observed voxelization numbers (128×48×48 domain unless noted):**
   unit box [10..14)³ in a 32³ test grid → **125 solids** (98 surface +
   27 interior, watertight, spec range [90, 160]); sphere r = 12 →
   **8516 solids** vs analytic 7238 (ratio 1.18, spec [0.6, 1.3]×);
   same sphere minus the top cap → **surface_mode = true, 2580 shell cells**,
   no hang. Node smoke test against the real `wasm-pack` artifact reproduced
   the box count (125) through the raw `occupancy_ptr` view.

## 2026-09-07 — F007 (LBM D3Q19 core step)

1. **Temporary obstacle model: solids rest at u=0 + streaming skips solid
   destinations (no bounce-back).** The spec asks for periodic edges plus
   "solid cells copied through untouched (`f_next = f` at solids)" and asserts
   the wake test "uses periodic wrap + solid cells treated as copy-through".
   Taken literally — solids initialised identically to fluid (uniform inlet
   equilibrium) and streamed like fluid — uniform flow is an exact fixed point
   (collide maps `f_eq → f_eq`, pull-streaming a uniform plane returns the
   same plane), so no wake can ever form and `gailei_insertion_creates_flow`
   (downstream < 0.05 with `u_inlet = 0.08`) is unachievable. Smallest change
   meeting the acceptance criteria without stealing F008's bounce-back:
   `reset_flow` fills fluid cells with equilibrium at `(1, u_inlet, 0, 0)` and
   solid cells with equilibrium at rest `(1, 0, 0, 0)`; `set_mesh`/`clear_mesh`
   retune only the changed cells the same way (rest of the field untouched);
   the streamer skips solid destinations (they stay frozen) while fluid cells
   pull rest-state populations out of solid neighbours. No reflection, no
   inlet/outlet/walls — all of that stays F008's work. Documented in
   `wasm/src/lbm.rs` module docs; F008's "skip writing into solid cells" envis
   aged fix is therefore already half-satisfied (the skip), leaving bounce-back
   + BC families to that feature.
2. **Upstream assertion read as max, not mean (periodic momentum drain).**
   With periodic edges nothing drives the flow, so obstacle drag drains total
   momentum: measured on the 32×16×16 + 4³-block fixture (`u_inlet = 0.08`,
   `τ = 0.56`) upstream-slab mean 0.0629 → 0.0600 → 0.0547 → 0.0488 → 0.0462
   at 100/200/300/400/500 steps, while downstream-slab mean stays
   0.0350 → 0.0264 → 0.0238 → 0.0235 → 0.0223 (wake sustained) and upstream
   max stays 0.0751 → 0.0716 → 0.0644 → 0.0575 → 0.0553. The spec's "upstream
   shows u_x > 0.05 (blockage)" is satisfied as an existence check
   (`up_max > 0.05`) with the downstream wake on the mean (`down_mean < 0.05`)
   at the specified 500 steps; a mean-vs-mean reading becomes impossible past
   ~350 steps under periodic BC. Test comment records the sweep.
3. **Perf: 35.5 ms/step at 128×48×48, exceeding the ≤ 4 ms budget — noted,
   no threads added.** `cargo test --release bench_note -- --nocapture`
   (Apple M4 Pro, arm64, rustc 1.98.1, `opt-level = 3 + lto`): **35.529
   ms/step** (5 measured steps after 1 warmup, all-fluid, `u = 0.05`,
   `τ = 0.56`). Cause is the straightforward two-pass safe-Rust kernel
   (per-cell `f64` BGK + periodic pull-stream with bounds-checked indexing,
   ~90 MB memory traffic/step for the two 22 MB SoA buffers) with no
   `unsafe`, no tiling, no threading — exactly what the spec anticipates
   ("if exceeding, note actual numbers … do not add threads"). Mitigation
   belongs to F010 (adaptive steps-per-frame) + F021 (quality presets), not
   this feature.
4. **New ABI surface not yet in ARCHITECTURE.md §5 — left for F009.**
   ARCH §5 already lists `step`/`reset_flow` but not the F007 diagnostics
   `steps_done()`, `set_lattice_params(u, τ)`, `get_lattice_params()`; ARCH
   also forbids extra exports without updating §5, while F007's file list
   covers only `wasm/src/lbm.rs` + `wasm/src/lib.rs`. Smallest consistent
   choice: keep ARCH untouched here (respect the file list) and let F009 —
   whose spec explicitly owns `set_conditions → LatticeParams` and instructs
   "update §5 in the same commit if field names drift" — reconcile §5 then.
   `wasm-pack` regenerates cleanly and `WasmProbe` still bundles (see below).

## 2026-09-08 — F009 (physical ↔ lattice units mapping)

The F009 spec's algorithm (§2) is implemented faithfully, but validating its
acceptance literals against ARCHITECTURE.md §3/§4 with real air physics exposed
four conflicts. All numbers below were verified with an independent Python
computation before writing any Rust (R = 287.05, T = 293.15 fixed):

1. **`u_lattice` start anchors: ARCHITECTURE's 0.05–0.15 wins over the spec's
   printed formula.** The spec prints
   `min(0.10, max(0.03, u_mps/60.0 × 0.10 + 0.03))` (0.0317 at 1 m/s, capped
   0.10), but ARCHITECTURE.md §4 — the binding contract — says "target
   0.05–0.15, clamped ≤ 0.15", and the spec's own `pressure_conversion_round_trip`
   criterion (0.01 → 166.7 ± 1 Pa at defaults) *requires* u(15 m/s) ≈ 0.0737:
   the printed formula gives u = 0.055 → 298.5 Pa (132 Pa off), while linear
   interpolation of ARCHITECTURE's anchors,
   `u0 = 0.05 + (U−1) × 0.10/59` (0.05@1 → 0.15@60, clamped to [0.03, 0.15]),
   gives u = 0.0737288136 → 166.13 Pa (0.57 Pa off, inside ±1).
   Implemented the ARCHITECTURE-consistent interpolation.
2. **Real air can never reach τ ≥ 0.505 at metre scale, so `unstable: true` is
   the *normal* outcome, not an exception.** τ − 0.5 = 3νu/(Δx·U); at defaults
   (15 m/s, 101.325 kPa, μ = 1.81e-5, L = 1.0 m, nx = 128) the §4 direct value
   is τ ≈ 0.50002837 — needing ~176× growth in u to hit the 0.505 floor. The
   spec's ×1.5 low-side loop gains at most 1.5⁸ ≈ 25.6× in 8 iterations, so it
   *always* exhausts without converging for every input in the UI envelope.
   Consequences: `default_conditions_produce_stable_params` cannot yield
   `unstable: false` (criterion left unticked in the spec); on non-convergence
   the implementation returns the *starting* u (already inside [0.03, 0.15],
   keeping (u, dt, c) self-consistent — clamping the loop's final 25.6×-inflated
   u to 0.15 would break the pressure criterion: 40.1 Pa instead of 166.1 Pa),
   τ clamped to the envelope floor 0.505, `unstable: true`. Downstream
   (F018/F019) must therefore treat clamped τ = 0.505 + `unstable: true` as the
   normal toy operating point (the roadmap risk register already routes this to
   "τ clamping, auto-throttle + soft restart"). The τ > 0.95 halving branch is
   unreachable with physical viscosities; the `high_speed_clamps_to_envelope`
   test exercises it with a finite non-physical μ = 1.0 Pa·s at U = 60
   (τ: 1.297 → 0.899, u: 0.15 → 0.075, converges), which the criterion's
   conditional phrasing permits, plus a physical-μ U = 60 case documenting the
   actual low-side behaviour.
3. **`LatticeParams` carries `rho_phys` (7th field, §5 updated).** Item 3's
   formula `p = (1/3)·ρ_rel·ρ_phys·c²` needs ρ_phys, but the specified
   `pressure_lattice_to_pa(rho_rel, p: &LatticeParams)` signature provides only
   `&LatticeParams` — and the module must stay pure (no SimState, no globals).
   Smallest consistent change: store ρ_phys in the pure struct; the ABI struct
   mirrors it (7 getters). F012 (`q_ref = ½ρU²`) and F013 (force conversion)
   need the stored ρ_phys/U anyway, so `SimState` also retains
   `u_mps/rho_phys/dx_phys/dt_phys/re/conditions_unstable` from the last
   `set_conditions` call (additive fields; τ/u_inlet still go through F007's
   clamp helper as the spec requires). `get_lattice_params` now returns the
   full struct (stored values; zeros for dt/dx/re/ρ until `set_conditions`
   runs — F007's u/tau behaviour unchanged).
4. **Two printed hand-numbers don't match their own stated inputs.**
   (a) `kinematic_viscosity_default_air`: μ = 1.81e-5 / ρ = 1.204118316 gives
   ν = 1.503174543e-5, not the printed 1.5057e-5 (off by 2.5e-8, exceeding the
   ±1e-9 tolerance; the print matches μ ≈ 1.813e-5). The test asserts the true
   literal tightly and additionally asserts it differs from the print, so a
   future "fix" to the wrong literal fails loudly. Criterion unticked.
   (b) `pressure_conversion_round_trip`: true value 166.133 Pa vs printed
   166.7 Pa (author's rounded intermediates; inside the ±1 Pa tolerance, so the
   criterion is ticked with the arithmetic shown in the test comment).

Observed values: ρ(101.325 kPa) = 1.204118316 kg/m³; ν = 1.503174543e-5 m²/s;
default lattice triple (U = 15, nx = 128): u = 0.0737288136,
dt = 3.840042373e-05 s, τ_direct = 0.5000283718 → reported τ = 0.505
(clamped), Re = 249472.03.

## 2026-09-08 — F010 (step driver, stability monitor & perf budget)

1. **`std::time::Instant` traps on wasm32-unknown-unknown — the spec's
   assumption was wrong; fallback redesigned with no new dependencies.** The
   spec directs `Instant` as "supported under wasm32-unknown-unknown (verified
   in F003's toolchain…)". F003's spec and §F003 notes above show it only ever
   called `ping()` — no clock was ever exercised there. A scratch
   `wasm-pack --target nodejs` probe (rustc 1.98.1, wasm-bindgen 0.2.128)
   calling `Instant::now()` under Node 26 traps with `unreachable`. Shipping
   that inside `step()` would throw on every frame in the browser, violating
   CONVENTIONS.md ("panics inside exported functions are forbidden"). The
   spec's literal fallback (`js_sys::Date::now()`) needs a new crate plus a
   `wasm/Cargo.toml` edit — both outside this feature's file list, and the
   spec's Dependencies say "none". Smallest consistent change: a cfg-gated
   clock in `lib.rs` — `Instant` on native targets (unit tests, benches), and
   on wasm32 a `performance.now()` host import through the already-present
   `wasm-bindgen` dependency (no new crates, no Cargo.toml change,
   `wasm_bindgen` stays confined to `lib.rs`; the import generates a safe
   wrapper, so no `unsafe` block was needed). Monotonicity makes it strictly
   better than `Date.now()` for measuring durations. Verified end-to-end: the
   rebuilt `--target web` artifact under Node 26 reports real timing
   (`last_step_ms` 0.23 on a 10-batch over 16×8×8, EMA update exact at
   0.1×last after the first batch) with no trap; `is_stable()`, the ≤ 64
   clamp, and `reset_flow()` likewise verified through the real artifact.
2. **`ARCHITECTURE.md` §5 updated for the new ABI surface (its own Forbidden
   rule requires it).** Added `timing() -> Timing { last_step_ms, avg_step_ms }`
   and noted the `step(n)` ≤ 64 clamp on the existing `step` line.
   `is_stable()` was already listed.
3. **Perf budget MISSED on this machine — recorded, not silently passed.**
   `cargo test --release -- --ignored --nocapture` (Apple M4 Pro, arm64,
   rustc 1.98.1, `opt-level = 3 + lto`, 2026-09-08), full production path
   (ABI `step()` + cube + all BC passes + batch timing):
   - 128×48×48 + 8³ cube: mean **47.656 ms/step**, p95 48.884 (budget ≤ 4).
   - 64×24×24 + 4³ cube: mean **5.082 ms/step**, p95 5.267 (target ≤ 0.6).
   Scaling is ~linear in cells (8× cells → 9.4× time), so this is a high
   constant, not a blowup. Context: F007 measured 35.5 ms/step for the bare
   kernel, all-fluid, via direct call; F010 measures the full production path,
   and the cube's bounce-back pass (every cell scans up to 18 neighbours for
   solid adjacency) is the main added cost. No optimization attempted here
   (out of scope; "SIMD intrusions" explicitly deferred by the spec) —
   mitigation stays with F019 (adaptive steps-per-frame, now fed by real
   `timing()`) + F021 (quality presets).
4. **Debug-mode suite cost.** The new `healthy_run_stays_stable` (5 000 debug
   steps, default grid) takes ~31 min on this machine (~0.38 s/step debug vs
   ~0.048 s/step release) and passes. The F008 10k-step tests dominate the
   debug suite the same way (pre-existing). Full verification this feature:
   `cargo test --release` → 36 passed / 0 failed (446 s, includes all giants);
   debug → all non-giant tests pass (5.5 s) plus `healthy_run` solo pass; the
   three F008 giants were verified in release only (the `collide_pass` delta
   is numerically inert — it only reads ρ/u and writes two state fields on
   violation — so their debug behaviour is unchanged from F008's sign-off).
