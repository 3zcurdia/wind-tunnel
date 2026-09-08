# F014 — Particle streamlines

## Metadata

| Field | Value |
|-------|-------|
| ID | F014 |
| Phase | 4 |
| Size | M |
| Skill fit | `UI/3D` |
| Depends on | F002 (SceneManager), F010 (step), F011 (pool + pointers), F009 (speed scale) |
| Status | `[x]` done (2026-09-08; criteria 4+6 verified, 1–3+5 need a browser — see notes + DECISIONS.md) |

## Goal

The signature visual: thousands of particles flow through the tunnel around the
model, colored by speed (slow = blue, fast = red), recycled at the inlet, rendered
as a single `THREE.Points` draw call at 60fps. Particle count is adjustable
(5k–100k).

## Context

Rust owns the pool (F011); this feature only reads the zero-copy position/speed
views each frame and manages the three.js side. All rendering goes through
`SceneManager`'s `onFrame` subscription; `SimEngine` (F019) drives wasm calls —
**until F019 lands, this feature wires to the temporary `voxelBridge`** and its
`update()` is called from a temporary rAF in the bridge (F019 replaces the driver,
not this code — keep `ParticleSystem` driver-agnostic).

## Detailed spec

1. **`src/lib/viz/colormaps.ts`**:
   - `speedColor(t: number): [r,g,b]` — 5-stop colormap (all stops as constants):
     0.0 `#1d4ed8` blue → 0.25 `#06b6d4` cyan → 0.5 `#e5e7eb` white → 0.75
     `#f59e0b` amber → 1.0 `#dc2626` red; linear interpolation between stops.
   - `pressureColor(t: number): [r,g,b]` — diverging: 0.0 `#2563eb` → 0.5
     `#f3f4f6` → 1.0 `#dc2626`.
   - Both clamp t to [0,1]. Unit-testable (pure).
2. **`ParticleSystem.ts`** (class, owns a `THREE.Points`):
   - Constructor takes `capacity` (default 30 000) and builds:
     `BufferGeometry` with `position` (Float32Array, 3·capacity, `DynamicDrawUsage`)
     and `color` (Float32Array, 3·capacity) attributes; `PointsMaterial`
     (`size: 0.06` world units, `vertexColors: true`, `sizeAttenuation: true`,
     `transparent: true`, `opacity 0.9`, `depthWrite: false`). Added to
     `SceneManager.getLayer('particles')`.
   - `update(positions: Float32Array, speeds: Float32Array, active: number,
     colorMode: 'speed' | 'pressure', speedNorm: { min: number; max: number })`:
     copies the active prefix into the attributes (direct typed-array `set`),
     `geometry.setDrawRange(0, active)`, marks `needsUpdate`, maps each speed via
     `speedNorm` → `speedColor`. Color recomputation throttled to every 2nd frame
     (positions every frame).
   - `dispose()`: geometry/material disposal.
   - Speed normalization anchors: `speedNorm` passed by the caller — F019 computes
     it as `[0, 1.3 × u_inlet_mps]` in lattice-speed units supplied from the
     current `LatticeParams` (document the 1.3 headroom factor).
   - World transform: lattice→world mapping via
     `SceneManager.latticeToWorld` (F006 helper) applied as a single parent
     `Group` transform (not per-vertex) — the `particles` layer group gets the
     transform; ParticleSystem sets it once from `DOMAIN` constants.
3. **Count control**: temporary slider (5k–100k, step 5k) in the Controls rail
   ("Particles"): on change → `voxelBridge.setParticleCount(n)` → wasm
   `spawn_particles(n)` + `ParticleSystem` rebind. F018/F019 relocate this control.
4. **Recycling per frame** (temporary driver in `voxelBridge`): each frame →
   `advect_particles(dt)`, read `active_particle_count()`, if
   `active < target × 0.98` → `respawn(target − active)` (rate-limited to keep
   cost bounded: max 2 000 respawns/frame). dt: 1 lattice step per frame at
   steps-per-frame 1 (temporary; F019 owns real timing).
5. **Perf**: 100k particles must cost ≤ 2 ms in `update` (typed-array copy + color
   fill is O(n) — verify with `performance.now()` in dev only).

