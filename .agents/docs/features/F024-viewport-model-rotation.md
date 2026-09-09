# F024 — Viewport model rotation (angle of attack)

## Metadata

| Field | Value |
|-------|-------|
| ID | F024 |
| Phase | 7 |
| Size | M |
| Skill fit | `UI/3D` |
| Depends on | F005 (model pipeline), F019 (loop/context), F020 (toolbar + SceneManager patterns) |
| Status | `[x]` done — rev 2 (2026-09-09; rev 1 2026-09-08). Rev 2: camera-relative gestures, arrow-key/button stepping, relative-preview fix for the post-commit snap-back. Visual/browser criteria still need a browser — see notes) |

## Goal

Users rotate the loaded model inside the viewport — **up/down/left/right as
seen from the current camera view** via a dedicated rotate mode — to change
its angle of attack. Gestures: pointer drag for coarse control, arrow keys and
on-chip step buttons for granular control. Each committed rotation
re-voxelizes the obstacle grid and soft-restarts the flow, so particles, smoke,
the pressure heatmap, and Cd respond to the new orientation. No WASM ABI
changes: rotation is pure JS mesh math over the engine's cached soup.

> **Rev 2 (2026-09-09).** Two changes over rev 1, driven by first real use:
>
> 1. **Snap-back bug fixed.** Rev 1's preview set the pivot to the *absolute*
>    orientation, but after the first commit the display geometry already has
>    the committed rotation baked in (`showModel` rebuilds from
>    `getAppliedSoup()`). Every drag after the first therefore double-rotated
>    the preview and visibly "flipped back" on release. The preview is now
>    *relative*: `previewModelOrientation(next, committed)` sets the pivot to
>    `R(next)·R(committed)⁻¹`. Pointer capture on drag start also keeps a
>    release outside the window from stranding a drag.
> 2. **Camera-relative gestures + granular stepping.** Rev 1 mapped dx→yaw /
>    dy→pitch on fixed world axes, which only feels right from the front
>    preset. Gestures now rotate about the *camera's* up/right/view axes
>    (`SceneManager.rotateOrientationInView`), and arrow keys plus chip
>    buttons give 5° (Shift: 1°) steps with a debounced commit.

## Context

- The voxel obstacle is baked at `set_mesh` time (ARCHITECTURE.md §5); a rotated
  model must be re-voxelized and the field soft-restarted (`reset_flow`) — the
  same semantics as a viscosity change (F018, ARCHITECTURE.md §6).
- `SimEngine` already caches the last-voxelized **zero-orientation** domain-space
  triangle soup with its grid (`cachedMesh`, F021). Rotation derives from that
  cache every time — never from the previously rotated soup — so orientation
  changes cannot compound drift.
- `normalizeToDomain` (F005) seats every model with bbox center at
  `(0.35·nx, ny/2, nz/2)` and longest side `0.25·nx`; all quality tiers keep the
  8:3:3 aspect (F021), so the placement envelope is tier-invariant.
- The display rebuild pattern exists: the quality-switch effect builds a
  `BufferGeometry` from the engine soup and calls `showModel`; the frame loop
  re-attaches the heatmap automatically on geometry swap (same vertex order).
- OrbitControls owns left-drag (camera orbit). Rotate mode disables orbit
  rotate while active — pan/zoom stay live.

## Detailed spec

1. **Orientation state — `ModelContext`** (additive, no three.js import):
   ```ts
   export interface ModelOrientation { readonly yawDeg: number; readonly pitchDeg: number; readonly rollDeg: number; }
   export const DEFAULT_ORIENTATION: ModelOrientation = { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
   ```
   - New members: `orientation: ModelOrientation`,
     `setOrientation(partial: Partial<ModelOrientation>): ModelOrientation`
     (wraps each angle to `[-180, 180)`, stores, returns the applied value),
     `resetOrientation(): void`.
   - `setFile` / `loadSample` / `clear` reset orientation to
     `DEFAULT_ORIENTATION` (a new model always starts unrotated; the pipeline
     voxelizes at zero).
   - Axes (lattice space, right-handed, degrees): **yaw** about +Y (vertical
     turntable), **pitch** about +Z (nose up/down in the X-Y plane), **roll**
     about +X (about the wind axis).

