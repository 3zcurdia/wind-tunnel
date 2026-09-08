# F020 — Viewport polish (camera presets, layer toggles)

## Metadata

| Field | Value |
|-------|-------|
| ID | F020 |
| Phase | 5 |
| Size | S |
| Skill fit | `UI` |
| Depends on | F002 (SceneManager), F019 (context) |
| Status | `[x]` done (2026-09-08; code + headless verification done, 5 visual/browser criteria need a browser — see notes + DECISIONS.md §F020) |

## Goal

Viewport conveniences that make the app feel finished: camera preset buttons
(Front / Top / Isometric) with smooth transitions, a Layers section toggling every
visual element (particles, smoke, heatmap, voxel debug, domain box, grid), and a
screenshot button. Everything rides existing APIs — no new wasm surface.

## Context

SceneManager already owns layers (`getLayer`) and the voxel debug toggle
(`setVoxelDebugVisible`). Camera presets animate `camera.position` +
`OrbitControls.target` over ~600 ms with easing — implemented inside SceneManager
(own the loop via its existing rAF; no external tween library).

## Detailed spec

1. **SceneManager additions**:
   ```ts
   setCameraPreset(preset: 'front' | 'top' | 'iso', animateMs?: number): void
   setLayerVisible(layer: DomainLayers, visible: boolean): void
   setDomainBoxVisible(on: boolean): void        // box + grid + inlet marker group
   setVoxelDebugVisible(on: boolean): void        // exists from F006 — keep
   screenshot(): string                            // dataURL (PNG) of current canvas
   ```
   - Presets (world coords, distance ≈ 18): `front` (−18, 0, 0)… choose angles so
     wind (−X→+X) reads left-to-right: front = camera on −X axis looking +X;
     top = +Y axis; iso = (14, 7, 14) default from F002.
   - Animation: easeInOutCubic on spherical interpolation of camera position
     around the current target; user input (OrbitControls start event) cancels the
     tween.
2. **`ViewToolbar.tsx`** (floating top-right inside viewport area, absolute):
   - Preset buttons (icons/text "Front/Top/Iso"), screenshot 📷 button,
     fullscreen toggle button (`requestFullscreen` on the viewport container).
   - Screenshot: `renderer.domElement.toDataURL('image/png')` → programmatic
     `<a download="wind-tunnel.png">` click; requires `preserveDrawingBuffer: true`
     — add it in SceneManager renderer options (small perf cost, accepted) or
     render one extra frame into the capture (implementer's choice; document).
3. **Layers section** in ControlPanel (F018's panel, new section): toggles for
   Particles / Smoke / Heatmap / Voxel debug / Domain box. Heatmap toggle
   reuses F015's overlay attach/clear path through context. Toggles apply instantly
   and are independent.
4. Fullscreen: container-level (viewport div), exits cleanly on ESC (browser
   default); resize handling already exists (F002 ResizeObserver).

## Files to create / modify

```
src/components/viewport/SceneManager.ts   (modify) — presets, layer/box visibility, screenshot
src/components/viewport/ViewToolbar.tsx   (new)
src/components/controls/ControlPanel.tsx  (modify) — Layers section
src/lib/sim/SimulationContext.tsx         (modify) — layer visibility state passthrough
src/app/page.tsx                          (modify) — mount toolbar
```

## Dependencies added

- none

## Interface contract

- New SceneManager methods exactly as above; presets never fight OrbitControls
  (cancel-on-interaction is mandatory).
- `screenshot()` returns a PNG dataURL or throws `ScreenshotError` if the canvas
  is context-lost.
- Layer visibility state lives in `SimulationContext` (so F021 presets can drive
  it later); SceneManager remains stateless about *why*.

## Acceptance criteria

- [ ] Front preset: wind flows left→right on screen; Top: plan view; Iso: default
      3/4 view — each reachable in ~0.6 s with smooth easing; grabbing the mouse
      mid-tween stops it without jumps.
      **GEOMETRY + MATH VERIFIED HEADLESS, on-screen feel needs a browser:**
      `node /tmp/f020-probe.mjs` 10/10 against real three.js camera math —
      `front` (+Z axis, DECISIONS §F020.1: the spec's printed "(−18,0,0)"
      contradicts this criterion) projects a world +X step to NDC
      (+0.07, 0.00), i.e. wind reads purely left→right; `top` view dir is
      (0, −1.0000, −0.0001) (plan view); `iso` == F002's (14, 7, 14);
      spherical lerp starts/lands within 3.1e-15 of the endpoints;
      easeInOutCubic pinned at 0/0.5/1 and monotonic. Duration is the 600 ms
      default constant; cancel-on-interaction is wired to OrbitControls'
      `start` event, which nulls the tween before the next frame write — the
      drag resumes from wherever the flight stopped, so no jump by
      construction. Live easing + grab-cancel need a browser.
- [ ] Every layer toggle works independently; turning everything off leaves a
      clean empty box; turning heatmap off restores gray model.
      **MECHANISM IN PLACE, browser clicks outstanding:** five independent
      context booleans with separate paths — particles →
      `setLayerVisible("particles")` (group.visible), domain box →
      `setDomainBoxVisible` (box + grid + inlet now share a group), voxel
      debug → `setVoxelDebugVisible` (inert in v1: no occupancy feed,
      DECISIONS §F020.2), smoke/heatmap ride the F019 loop's per-frame
      application (heatmap off = `overlay.clear()` +
      `setModelVertexColors(false)` — the F015-verified gray-restore path).
      Prerendered markup carries all five toggles inside the disabled-until-
      ready fieldset.
- [ ] Screenshot downloads a PNG showing exactly the current view (verify pixel
      content, not a blank image).
      **IMPLEMENTED, pixel check needs a browser:** `screenshot()` renders
      one fresh frame and calls `toDataURL("image/png")` synchronously in the
      same task (no `preserveDrawingBuffer` standing cost — DECISIONS
      §F020.3), throws `ScreenshotError` on context-lost (toolbar toasts the
      failure), downloads via programmatic `<a download="wind-tunnel.png">`.
- [ ] Fullscreen expands viewport, ESC exits, camera state preserved.
      **IMPLEMENTED, browser outstanding:** `requestFullscreen` on the
      viewport container (the toolbar rides along inside it), ESC exit is
      browser-native, a `fullscreenchange` listener syncs the button label;
      F002's ResizeObserver handles the fullscreen resize, and the transition
      never touches the camera/renderer (state preserved by construction).
- [ ] Toggling layers has no measurable fps cost when off.
      **BY CONSTRUCTION, measurement needs a browser:** hidden groups are
      culled before any GPU submission (three.js skips invisible subtrees);
      the smoke hidden state is the same path F016/F019 already used.
      Particle attribute updates continue while hidden (that is the sim path,
      unchanged) — the budget-relevant GPU work disappears.
- [x] `npm run lint` / `npm run build` pass.
      (Verified 2026-09-08: eslint zero errors/warnings; `next build`
      succeeds; prerendered `index.html` carries the toolbar — "Front" and
      the screenshot button present — with zero `three` references in the
      server HTML, so the lazy-chunk split from F002/F003 is intact.)

## Test plan

- Manual: presets ×3, screenshot → open downloaded file, fullscreen round-trip,
  each toggle on/off, layer-off fps spot-check.
- No unit tests (interactive feature); optional: tween easing pure-function test
  if extracted.

## Out of scope

- Custom keyframe cameras, video recording, wind-direction rotation (fixed +X per
  §3), stereoscopic/VR, touch gestures beyond OrbitControls defaults.
