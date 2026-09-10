# Decisions & Conflict Log

Dated notes recorded when a feature spec conflicted with code/tooling reality, per
`CONVENTIONS.md`. Each entry states the conflict and the smallest change chosen to
stay consistent with `ARCHITECTURE.md`.

---

## 2026-09-08 — F020 (viewport polish)

1. **Front-preset axis: spec §1 contradicts its own acceptance criterion.**
   §1 prints `front` = (−18, 0, 0) with "camera on −X axis looking +X", while
   the acceptance criterion (the binding, testable requirement) demands
   "Front preset: wind flows left→right on screen". A camera on the −X axis
   looking +X aligns the flow direction (+X) with the view direction — flow
   would read *into* the screen, never left-to-right. Smallest consistent
   change: keep the spec's own tie-breaker sentence ("choose angles so wind
   reads left-to-right") and the criterion — `front` = camera on the **+Z
   axis** at distance 18, up +Y, which maps world +X to screen-right.
   Verified headless (`node /tmp/f020-probe.mjs`, 10/10, Node 26.8.1, real
   three.js camera math): at `front` the +X unit step projects to NDC
   (+0.07, 0.00) — purely rightward — while the spec-printed (−18, 0, 0)
   projects +X to lateral NDC magnitude 0.00e+0 (flow exactly along the
   view axis). Spherical-lerp tween endpoints land at ≤ 3.1e-15 world
   units, easeInOutCubic pinned at 0/0.5/1 and monotonic. `top` = +Y axis
   (view dir (0, −1.0000, −0.0001)) and `iso` = (14, 7, 14) follow §1
   literally. The tween also keeps `controls.target` frozen (§1: "spherical
   interpolation around the **current** target") — the "animate target"
   phrasing in the Context paragraph is satisfied trivially (target lerp is
   a no-op) and never fights `showModel`'s model-centered target.
2. **Voxel debug toggle ships inert (no occupancy feed in v1).** F019
   DECISIONS #7 predicted "F020's layer toggle re-feeds" the debug cloud,
   but F020's Files list sanctions only `SceneManager.ts`, `ViewToolbar.tsx`,
   `ControlPanel.tsx`, `SimulationContext.tsx`, `page.tsx` — the feed path
   (`SimEngine` occupancy accessor + a `useSimulation` pipeline call) is
   outside it, and the spec's own §1 marks `setVoxelDebugVisible` as
   "exists from F006 — keep" (no new data path). Smallest consistent change:
   the toggle is wired exactly as spec'd (context state →
   `SceneManager.setVoxelDebugVisible`); the view simply has no data until a
   later feature sanctions an occupancy accessor. All other toggles
   (particles, smoke, heatmap, domain box) have live data paths and work.
3. **Screenshot without `preserveDrawingBuffer`.** §2 allows either
   `preserveDrawingBuffer: true` (standing perf cost) or one extra render
   into the capture. Chosen: `screenshot()` renders one fresh frame and
   calls `toDataURL("image/png")` synchronously in the same task — the
   drawing buffer is still valid at read time, so no renderer option
   changes and the per-frame cost stays zero. Documented at the method.

---

## 2026-09-08 — F019 (simulation loop orchestration)

Headless probes below drive the real `--target web` artifact via `initSync`
(F014/F017 pattern), 128×48×48 + empty domain (no mesh), Node 26.8.1, Apple
M4 Pro. `node --test /tmp/f019-probe.mjs` 7/7 pass (6 adaptive-policy cases
against the shipped `nextStepsPerFrame` imported from the real
`SimEngine.ts` via an `@/`-alias resolve hook, plus 1 ABI-sequence mirror);
`npm run lint` zero errors/warnings; `npm run build` succeeds (the
"Loading engine…" overlay is present in the prerendered `index.html`).

1. **`SimulationContext.tsx` is new, not modified (F018.1 precedent).** The
   Files list says "(modify) — full API (F004 skeleton extended)", but no
   such file ever landed (F018 built a controlled-props adapter in `page.tsx`
   instead — see §F018.1). Created at the spec'd path with exactly the §3
   API plus two additive members the wiring provably needs:
   `conditionsUnstable` (F018's panel contract — the §3 list abbreviates with
   `smoke*`/`heatmapToggle` but the panel cannot render its clamp warning
   without it) and `pushToast` (the §5 error surface needs a push path
   reachable from the loop/pipeline in `useSimulation`). No contract removed.