2. **Rotation math — `SimEngine.ts`** (pure export, hand-rolled matrices;
   `SimEngine` keeps its type-only three dependency so headless probes import
   it unchanged):
   ```ts
   export function rotateTriangleSoup(soup: Float32Array, dims: GridDims, o: ModelOrientation): Float32Array
   ```
   - Center `C = (0.35·nx, ny/2, nz/2)`; per vertex `p' = C + s·R·(p − C)`
     with `R = Ry(yaw)·Rz(pitch)·Rx(roll)` (roll applied first, yaw last).
   - **Fit correction**: after rotating, if the rotated AABB's longest side `L`
     exceeds `0.25·nx`, apply uniform `s = (0.25·nx)/L` about `C`; otherwise
     `s = 1`. This keeps the model inside the placement-size envelope on every
     tier (cross-axis wall margin ≥ `0.0625·nx` ≥ 4 cells; worst case a 45°
     square plate shrinks to `1/√2`).
   - Input never mutated; empty soup → empty; centroid stays at `C` for any
     orientation.

3. **Engine commit — `SimEngine`**:
   ```ts
   applyOrientation(o: ModelOrientation): MeshResult | null   // null: no mesh
   getAppliedSoup(): Float32Array | null                      // currently-voxelized (rotated) soup
   ```
   - `applyOrientation`: rotate `cachedMesh.soup` → `set_mesh` (updating
     `solidCount` / `surfaceMode` / `skippedTriangles`; **`cachedMesh` itself is
     never overwritten**) → `reset_flow()` (soft restart owned by the engine,
     viscosity precedent) → return the `MeshResult`. Run/pause state is
     untouched.
   - Skip-guard: store `appliedOrientation`; when the request equals it (and a
     mesh is set), return the stored result **without** wasm work or a restart.
   - `setMesh` (new model) and `clearMesh` reset `appliedOrientation` to
     default; `applyQuality` re-applies `appliedOrientation` to the rescaled
     soup so orientation survives tier switches.
   - `getAppliedSoup` replaces the quality-effect's `getMeshSoup` read for
     display rebuilds (getMeshSoup stays zero-orientation for rescale math).

4. **SceneManager — pivot + preview + orbit gate**:
   - `showModel` now seats the mesh inside a `modelPivot: Group` in the
     `meshModel` layer: geometry is baked world-space as today **minus the
     model's world bbox center**, `pivot.position` = that center. Identity
     pivot renders pixel-identical to today; the orbit target moves to
     `pivot.position` (same world point as before).
   - New methods:
     ```ts
     previewModelOrientation(o: ModelOrientation, baked: ModelOrientation): void
       // pivot quaternion = R(o)·R(baked)⁻¹ (no fit correction); no-op without model
     rotateOrientationInView(current: ModelOrientation,
       delta: { horizDeg?: number; vertDeg?: number; spinDeg?: number }): ModelOrientation
       // camera-relative step → new yaw/pitch/roll (camera untouched)
     setOrbitRotateEnabled(on: boolean): void              // controls.enableRotate
     ```
   - Rotation matrices composed explicitly as
     `makeRotationY(yaw)·multiply(makeRotationZ(pitch))·multiply(makeRotationX(roll))`
     (no Euler-order ambiguity; shared `orientationMatrix` helper). The
     lattice→world map is uniform scale + translation with no axis swap
     (F005), so world-axis rotation about the world center is the exact image
     of the domain-space rotation.
   - **Preview is relative to the baked orientation (rev 2)**: the commit
     path bakes the committed rotation into the display geometry, so the
     pivot must only carry the *difference* `R(o)·R(baked)⁻¹` — passing the
     committed orientation as `baked` makes an untouched draft render as
     identity and prevents the rev-1 double-rotation/snap-back.
   - **`rotateOrientationInView` (rev 2)**: `horizDeg` rotates about the
     camera's up axis (positive → the model's near face moves right on
     screen), `vertDeg` about the camera's right axis (positive → near face
     moves down), `spinDeg` about the view axis (positive → clockwise on
     screen). The world-frame delta quaternion premultiplies `R(current)`;
     the result decomposes back to yaw/pitch/roll via three.js Euler order
     `"YZX"` (= `Ry·Rz·Rx`, the F024 composition — decomposition round-trips
     exactly), so the returned triple feeds `rotateTriangleSoup` unchanged.
     Angles return unwrapped; `ModelContext.setOrientation` wraps. This
     keeps three.js behind the SceneManager boundary — `RotateController`
     is statically imported by page.tsx and must stay three-free (the
     prerendered bundle carries zero `three` references).
   - `clearModel` disposes the pivot with the mesh. A commit's `showModel`
     recreates the pivot at identity — no explicit un-preview call needed.