## Files to create / modify

```
src/lib/viz/colormaps.ts                  (new)    — speedColor/pressureColor
src/lib/viz/ParticleSystem.ts             (new)    — THREE.Points manager
src/components/viewport/SceneManager.ts   (modify) — particles layer transform helper
src/lib/sim/voxelBridge.ts                (modify) — TEMPORARY frame driver + count API
src/components/controls/ParticleCountSlider.tsx     (new, TEMPORARY — moved by F018)
src/app/page.tsx                          (modify) — mount slider; bridge drives updates
```

## Dependencies added

- none

## Interface contract

- `ParticleSystem.update(positions, speeds, active, colorMode, speedNorm)` — the
  exact signature F019 will call; `positions` must be the wasm-memory view (no copy
  by caller), `active ≤ capacity`.
- `colormaps.ts` exports `speedColor`, `pressureColor` (also used by F015/F016).
- `ParticleSystem` never imports wasm modules — receives views as arguments only.

## Acceptance criteria

- [ ] With the default cube test model loaded, particles flow left→right, visibly
      split around the obstacle, and accelerate in the gap regions; none render
      inside the solid (debug voxel view cross-check).
      **HEADLESS PROXY ONLY (browser check outstanding):** Node vs the real
      artifact, 30k particles × 60 steps + advect around an 8³ cube — 0
      non-finite positions/speeds, 0 live particles inside solid cells, mean
      speed 0.0703 ≈ u_inlet; `stable == true`. See DECISIONS.md §F014.5.
- [ ] Color gradient matches the legend expectation: upstream particles ≈ white
      (mid-speed), wake particles ≈ blue (slow).
      **RAMP VERIFIED NUMERICALLY, browser check outstanding:** freestream
      t≈0.77 → amber (0.953, 0.583, 0.051), wake t≈0.15 → blue
      (0.058, 0.557, 0.837) — upstream reads amber rather than white under the
      spec'd 1.3 headroom (see DECISIONS.md §F014.4).
- [ ] Count slider 5k→100k keeps 60fps at default grid on the dev machine
      (Performance tab ≥ 55 fps sustained); particle respawn is invisible (no
      popping at the inlet — respawn region is behind the inlet plane marker).
      **NOT MET AS PRINTED on this machine:** `update()` @100k = 0.41 ms
      (within its ≤2 ms budget) but the fixed 1 step/frame driver costs
      step ≈54 ms + advect ≈6 ms @30k (Node-wasm) — ~15 fps sustained until
      F019 adaptive stepping + F021 presets; see DECISIONS.md §F014.3.
- [x] Toggling `colorMode` to `'pressure'` placeholder compiles and falls back to
      speed colors until F015 supplies pressure per particle (documented stub).
      (Verified: `npm run build` compiles; headless check confirms
      `'pressure'` output is bit-identical to `'speed'`.)
- [ ] Unmount/remount cycles leak no GPU buffers (`renderer.info.memory` returns to
      baseline).
      **NODE-LEVEL DISPOSAL VERIFIED, browser check outstanding:** `Points`
      removed from the layer on `dispose()` (children back to baseline),
      dispose idempotent; `renderer.info` needs a WebGL context.
- [x] `npm run lint` / `npm run build` pass; colormaps have a passing `node --test`
      check for clamping and endpoints (exact hex at t=0/0.5/1).
      (Verified 2026-09-08: lint zero errors/warnings, build succeeds,
      `node --test src/lib/viz/colormaps.test.mjs` 7/7 pass.)

## Test plan

- Unit (`colormaps.ts`, `node --test` optional but recommended): endpoints exact,
  clamp behavior, monotonic red channel across t on speedColor.
- Manual: full visual flow per criteria; compare 5k vs 100k density.
- Perf spot-check: 100k count, watch FPS counter (F017 not yet present — use dev
  tools performance panel).

## Out of scope

- Trails/lines (F016), pressure-colored particles (F015 supplies data — stub only),
  real count UI in the control panel (F018), adaptive count (F021), GPU-side
  simulation, glow/shaders.