2. **Consumer rewire touches four files outside the Files list (smallest
   change satisfying §3 + criterion 5).** `ParticleCountSlider`,
   `SmokeControls`, `StatsPanel`, and `ControlPanel`'s `LayersSection` all
   imported the deleted `voxelBridge`; leaving them would break the build,
   and §3 explicitly requires every temporary control's data path to run
   through the single context. All four keep their exact props/component
   signatures (sliders/controls/legend/panel render identically — only the
   data source changes: context state instead of bridge module state; the
   legend now reads its anchors from the 4 Hz readout, same cadence as the
   deleted 4 Hz anchor subscription). Comment-only touch-ups in the same
   spirit (no code changes): viz-class headers (`ParticleSystem`,
   `HeatmapOverlay`, `SmokeTracers`), `types.ts`, `PressureLegend` — all said
   "temporary bridge driver", which criterion 5's `rg -i temporary|TODO`
   sweep would otherwise flag. `WasmProbe.tsx`/`VoxelDebugToggle.tsx` were
   already deleted in F018, so the DELETE list shrinks to `voxelBridge.ts`,
   `useModelPipeline.ts`, `SmokeProbe.tsx` (all removed).
3. **`wasm.ts` untouched (structural extension lives in `SimEngine`).**
   `SimEngine` defines its full ABI surface as a local structural type over
   the loader's narrow `WasmApi` (the deleted bridge's own pattern), so only
   `SimEngine.ts` imports `loadWasm`. Criterion 7's literal
   `rg "loadWasm|wasm\\)"` would still hit `wasm.ts`'s own *definition* site
   (`export function loadWasm`, the `import("@/wasm/windtunnel")` it must
   contain) — the intent (no ABI callers outside `SimEngine`) holds: the
   only `loadWasm` *caller* in `src/` is `SimEngine.init()`.
4. **No dev-only steps console flag committed (criterion 4 alternative).**
   The spec suggests exposing steps-per-frame via a debug flag and removing
   it after verifying; instead the policy was verified headless (6/6 cases
   against the shipped pure helper — cold start 2→4→8, hold band [3, 7.2]
   ms at budget 12, halve-to-floor with min 1, non-finite → cold start) and
   the EMA math confirmed through the real artifact (first `step(2)` batch:
   wall 159.7 ms → `avg_step_ms` 7.97 = 0.1×79.8, exact α=0.1 update), so no
   console scaffolding ever entered the tree. `SimEngine.getStepsPerFrame()`
   remains as the permanent diagnostic accessor.
5. **Recovery throttle gates halving, not pause+reset.** `tick()` on
   `!is_stable()`: always pause + `reset_flow()` (the latch clears, so the
   badge can return to STABLE), but the wind-halving (50 %, clamped to
   1–60 m/s) and the `recovered` toast flag run at most once per 5 s —
   otherwise spamming Run into a divergent point would halve to the floor
   without a visible pause. `lastRecoveryMs` starts at −5000 so the first
   recovery always runs fully.
6. **Pipeline voxelizes before displaying.** Spec order reads
   "parse → normalize → `engine.setMesh` → `resetFlow` → `play()`" with
   display implied; `showModel` runs after a successful `setMesh` so a
   voxelization failure keeps the previous model on screen (the old pipeline
   never swapped the scene on failure). `file === null` clears both the
   scene model and the engine mesh (no ghost obstacle) plus a flow reset.
7. **Voxel debug cloud goes dormant until F020.** The deleted
   `VoxelPipelineHost` was its only feeder; `updateVoxelDebug` /
   `setVoxelDebugVisible` / `clearVoxelDebug` stay on `SceneManager` (F020's
   layer toggle re-feeds them), but nothing calls `updateVoxelDebug` in v1 —
   the `debug` layer is simply empty.
8. **Pause freezes smoke in place (no reseed-on-resume).** The deleted
   drivers restarted on resume (smoke trails reseeded, heatmap re-attached);
   the unified loop skips all sim/viz updates while paused, so resume
   continues the exact frozen state. Smoke re-enable still re-seeds (fresh
   emission preserved).