5. **Rotate mode UI — `RotateController` (new) + `ViewToolbar`**:
   - `ViewportPane` (page.tsx) holds `rotateModeActive` local state;
     ViewToolbar gains a "Rotate" toggle button (active styling; disabled when
     `!ready || !hasModel`) and ESC exits.
   - `RotateController` (null-render except a bottom-center readout chip):
     while active — `setOrbitRotateEnabled(false)` on the live SceneManager;
     `pointerdown` on the canvas (found via container
     `querySelector("canvas")`, so toolbar clicks never start a drag)
     **captures the pointer** (`setPointerCapture`; releasing outside the
     window must still fire pointerup); `pointermove` →
     `rotateOrientationInView(current, { horizDeg: dx·k, vertDeg: dy·k })`
     with `k = ROTATE_DEG_PER_PIXEL = 0.5` (camera-relative — drag follows
     the mouse from any view); Shift held → dx drives **spin about the view
     axis** instead of horizontal; calls
     `previewModelOrientation(draft, committed)` per move (preview only —
     **no engine calls during drag**); pointerup → `setOrientation(final)`
     (single context write = single commit).
   - **Granular stepping (rev 2)** — arrow keys and chip buttons, all
     camera-relative:
     - `←`/`→` → `horizDeg ∓/±step`, `↑`/`↓` → `vertDeg ∓/±step`;
       `step = STEP_DEG = 5°`, Shift → `FINE_STEP_DEG = 1°`. Key events on
       form controls (INPUT/TEXTAREA/SELECT/contentEditable) are ignored —
       range sliders own their arrow keys. `preventDefault` on handled keys.
     - Chip buttons `◀ ▲ ▼ ▶` (same axes/steps; Shift-click = fine) and
       `⟲ ⟳` (spin about the view axis).
     - Each step previews immediately; the **commit is debounced**
       (`STEP_COMMIT_DEBOUNCE_MS = 400`): a burst of taps re-voxelizes and
       soft-restarts once, after the last tap. Pending steps fold into a
       drag that starts before the debounce fires, and flush (commit) if
       rotate mode exits first — they are never silently dropped.
   - Readout chip (bottom-center, toolbar styling): `Yaw −45° · Pitch 10° ·
     Roll 0°` live during a gesture, committed value otherwise, plus the step
     buttons and a **Reset** button (`resetOrientation()`, which commits back
     to default; Reset first drops any in-flight draft/pending steps and
     reverts the preview so a no-op reset can't leave a stale preview). The
     numbers can jump representation (e.g. pitch > 90° re-expressed via
     yaw+roll) — the pose itself is continuous.
   - ESC mid-gesture (drag in flight *or* debounced steps pending) cancels:
     revert preview to the committed orientation, no commit. ESC otherwise
     exits rotate mode.

6. **Commit effect — `useSimulation`** (mirrors the quality-switch display
   half):
   - Effect on `[orientation, meta]`: with a mesh present,
     `engine.applyOrientation(o)` → if changed, rebuild the display mesh from
     `engine.getAppliedSoup()` (`BufferGeometry` + position attr → `showModel`
     → dispose temp) → the loop re-attaches the heatmap on the geometry swap;
     `reset_flow` already ran inside the engine. The `meta` dep re-fires the
     effect after a pipeline completes, so a rotation made mid-upload applies
     to the new mesh (skip-guard makes the common default-orientation case a
     no-op).
   - The F021 quality-switch effect switches its display rebuild from
     `getMeshSoup()` to `getAppliedSoup()` (orientation preserved across
     switches).
   - No toast on commit — the Cd "—" sentinel and visibly restarting particles
     are the signal (viscosity-restart precedent).

7. **Edge cases**:
   - Rotating while paused: preview works, commit resets the flow, stays
     paused.
   - During drag the sim keeps stepping around the **old** obstacle while the
     mesh preview is rotated — accepted transient (self-heals ≤ 1 s after
     release).
   - Rotation while the F022 unstable latch is active: allowed; it resets the
     flow but does not clear the latch (Reset keeps ownership).
   - No model / engine not ready: toggle disabled; `applyOrientation` no-ops
     (null).

## Files to create / modify

```
src/lib/sim/SimEngine.ts                  (modify) — rotateTriangleSoup, applyOrientation, getAppliedSoup, appliedOrientation guard, applyQuality re-apply
src/lib/sim/ModelContext.tsx              (modify) — orientation state + wrap + reset on model change
src/components/viewport/SceneManager.ts    (modify) — modelPivot seating, previewModelOrientation, setOrbitRotateEnabled
src/components/viewport/RotateController.tsx (new)  — mode effect, pointer drag, readout chip, ESC/cancel
src/components/viewport/ViewToolbar.tsx   (modify) — Rotate toggle button + active state
src/lib/hooks/useSimulation.ts             (modify) — orientation commit effect; quality effect reads getAppliedSoup
src/app/page.tsx                          (modify) — ViewportPane: rotate-mode state, mount RotateController, hasModel gate
```

(The ROADMAP Phase 7 section + board entry for F024 land with this spec, before
implementation; the checkbox is ticked at completion per CONVENTIONS.md.)

## Dependencies added

- none

## Interface contract

- `ModelOrientation` exported from `ModelContext.tsx` (consumed by
  SimEngine/SceneManager signatures via type import).
- `rotateTriangleSoup(soup, dims, o): Float32Array` — pure; exported for
  headless pinning (the `rescaleTriangleSoup` precedent).
- `applyOrientation(o): MeshResult | null`; `getAppliedSoup(): Float32Array |
  null` (copy, like `getMeshSoup`).
- `previewModelOrientation(o, baked): void` (relative preview, no-op without
  model), `rotateOrientationInView(current, delta): ModelOrientation`
  (camera-relative stepping; pure read of the camera pose),
  `setOrbitRotateEnabled(on): void` — SceneManager remains stateless about
  *why*.
- WASM ABI (ARCHITECTURE.md §5) unchanged — no Rust edits, `npm run wasm:build`
  not required, `cargo test` unaffected.

## Acceptance criteria

- [ ] With rotate mode on, left-drag rotates the model live **and the model
      follows the mouse from any camera angle** (drag right → near face moves
      right on screen; orbit the camera 90° and it still follows); pivot-only,
      no solver calls during drag — fps unaffected; camera pan (right-drag)
      and zoom still work; ESC/button exits and restores orbit.
      **NOT VERIFIABLE HEADLESS — needs a browser:** drag path is
      preview-only by construction (the move handler calls only
      `previewModelOrientation`; the single `setOrientation` write happens
      on pointerup), orbit-rotate is gated off/on around the mode mount, and
      ESC has distinct cancel/exit branches — but pointer capture, live fps,
      and grab-feel need a browser.
- [ ] **Rev 2 — no snap-back:** rotate and release, then rotate again — the
      second drag starts from the committed pose (no double-rotation) and
      the mesh does **not** jump back on release; releasing the mouse
      outside the browser window still commits (pointer capture).
      **NOT VERIFIABLE HEADLESS — needs a browser** (the relative-preview
      identity `R(o)·R(o)⁻¹ = I` is pinned headless; the perceived
      no-jump needs eyes).
- [x] **Rev 2 — view-relative math pinned headless:** the `"YZX"` Euler
      decomposition round-trips the `Ry·Rz·Rx` composition exactly
      (37/−52/110 → identical triple); from the front preset (camera on +Z),
      `horizDeg +90` → yaw +90, `vertDeg +90` → roll +90, `spinDeg +90` →
      pitch −90; a `horizDeg +30` step moves the model's +Z point to
      x = +0.5 (rightward on screen); `R(o)·R(o)⁻¹` is the identity
      quaternion. (Verified 2026-09-09, node + three from node_modules.)
- [ ] **Rev 2 — granular stepping:** arrow keys and the chip's ◀ ▲ ▼ ▶ / ⟲ ⟳
      buttons step 5° (Shift: 1°) in view space; a burst of taps previews
      per tap but re-voxelizes/restarts once (400 ms debounce); pending
      steps survive an immediate mode exit (flushed as one commit); arrow
      keys pressed while a form control has focus (e.g. a range slider) are
      left to that control.
      **NOT VERIFIABLE HEADLESS — needs a browser.**
- [x] Yaw/pitch/roll conventions pinned headless: yaw +90° maps +X→−Z and
      −X→+Z; pitch +90° maps +X→+Y; roll +90° maps +Y→+Z; centroid stays at
      the placement center ± 0.01 for any angles.
      (Verified 2026-09-08: `node --test /tmp/f024-probe.mjs` — axis triples
      at tol 1e-6, centroid of a 32×16×8 box at (37, −61, 23) within 0.01
      of C, input never mutated, empty-soup no-op.)
- [x] Fit correction pinned headless: a 32×32×1 X-Y plate pitched 45° on the
      High tier rotates to AABB 45.25 → shrinks by exactly 1/√2 → longest
      side 32 ± 0.01, all vertices within the domain with ≥ 4-cell wall
      margin; a thin rod yawed 45° gets no shrink (correction is `min(1, …)`).
      (Verified 2026-09-08: longest side 32 ± 0.01, top edge at C.y+16 ±
      0.01, margins hold; rod endpoints match the pure-rotation values at
      tol 1e-5 — f32 soup storage, not math error.)
- [x] Round-trip: rotate to (90, 45, 30), commit, rotate back to (0, 0, 0),
      commit → the applied soup is bitwise-equal to the original normalized
      soup (derived from the zero-orientation cache — no drift).
      (Verified 2026-09-08: `deepStrictEqual` on the zero-rotation copy;
      the all-zero shortcut in `rotateTriangleSoup` is what makes this
      bitwise — naive `(p−C)+C` leaves 1-ulp noise.)
- [x] Sample Sphere at (45, 30, 60): `set_mesh` succeeds; solid count within
      ±5% of its unrotated count; obstacle AABB inside the placement envelope.
      (Verified 2026-09-08 against the real artifact: unrotated 19578 →
      rotated 19587, rel 0.0005; rotated AABB inside C±16 per axis.)
- [ ] On release, the flow soft-restarts: steps counter resets, Cd shows "—"
      within ~1 s, then re-develops; the heatmap re-attaches on the swapped
      geometry and paints the new stagnation side; display mesh matches the
      corrected applied soup (rotation and any shrink visible).
      **NOT VERIFIABLE HEADLESS — needs a browser** (`reset_flow` runs
      inside `applyOrientation` by construction; the display rebuild reads
      `getAppliedSoup()`; heatmap re-attach rides the existing geometry-swap
      path — but live re-development needs a running viewport).
- [ ] Orientation survives a quality switch (e.g. yaw 30° on Medium → Low:
      model and obstacle still yawed 30°) and resets on new file/sample/clear
      (toggle disabled until the new model's meta lands).
      **NOT VERIFIABLE HEADLESS — needs a browser** (`applyQuality`
      re-applies `appliedOrientation` over the rescaled zero-cache and the
      quality effect rebuilds from `getAppliedSoup()` by construction;
      `setFile`/`loadSample`/`clear` all reset orientation — click-through
      outstanding).
- [ ] Commit while paused stays paused; while running, restarts with no user
      action.
      **NOT VERIFIABLE HEADLESS — needs a browser** (`applyOrientation`
      never touches the run flag by construction — code review only).
- [x] `npm run lint` / `npm run build` pass; no `console.log`; TS strict clean.
      (Verified 2026-09-08: eslint zero errors/warnings, `next build`
      succeeds, prerendered `index.html` carries the disabled Rotate toggle
      with zero `three` references — lazy-chunk split intact.)

## Test plan

- Headless (`node --test`, F020-probe pattern, pure function only): axis
  mapping triples, centroid invariance, plate shrink = 1/√2, rod no-shrink,
  wrap function, round-trip bitwise equality, empty-soup no-op. Optional
  wasm-artifact probe (F019 pattern) for the sphere solid-count criterion.
- Headless (rev 2, node + three): `"YZX"` decomposition round-trip of the
  `Ry·Rz·Rx` composition, front-preset axis mapping for horiz/vert/spin,
  drag-follows-mouse sign check, relative-preview identity.
- Manual browser: toggle + drag on each sample (watch the teardrop's nose
  swing off-axis), **second drag after a commit (no snap-back)**, drag from
  a top/iso camera (still follows the mouse), Shift-spin, arrow-key steps
  (coarse + Shift-fine, debounce collapses a burst into one restart), chip
  step buttons, ESC-cancel mid-drag and mid-debounce, Reset button (incl.
  while a draft is live and committed is already default), rotate → quality
  switch → still rotated, upload while rotated (resets), rotate while
  paused, drag-fps spot-check, toolbar click does not start a drag, release
  outside the window still commits.

## Out of scope

- Translating the model (placement is fixed at §3's center), rotating the
  wind/rake/domain (wind stays +X), precision sliders or numeric entry,
  orientation persistence (localStorage), undo, TransformControls gizmo,
  touch gestures, rotating the smoke rake, toast on commit.
  (Camera-relative drag-axis mapping was out of scope in rev 1; it is **in**
  scope since rev 2.)
