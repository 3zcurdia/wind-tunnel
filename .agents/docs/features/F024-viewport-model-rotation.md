# F024 — Viewport model rotation (angle of attack)

## Metadata

| Field | Value |
|-------|-------|
| ID | F024 |
| Phase | 7 |
| Size | M |
| Skill fit | `UI/3D` |
| Depends on | F005 (model pipeline), F019 (loop/context), F020 (toolbar + SceneManager patterns) |
| Status | `[ ]` todo |

## Goal

Users rotate the loaded model inside the viewport — yaw/pitch/roll via a
dedicated rotate mode — to change its angle of attack. Each committed rotation
re-voxelizes the obstacle grid and soft-restarts the flow, so particles, smoke,
the pressure heatmap, and Cd respond to the new orientation. No WASM ABI
changes: rotation is pure JS mesh math over the engine's cached soup.

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
     previewModelOrientation(o: ModelOrientation): void  // pivot quaternion from R (no fit correction); no-op without model
     setOrbitRotateEnabled(on: boolean): void              // controls.enableRotate
     ```
   - Preview matrix composed explicitly as
     `makeRotationY(yaw)·multiply(makeRotationZ(pitch))·multiply(makeRotationX(roll))`
     (no Euler-order ambiguity). The lattice→world map is uniform scale +
     translation with no axis swap (F005), so world-axis rotation about the
     world center is the exact image of the domain-space rotation.
   - `clearModel` disposes the pivot with the mesh. A commit's `showModel`
     recreates the pivot at identity — no explicit un-preview call needed.

5. **Rotate mode UI — `RotateController` (new) + `ViewToolbar`**:
   - `ViewportPane` (page.tsx) holds `rotateModeActive` local state;
     ViewToolbar gains a "Rotate" toggle button (active styling; disabled when
     `!ready || !hasModel`) and ESC exits.
   - `RotateController` (null-render except a bottom-center readout chip):
     while active — `setOrbitRotateEnabled(false)` on the live SceneManager;
     `pointerdown` on the canvas (found via container
     `querySelector("canvas")`, so toolbar clicks never start a drag) captures
     the pointer; `pointermove` → yaw += `dx·ROTATE_DEG_PER_PIXEL`, pitch +=
     `dy·ROTATE_DEG_PER_PIXEL` (`ROTATE_DEG_PER_PIXEL = 0.5`), Shift held → dx
     drives **roll** instead; calls `previewModelOrientation` per move
     (preview only — **no engine calls during drag**); pointerup →
     `setOrientation(final)` (single context write = single commit).
   - Readout chip (bottom-center, toolbar styling): `Yaw −45° · Pitch 10° ·
     Roll 0°` live during drag, committed value otherwise, plus a **Reset**
     button (`resetOrientation()`, which commits back to default).
   - ESC mid-drag cancels: revert preview to the committed orientation, no
     commit.

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
- `previewModelOrientation(o): void` (no-op without model),
  `setOrbitRotateEnabled(on): void` — SceneManager remains stateless about
  *why*.
- WASM ABI (ARCHITECTURE.md §5) unchanged — no Rust edits, `npm run wasm:build`
  not required, `cargo test` unaffected.

## Acceptance criteria

- [ ] With rotate mode on, left-drag rotates the model live (pivot-only, no
      solver calls during drag — fps unaffected); camera pan (right-drag) and
      zoom still work; ESC/button exits and restores orbit.
- [ ] Yaw/pitch/roll conventions pinned headless: yaw +90° maps +X→−Z and
      −X→+Z; pitch +90° maps +X→+Y; roll +90° maps +Y→+Z; centroid stays at the
      placement center ± 0.01 for any angles.
- [ ] Fit correction pinned headless: a 32×32×1 X-Y plate pitched 45° on the
      High tier rotates to AABB 45.25 → shrinks by exactly 1/√2 → longest side
      32 ± 0.01, all vertices within the domain with ≥ 4-cell wall margin; a
      thin rod yawed 45° gets no shrink (correction is `min(1, …)`).
- [ ] Round-trip: rotate to (90, 45, 30), commit, rotate back to (0, 0, 0),
      commit → the applied soup is bitwise-equal to the original normalized
      soup (derived from the zero-orientation cache — no drift).
- [ ] Sample Sphere at (45, 30, 60): `set_mesh` succeeds; solid count within
      ±5% of its unrotated count; obstacle AABB inside the placement envelope.
- [ ] On release, the flow soft-restarts: steps counter resets, Cd shows "—"
      within ~1 s, then re-develops; the heatmap re-attaches on the swapped
      geometry and paints the new stagnation side; display mesh matches the
      corrected applied soup (rotation and any shrink visible).
- [ ] Orientation survives a quality switch (e.g. yaw 30° on Medium → Low:
      model and obstacle still yawed 30°) and resets on new file/sample/clear
      (toggle disabled until the new model's meta lands).
- [ ] Commit while paused stays paused; while running, restarts with no user
      action.
- [ ] `npm run lint` / `npm run build` pass; no `console.log`; TS strict clean.

## Test plan

- Headless (`node --test`, F020-probe pattern, pure function only): axis
  mapping triples, centroid invariance, plate shrink = 1/√2, rod no-shrink,
  wrap function, round-trip bitwise equality, empty-soup no-op. Optional
  wasm-artifact probe (F019 pattern) for the sphere solid-count criterion.
- Manual browser: toggle + drag on each sample (watch the teardrop's nose
  swing off-axis), Shift-roll, ESC-cancel mid-drag, Reset button, rotate →
  quality switch → still rotated, upload while rotated (resets), rotate while
  paused, drag-fps spot-check, toolbar click does not start a drag.

## Out of scope

- Translating the model (placement is fixed at §3's center), rotating the
  wind/rake/domain (wind stays +X), precision sliders or numeric entry,
  camera-relative drag-axis mapping, orientation persistence (localStorage),
  undo, TransformControls gizmo, touch gestures, rotating the smoke rake,
  toast on commit.