9. **`resetAll` leaves run/pause untouched** (matches the F018 adapter:
   conditions → defaults + commit + flow reset; mesh, particle target, and
   running state kept). A debounced drag value pending at recovery/reset
   time is dropped (it would clobber the halved/default point); the user
   re-drags afterwards.

Observed values: `step(2)` wall 159.7 ms (≈ 79.8 ms/step in Node-wasm on
this machine — slower than F010's 47.7 ms release datapoint; the adaptive
loop will therefore sit at 1 step/frame at defaults until F021 presets);
`timing().avg_step_ms` 7.97 after the first batch (EMA warming exact);
`set_conditions(15, 101.325, …)` → `u_lattice` 0.073729; spawn 30000 →
active 30000, all positions/speeds finite; `stats().steps` 2n, `cd` −1
sentinel (no mesh), anchors zeroed without mesh. `cargo test` not run (no
Rust files touched — waived per CONVENTIONS.md).

---

## 2026-09-08 — F018 (control panel)

Headless probes below drive the real `--target web` artifact via `initSync`
(F014/F017 pattern), 128×48×48 + watertight 8³ box (729 solids,
`surface_mode = false`), Node 26.8.1, Apple M4 Pro. `node --test
src/lib/sim/conditions.test.mjs` 11/11 pass; `npm run lint` zero
errors/warnings; `npm run build` succeeds (prerender evidence cited inline).

1. **`SimulationContext` (F019) does not exist — controlled-props adapter, no
    new context file.** F018's metadata lists F019 as a dependency while F019
    lists F003–F018 (i.e. F018 itself): taken literally nothing could land
    first. The spec resolves it explicitly ("implement after F019, or
    concurrently against the contract below"), so `ControlPanel` is built
    controlled against the contract shapes — `conditions` /
    `setConditions({uMps, pressureKpa, viscosityPas})` / `transport
    {running, toggleRun, resetFlow, resetAll}` — with `page.tsx` wiring a
    TEMPORARY adapter of identical semantics (150 ms trailing debounce, ≤ ~7
    commits/s by construction: 1/0.15 = 6.67; viscosity-change chains
    `reset_flow`, speed/pressure never reset). Creating
    `SimulationContext.tsx` here would steal F019's owned file (outside F018's
    file list); F019 swaps the adapter for the real context without touching
    the panel's contract. `readout: SimReadout | null` is deferred with it —
    no F018 section consumes it, and an unused prop would be dead code.
2. **`charLengthM` is a constant, not `ModelContext` state — no `ModelContext`
    edit.** F018 §2 asks to add `charLengthM` to the model meta, but that file
    is outside this feature's list — and the edit is provably redundant:
    `normalizeToDomain` scales every model so its longest side spans exactly
    0.25·nx cells = 0.25·L_domain meters, hence always 0.25 m at the default
    domain length. `conditions.ts` exports `DEFAULT_CHAR_LEN_M = 0.25` with
    the derivation in a comment.
3. **Slider atom gains additive `disabled?`/`id?` props.** The contract props
    alone cannot express F018 §1's "sliders disabled until a model is loaded";
    the two optionals change no existing behavior.
4. **Printed hand-values vs true literals (F009 §4a, continued).**
    `derivedValues` implements the exact F009 formulas (ρ = P/(R·T), ν = μ/ρ,
    q = ½ρU², Re = U·L/ν — wasm agrees to 1e-6: q_ref@15 135.430 vs JS
    135.430). Deltas against the spec print: ν displays `1.50e-5`, not
    `1.506e-5` (the print matches μ ≈ 1.813e-5, not the stated 1.81e-5);
    q_ref at the *slider* default P = 101.3 (the 0.5 kPa step nearest sea
    level — a range input cannot represent 101.325) displays `135.4 Pa`, not
    the printed `135.5 Pa` (which holds at exactly 101.325: unit-pinned at
    135.4633106). The test asserts the true literals tightly and pins both
    mismatches so edits to the printed values fail loudly.
