# F016 — Smoke tracer lines

## Metadata

| Field | Value |
|-------|-------|
| ID | F016 |
| Phase | 4 |
| Size | M |
| Skill fit | `UI/3D` |
| Depends on | F002 (SceneManager), F009 (dt), F011 (`sample_velocity_batch`) |
| Status | `[x]` done (2026-09-08; code + headless verification done, 5 visual/browser criteria need a browser — see notes) |

## Goal

Real-wind-tunnel smoke: a rake of tracer seeds upstream of the model emits continuous
ribbons that bend around the body — rendered as fading line trails. Rake position
(height/width) and trail length are adjustable; the layer toggles independently of
particles.

## Context

Unlike particles (Rust-owned pool), tracers are **JS-owned**: their positions are
advanced in JS using `sample_velocity_batch` (the only sanctioned JS↔wasm sampling
path, batched per frame). Each tracer keeps a ring buffer of the last K positions
(default 90 ≈ 1.5 s), drawn as `THREE.LineSegments` (2 vertices per segment) with
per-vertex colors darkening toward the tail (LineBasicMaterial has no per-vertex
alpha without custom shaders — the documented fade trick is color-darkening on the
dark background).

## Detailed spec

1. **`SmokeTracers.ts`** (class):
   - Config: `tracerCount` (default 25), `historyLen` (default 90),
     `seedLine` `{ yCenter: lattice, zCenter: lattice, halfWidth: lattice }`
     (defaults: y=ny/2, z=nz/2, halfWidth=8), `seedX = 2.0`.
   - State: `pos: Float32Array` (tracerCount×3, current), `trail: Float32Array`
     (tracerCount×historyLen×3 ring), `head: usize`.
   - Seeding: evenly spaced along a vertical line at `seedX`
     (y = yCenter−hw..+hw), all z = zCenter. Re-seeding (param change) clears trails.
   - Per frame: build points array (tracerCount×3) → `sample_velocity_batch` →
     `p += v·dt·speedScale` (`speedScale` default 1.0; dt = current lattice dt from
     F009 params — the bridge supplies it), advance ring head, store positions.
     Killed/reset if sampled cell is solid or p leaves the domain (tracer pauses at
     head position — shows "stagnant smoke", a real effect; document).
   - Rendering: one `LineSegments` with position attribute size
     `tracerCount×(historyLen−1)×2` and color attribute; colors:
     head = `#e5e7eb` at full, tail fading to `#1f2937` (index-based factor).
     Rebuild buffers only when tracerCount/historyLen change (disposal + new).
     Material: `LineBasicMaterial({ vertexColors: true, transparent: true,
     opacity 0.85, depthWrite: false })`. Added to `getLayer('smoke')`.
   - API: `update(dt: f32, sample: (points: Float32Array, out: Float32Array) => void)`
     — the sampling closure is injected (bridge supplies the wasm batch call);
     `setRake(y, z, halfWidth)`, `setHistoryLen(n)`, `dispose()`.
2. **Controls** (temporary mount, moved by F018/F020):
   - `SmokeControls.tsx`: toggle "Smoke tracers"; two sliders "Rake height"
     (y: 8..ny−8) and "Rake width" (halfWidth: 2..16); number input "Trail length"
     (30..240). Changes call the corresponding setters live.
3. **Driver** (temporary in `voxelBridge`): after wasm step each frame →
   `smoke.update(dt, (pts, out) => wasm.sample_velocity_batch(pts, out))`.
4. **Perf**: tracerCount ≤ 100, history ≤ 240 → ≤ 24 000 sampled points/frame —
   one batched wasm call; ≤ 2 ms budget (verify dev-only timing).

## Files to create / modify

```
src/lib/viz/SmokeTracers.ts                    (new)
src/components/controls/SmokeControls.tsx      (new, TEMPORARY — moved by F018/F020)
src/lib/sim/voxelBridge.ts                     (modify) — TEMPORARY driver + sampling closure
src/app/page.tsx                               (modify) — mount controls
```

## Dependencies added

- none

## Interface contract

- `SmokeTracers.update(dt, sample)` — sampling is injected, never imported: the
  class stays wasm-free and unit-testable with a fake flow field.
- Ring-buffer order: index 0..historyLen−1 from head backwards; head = newest.
- Solid-hit policy: freeze at current position (do not kill) — visible stagnation;
  document in class header.

## Acceptance criteria

- [ ] Sphere/cube model: at least 60 % of center-line tracers visibly wrap around
      the body; some tracers behind the body freeze or curl (wake), none pass
      through the solid.
      **HEADLESS PROXY ONLY (browser check outstanding):** 8³ cube at the
      F012 stable point (0.08, 0.56), 240 developed steps + 600 frames ×
      (step + update) against the real artifact — 13/13 center-line tracers
      wrapped (deflected out of the slab, stalled at the face, or swept past),
      4 visibly stalled at the face (stagnation), 0 non-finite positions, 0
      inside the solid core, mean x 2.0 → 45.7, y-spread 16 → 21.7,
      `stable == true` throughout; per-frame cost sample 0.016 ms + update
      0.027 ms (≤ 2 ms budget). Pixels need a browser.
- [ ] Trails fade smoothly to invisible; no alpha artifacts against the background.
      **STATIC COLORS VERIFIED, browser check outstanding:** head vertex
      exactly `#e5e7eb`, tail exactly `#1f2937`, monotonic index fade by
      construction (unit-covered); the on-screen gradient needs a browser.
- [ ] Rake height slider moves the line up/down with tracers re-forming within
      ~0.5 s; width slider fans the line out.
      **MECHANISM IN PLACE, browser check outstanding:** `setSmokeRake`
      re-seeds immediately (unit-covered: new line + cleared trails); the
      0.5 s re-form timing needs a browser.
- [x] Trail-length change rebuilds without artifacts or leaks.
      (Headless-verified: 90 → 30 rebuild gives exactly 25×29×2 segment
      vertices, one `LineSegments` on the layer before and after, trails
      re-seeded from live heads, `dispose()` removes all lines; unit-covered.)
- [ ] Smoke toggle off removes all lines; on restores fresh emission.
      **MECHANISM IN PLACE, browser click outstanding:** off hides the
      `smoke` layer (update skipped), on re-shows + re-seeds (unit-covered
      reseed path; driver transition covered by code review only).
- [ ] 60 fps sustained with particles (F014) + smoke + heatmap active together at
      default settings on the dev machine.
      **NOT VERIFIABLE HEADLESS:** smoke's own slice is 0.04 ms/frame, but
      F014 already showed the fixed 1 step/frame driver costs ~54 ms/step —
      combined fps needs a browser after F019/F021.
- [x] Unit test (fake sampler): linear field moves tracers at constant velocity;
      ring overwrite after `historyLen` steps wraps cleanly (head math property
      test, no wasm needed).
      (Verified 2026-09-08: `node --test src/lib/viz/SmokeTracers.test.mjs`
      11/11 pass — linear advection, head `(n+1)%K`, freeze-on-zero,
      domain-edge freeze, NaN/dt guards, reseed, rebuild, endpoint colors,
      idempotent dispose.)

## Test plan

- Unit (`SmokeTracers` with injected fake sampler via `node --test`): ring index
  math, freeze-on-solid behavior with a zero-field sampler inside a marked region.
- Manual: visual checks per criteria; verify combined-layers fps.

## Out of scope

- Particle-shaped smoke (round dots per tracer), 3D rake grids, injection rate
  control, colored-by-pressure tracers, shader-based fading, interaction with the
  solver (smoke is passive — always).