5. **τ does not move inside the UI viscosity envelope — Re + reset are the
    observable viscosity signals.** μ 1.81e-5 → 2.5e-5 at 40 m/s returns
    τ = 0.505 clamped, `unstable: true` on both sides (the F009 §2 regime:
    real air cannot reach the 0.505 floor at metre scale). The panel still
    performs the documented soft restart on every μ change (verified:
    `steps_done` 75 → 0, q_ref 963.1 Pa surviving), and the derived Re readout
    moves 665095 → 481528 (ratio exactly 2.5/1.81). Criterion 2's "τ changes"
    half is unachievable as printed; the amber clamp warning covers the
    `unstable` signal until F019 recovery lands.
6. **Deletions + pause semantics.** `WasmProbe.tsx` and
    `VoxelDebugToggle.tsx` are deleted now per F018 §3 (F019's DELETE list
    shrinks accordingly; `SceneManager.setVoxelDebugVisible` stays for F020's
    layer toggles). `SmokeProbe` (F011) and the whole `voxelBridge` stay for
    F019. Pause stops the three temporary drivers (stepping halts — resume
    reuses the primed engine, so the developed flow survives; smoke trails
    reseed, heatmap re-attaches). F019 will pause stepping while keeping
    buffers on screen.
7. **`voxelBridge.ts` grows two TEMPORARY exports (`setFlowConditions`,
    `resetSimFlow`) — F006 precedent.** The panel needs a live
    `set_conditions`/`reset_flow` path, and ARCHITECTURE forbids ABI calls
    outside the (temporary) engine owner; the addition is ~40 lines, deleted
    in F019 with the rest of the bridge.

Observed values: q_ref@15 = 135.430 Pa (wasm == JS); q_ref@40 = 963.1 Pa
(criterion's ≈963 ±10 % exact); speed change steps 64 → 65 (no reset);
extremes (60 m/s, 50 kPa, μ = 0.5e-5) → τ = 0.505, u = 0.15,
`unstable: true`, engine still answers; prerendered `index.html` ships
`<fieldset disabled="">` around Flow/Particles/Smoke/Layers with transport
buttons live (`⏸ Pause` initial), derived defaults `1.204 kg/m³`,
`1.50e-5 m²/s`, `135.4 Pa`, `2.5e5`.

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

---

## 2026-09-08 — F021 (quality presets)

Headless probes drive the real `--target web` artifact via `initSync`
(F014/F019 pattern), Node 26.8.1, Apple M4 Pro; `node --test
src/lib/sim/quality.test.mjs` 18/18 pass; full TS suite 74/74 pass;
`npm run lint` zero errors/warnings; `npm run build` succeeds (the Quality
segmented control prerenders in `index.html`). No Rust files touched, so
`cargo test` / `npm run wasm:build` are waived (ABI unchanged).

1. **File-list overrun for the §5 DOMAIN migration (F019 §F019.2
   precedent).** The Files list covers `quality.ts`, `SimEngine.ts`,
   `SimulationContext.tsx`, `ControlPanel.tsx`, `SceneManager.ts`, and
   `normalize.ts` — but §5 requires every `DOMAIN` consumer to switch to
   runtime dims, which needs three more minimal, backward-compatible edits:
   `ParticleSystem` (optional ctor `dims`, default = High behavior),
   `SmokeTracers` (optional `domainDims` option driving the layer offset,
   rake defaults, and domain-exit checks; default = High behavior), and
   `HeatmapOverlay.attach` (optional `dims` for the world→lattice inversion;
   default = High behavior). All three keep prior callers and the committed
   `node --test` suites behavior-identical (74/74 still pass unmodified).
   `useSimulation.ts` is likewise extended (dims threading, ready-gated viz
   construction, quality-switch display effect) — the re-init sequence is
   split per ownership: engine owns wasm, the loop owns display.
   Deliberately NOT migrated (correct via clamping, noted for F022-or-later):
   `StatsPanel`'s pre-ready `gridDims` fallback (first 4 Hz poll, ≤ 250 ms,
   corrects itself from `engine.getReadout()`) and `SmokeControls`' rake
   slider max (High-based 40; the context clamps actual values to the live
   `8..ny−8` window, so Low drags saturate at 16 without crashing).
2. **Re-voxelization rescales the cached soup — provably exact, no re-parse.**
   All tiers share the 8:3:3 aspect and `normalizeToDomain` places models at
   fixed grid fractions, so a soup normalized for one tier rescales exactly
   to a fresh normalization for another (`rescaleTriangleSoup`, per-axis
   multiply; the cache keeps the original + its dims, so repeated switches
   never accumulate drift). Headless proof: High→Low max abs diff **0**
   (bit-exact), High→Medium 1.9e-6 (one f32 ulp); through real wasm,
   Low-soup×2 re-voxelized at High vs a fresh High soup: solid-count rel
   diff **0** (35937 == 35937), both `surface_mode = false`, and solid
   centroids at relative (0.344, 0.5, 0.5) in both grids (the 0.35-target
   box voxelizes symmetric to ±half-cell) — the "screenshot-comparable
   silhouette" criterion holds structurally; pixel comparison needs a
   browser.
3. **`probeQuality` maps non-finite/non-positive timers to Medium.** A NaN /
   ±Infinity / ≤ 0 `avg_step_ms` is a broken clock, not a slow device — it
   must not strand a fast machine on Low. Pinned by test (strict `>` keeps
   the exact 12 ms boundary on Medium).
4. **`SimEngine.init()` default is now Medium (was High/`DOMAIN`).** Every
   real caller (the context boot) passes an explicit tier; the default only
   covers standalone/probe use and matches the spec's "Medium (default)".
   `PARTICLE_CAPACITY` stays 100k (covers High's 60k); the tier only moves
   the spawn target. `SMOKE_TRACER_COUNT` (25) is superseded by the preset
   table and kept as a commented export for API stability.
5. **Warm-up number on this machine (reference, not a gate).** `step(8)` at
   the Low grid under Node-wasm: `avg_step_ms ≈ 0.96` → ×8 ≈ 7.7 ms < 12 ms
   → this machine probes **Medium**. Node-wasm timing is not browser timing;
   real first visits decide per device.

Observed values: per-tier placement exact (Low center (22.4, 12, 12) size
16; Medium (33.6, 18, 18) size 24; High (44.8, 24, 24) size 32);
conditions re-commit across an `init_sim` rebuild is bit-identical
(u_lattice, τ); `spawn` + 2 steps post-switch stay `stable == true`.

---

## 2026-09-08 — F022 (edge cases & error handling)

Headless probes drive the real `--target web` artifact via `initSync`
(F014/F019 pattern) plus the real `SimEngine.ts` through an `@/`-alias
resolve hook (F019 pattern), Node 26.8.1, Apple M4 Pro:
`/tmp/f022-probe1.mjs` 6/6 (`node --test`: taxonomy + struct channel),
`/tmp/f022-probe2.mjs` (setMesh surfacing + forced double-blowup latch +
frozen readout + Reset), `/tmp/f022-probe2b.mjs` (freeze-cache exactness),
`/tmp/f022-probe3.mjs` (all three viz guards); `cargo test --release`
65 passed / 0 failed; `npm run wasm:build` regenerates cleanly;
`npm run lint` zero errors/warnings; `npm run build` succeeds.

1. **F005 rejection union widened (additive, contract preserved).**
   `parseModel` still rejects with `ModelParseError` on garbage input and
   `normalizeToDomain` still throws `DegenerateModelError` on zero-size
   boxes (F005 contract intact); the three NEW F022 guards throw `AppError`
   directly (`model-too-large` for > 1.5 M triangles with the exact spec
   message, `degenerate-model` for non-finite positions/bbox and for the
   sub-cell "too small relative to tunnel" case). Callers handle all three
   uniformly through `toAppError()` at the display boundary.
2. **`rg "throw new Error\("` criterion vs file-list discipline.**
   All bare throws inside F022's file list are now `AppError`
   (`SimEngine` ×2, `SceneManager` getLayer). Two hits remain, both React
   context-misuse guards outside the file list —
   `SimulationContext.tsx:617` (`useSimulationContext` outside provider),
   `ModelContext.tsx:131` (`useModel` outside provider) — which are
   programming errors, never user-facing, and editing them would violate
   CONVENTIONS.md file-list discipline. Criterion otherwise met: every
   user-facing throw site maps onto `AppError`, and every spec userMessage
   is ≤ 90 chars (pinned by probe 1).
3. **`wasm.ts` grew a `SetMeshResult` type (F006.2 precedent).** F022's file
   list omits `wasm.ts`, but the sanctioned `set_mesh → struct` ABI change
   makes the loader's hand-written `set_mesh(): number` typing a hard build
   error once `wasm-pack` regenerates the bindings (the generated
   `windtunnel.d.ts` returns `SetMeshResult`). Smallest consistent change:
   the return type becomes the structural `SetMeshResult`
   (`{ solidCount, skippedTriangles }` + `free()`), same "grown per
   feature" pattern F006 established; `SimEngine` keeps its local
   structural handle (F019.3 pattern) via `Omit<WasmApi, "set_mesh">`.
4. **Two one-line test knock-ons outside the file list.** The ABI return
   change breaks compilation of `pressure.rs:717`
   (`abi_wiring_small_box`) and `stats.rs:487` (`degenerate_mesh_cd_zero`);
   both assert lines now read `.solid_count` (F019.2 precedent — the build
   cannot pass otherwise). No algorithm code touched in either file.
5. **Stable-flag threading touches `useSimulation.ts` (3 lines).** The viz
   `update()` guards take an optional `stable = true` (backwards
   compatible — old callers compile unchanged), but the contract only
   functions if the driver passes `tick()`'s `stable`. The loop now passes
   `result.stable` into all three updates (F019.2 precedent). Freeze
   already held through the engine pause (the loop returns before viz
   updates while paused); the flag is defense-in-depth for the detecting
   frame itself, verified in probe 3.
6. **Double-blowup semantics: the locking recovery halves first.**
   The second blowup runs the normal halve + commit + `reset_flow` and
   THEN latches (the banner message describes the already-reduced speed),
   returning `recovered: false` so the loop's halving toast stays silent
   and the persistent banner owns the message. `getReadout()` reports
   `stable: false` while latched and serves the last developed snapshot
   (cached only past the F013 sentinel, so the freeze restores real
   numbers, not a just-reset uniform field).
7. **Timer-hygiene audit (§7 checklist — no code churn, all cleanups
   verified present):**
   - `src/app/page.tsx:75` UnstableBanner 500 ms poll → cleared `:86`;
     `:127` ContextLostOverlay 500 ms poll + manager subscriptions →
     cleared + unsubscribed `:139`.
   - `src/components/viewport/SceneManager.ts:220` OrbitControls `start`
     → removed `:403`; `:250` ResizeObserver → disconnected `:402`;
     `:255` canvas contextlost/restored → removed `:388`/`:392`;
     `:275`/`:277` rAF → cancelled `:282` via `stop()` (dispose calls it).
   - `src/lib/hooks/useSimulation.ts:57` SceneManager-wait poll →
     cleared `:59`/`:65`; `onFrame` subscription + viz disposal in the
     effect cleanup.
   - `src/lib/sim/SimulationContext.tsx:232` toast dismiss timeout →
     self-deletes from the set + unmount sweep `:243`; `:336` conditions
     debounce → cleared `:334`/`:352`/`:417`/`:517`; `:375` 4 Hz readout
     poll → cleared `:387`.
   - `src/components/viewport/ViewToolbar.tsx:38` fullscreenchange →
     removed `:40`.
   - `src/components/controls/ControlPanel.tsx:360` Space-toggle keydown
     → removed `:362`.
   - `src/components/viewport/Viewport.tsx` async mount: `disposed` flag
     + manager stop/dispose in cleanup (no timers/listeners of its own).
8. **StrictMode stress (note only, per spec).** Double-mount survival was
   verified in F019 (idempotent `SimEngine.init`, provider/loop/viewport
   cleanups above); F022 adds no new mount-time singletons — the two new
   page polls and the SceneManager canvas listeners all clean up in their
   effect/dispose paths (item 7), so a second mount re-subscribes cleanly.
   Manual browser double-check outstanding (React dev overlay in `npm run
   dev` mounts `page.tsx` twice).

Observed values: 200k-triangle plane voxelizes in ~0.01 s release
(~0.1 s debug; budget 2 s — 200× headroom); pathological sweep cap trips
exactly (2/2 synthetic over-swept triangles, valid triangle still
voxelizes to 125 solids on 16³); low-grid 8³ box at pinned (0.15, 0.505)
diverges ≈ 80 steps → first recovery halves 60 → 30 m/s; re-pinned second
run locks (`unstableLocked: true`, `recovered: false`); developed low-grid
run (320 steps, steady (0.08, 0.56)) caches cd = 9.10465722714673
(coarse-grid 33 %-blockage number, not a physics claim) and the frozen
readout reproduces it bit-for-bit with `stable: false`, zero non-finite
fields.

---

## 2026-09-09 — Stability assist (numerical viscosity on the τ-clamp path)

**Field evidence.** Production console log showed the continuous-run
recovery latching CATASTROPHIC every ~1.4 s even at U = 1 m/s (minimum):
every incident carried `tau: 0.505, conditionsUnstable: true`, wind
halving 7.5 → 3.75 → 1.875 → 1 m/s without effect. The recovery policy was
futile by construction, not buggy: with real air τ_direct ≈ 0.50003, the
×1.5 clamp loop needs ~176× u growth but caps out in 8 iterations, so τ
pins at the 0.505 envelope floor for **every** UI combination (verified:
even U = 1, μ = 3.0e-5, P = 50 kPa on the fine grid gives τ ≈ 0.503).
BGK at τ = 0.505 (ω ≈ 1.98) has ~zero dissipation — any obstacle blows up
within seconds, and no wind/viscosity slider can prevent it.

**Change** (`wasm/src/units.rs`, `TAU_ASSIST = 0.56`): when the clamp loop
fails on the low side, `lattice_params` returns the starting u with
τ = 0.56 instead of the 0.505 floor. High-side failures still clamp to
0.95; `set_lattice_params` keeps the raw [0.505, 0.95] envelope; the ABI
is unchanged (same structs/fields). 0.56 sits inside the ARCHITECTURE §3
envelope, so no contract conflict — `unstable: true` now means "running
on assist viscosity" (effective lattice Re ≈ 120 vs displayed physical
Re ≈ 2.5e5; this toy renders plausible flow, not lab numbers).

**Measured margin** (release, `cargo test --release`, probes since
removed): τ = 0.53 blows up ≈ step 1300 on a harsh 4-cell cube (settled
≈ 700 steps, then shedding grows unbounded — global exponential blowup,
26 % bad cells, not a corner-cell false latch); 0.54–0.60 survive that
case 1500 steps plus the U = 60 (u_lat = 0.15) 8-cell-cube and thin-plate
corners 3000 steps; 0.56 is additionally the long-proven F007/F010
fixture point (5000-step healthy run). Kept regression:
`real_air_assist_run_stays_stable` (real-air `set_conditions` + 4³ cube,
1500 steps, Low grid). Updated the two tests pinning τ = 0.505
(`units.rs` ×2, `lib.rs` ×1) and the ControlPanel assist banner copy;
`stats.rs` fixtures pin (u, τ) directly and are unaffected.

---

## 2026-09-09 — Precomputed obstacle boundary links (bounce-back perf)

**Problem.** `boundaries::apply_obstacle_bounce_back` rediscovered the
reflecting-link set on every step: for each of the ~295k cells of the High
grid it probed up to 18 neighbours before deciding whether to do anything.
That is ~5M branchy, cache-hostile occupancy loads per step — comparable to
the collide pass — for a set that is a pure function of `occupancy` and
therefore constant between mesh changes.

**Change** (`wasm/src/boundaries.rs`, `wasm/src/lbm.rs`, `wasm/src/lib.rs`).
`SimState` gained a struct-of-two-vecs link list plus a staleness stamp:
`boundary_cells: Vec<u32>` (solid-adjacent fluid cell indices, canonical
`z → y → x` scan order), `boundary_masks: Vec<u32>` (bit `i ∈ 1..19` set iff
neighbour `c + e[i]` is in-bounds and solid; never zero), and
`boundary_grid_len` (the `nx·ny·nz` the list was built for). The new
`boundaries::rebuild_boundary_links` fills it with one occupancy scan; the
per-step pass walks only the list, iterating each mask's bits low-to-high.
No ABI change, no new exports.

**Result parity.** Low-to-high bit iteration visits directions in ascending
index order — the historical `for i in 1..19` order — and the entries are in
the old full-grid scan order, so both the reflections and the `f64` drag
accumulation (`Σ (f[i] + f[rev(i)])·e_x[i]`, summed left to right) are
bit-identical to the previous implementation. The per-step pass still
allocates nothing (one 19-float stack snapshot per boundary cell); only the
mesh-time rebuild allocates, and it reuses the vectors' capacity.

**Rebuild hooks.** The invariant is "occupancy never changes without a
rebuild". Both occupancy funnels in `lbm.rs` end with the rebuild:
`retune_solid_cells` (`set_mesh`, `clear_mesh`, and the `place_box` fixtures
in `boundaries.rs` / `lbm.rs` / `particles.rs` / `advection.rs` / `bench.rs` /
`lib.rs`) and `reset_state_flow` (`init_sim`/`SimState::fresh`, `reset_flow`,
and the analytic-occupancy fixtures in `pressure.rs` and `stats.rs`, which
paint occupancy and then reset the field *without* retuning). A fresh
all-fluid state ends with an empty list, so bounce-back stays a no-op.
Belt-and-braces: the per-step pass no-ops when `boundary_grid_len` disagrees
with the live cell count.

**Coverage.** New `boundary_links_match_full_scan` asserts the list equals a
brute-force full-grid scan entry-for-entry and in order (this is what pins
the drag-sum parity), plus the empty-on-fresh default. The existing physics
suite is the behavioural regression net: `no_flow_through_solid`,
`wake_exists_downstream_of_cube`, `steady_state_reached`,
`sphere_cd_order_of_magnitude` (drag EMA envelope), `healthy_run_stays_stable`.

---

## 2026-09-10 — F026 (flow scenario presets)

Verification for this entry: `node --test src/lib/sim/conditions.test.mjs`
18/18 pass; `npm run lint` zero errors/warnings; `npm run build` succeeds with
the real generated bindings (`src/wasm/` present); headless Chrome 153 via
Playwright (`playwright-core`, system Chrome, real wasm artifact) 40/40
acceptance checks; `cargo test` not run (no Rust files touched — waived per
CONVENTIONS.md).

1. **The viscosity "on its slider grid" test-plan check is unsatisfiable —
   the default is pinned instead.** Spec §1's note says every preset value
   sits on its slider grid, but the viscosity preset value is the F018
   default coefficient 1.81, which is 26.2 steps above the 0.5 min at step
   0.05 (remainder 0.01) — not a grid multiple. The spec forbids changing the
   values ("do not change them"), so the test asserts the literal
   `(value − min) / step ≈ whole` for speed and pressure, and for viscosity
   asserts exact equality with `DEFAULT_CONDITIONS.viscosityPas` plus a loud
   pin that the default is off-grid (a future re-gridding of the viscosity
   slider fails the test for review). The F018 slider already renders the
   off-grid 1.81 default by React state (the range input's sanitization may
   display the nearest step), so no new behavior is introduced here.
2. **The collapsed summary carries "stability assist on" at the F018
   defaults too.** §6 appends the amber marker whenever `conditionsUnstable`
   is true; with real air the τ clamp fires at every physical operating point
   (F009 §2 — `unstable: true` is the normal regime), so the default summary
   reads `15.0 m/s · 101.3 kPa · 1.81 ×10⁻⁵ Pa·s · stability assist on`.
   Criterion 7's example (`Race car → 55.0 m/s · 101.5 kPa · 1.81 ×10⁻⁵ Pa·s`)
   lists the value portion; suppressing the marker at defaults would
   contradict §6 and criterion 9's "never fully hidden" intent. No code
   change — the marker reflects the contract flag exactly, and the values
   themselves match the spec string.
3. **Discovered, not fixed (outside F026's file list): samples leave the
   stats bar in placeholder mode.** `SimulationContext`'s 4 Hz readout poll
   fills `modelName` from `ModelContext.file` only; the F023 sample path sets
   `sample` and leaves `file` null, so `StatsPanel`'s `empty` branch renders
   `—` for every metric (Model, Cd, Drag, P min/max, Re, Particles) even with
   a sample fully simulated. Uploaded files are unaffected. Reported in the
   F026 final report; a one-line `sample`-aware fix belongs to a follow-up
   touching `SimulationContext.tsx`.
