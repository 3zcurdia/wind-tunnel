# F015 — Surface pressure heatmap

## Metadata

| Field | Value |
|-------|-------|
| ID | F015 |
| Phase | 4 |
| Size | S |
| Skill fit | `UI/3D` |
| Depends on | F005 (model in scene), F012 (vertex pressure + anchors), F014 (colormaps) |
| Status | `[ ]` todo |

## Goal

The model surface becomes the classic wind-tunnel color map: blue where pressure is
low, red where high, white at ambient — updated live as the flow develops, with a
legend (gradient bar + min/max/ambient labels) and a toggle. The heatmap reads the
wasm vertex-pressure view through the (temporary) bridge; F019 relocates the driver.

## Context

Rust already produces per-vertex Pa values and anchors (`pressure_anchors()`,
F012). Normalization for display: `t = clamp((p − p_min) / max(p_max − p_min, q_ref
× 0.25), 0, 1)` — the denominator floor keeps the map meaningful before the flow
develops (documented choice; symmetric diverging behavior around ambient is
approximated by the anchors' signs). `pressureColor` from F014 provides the ramp.

## Detailed spec

1. **`HeatmapOverlay.ts`** (class):
   - `attach(geometry: THREE.BufferGeometry)`: adds/overwrites a `color` attribute
     (3·vertexCount, `DynamicDrawUsage`) on the model geometry; switches the model
     material to `vertexColors: true` (SceneManager exposes
     `setModelVertexColors(on: boolean)` handling material flags — add it).
   - `update(pressure: Float32Array, anchors: {pMin, pMax, qRef})`: throttled to
     every 3rd frame; fills colors via `pressureColor(t)`; marks needsUpdate.
   - `clear()`: removes attribute, restores base material color.
   - Registered in `getLayer('meshModel')` scope (colors live on the model mesh
     itself; the class holds no scene nodes — only attribute writes).
2. **Legend UI** (`src/components/controls/PressureLegend.tsx`):
   - Vertical gradient bar (CSS `linear-gradient(to top, #2563eb, #f3f4f6, #dc2626)`)
     h-40 w-4, labels: top = `p_max` in kPa (2 decimals), bottom = `p_min` kPa,
     middle = "ambient". Under it, "q_ref ≈ X kPa" caption.
   - Updates at 4 Hz from the bridge's cached anchors (temporary driver; F019's
     stats feed replaces this — keep the component props-driven:
     `props: { pMinPa, pMaxPa, qRefPa }`).
   - Toggle: checkbox "Surface pressure" →
     `SceneManager`/bridge routes `HeatmapOverlay.attach/clear`. Temporary mount in
     Controls rail (F018/F020 move it).
3. **Driver** (temporary, in `voxelBridge`): per frame → read
   `vertex_pressure_ptr` view + `pressure_anchors()` → call
   `HeatmapOverlay.update` + notify legend subscribers at 4 Hz.
4. **Legend updates must not re-render the scene tree** — legend is plain DOM,
   fine; but React state updates at 4 Hz are acceptable (small subtree).

## Files to create / modify

```
src/lib/viz/HeatmapOverlay.ts             (new)    — attribute writer
src/components/controls/PressureLegend.tsx          (new)
src/components/viewport/SceneManager.ts   (modify) — setModelVertexColors
src/lib/sim/voxelBridge.ts                (modify) — TEMPORARY heatmap driver
src/app/page.tsx                          (modify) — mount legend + toggle
```

## Dependencies added

- none

## Interface contract

- `HeatmapOverlay.update(pressure: Float32Array, anchors: {pMinPa, pMaxPa, qRefPa})`
  — exact shape F019 will call.
- `PressureLegend` is pure props-driven (no wasm imports).
- The `color` attribute name must be `color` (three.js convention for
  `vertexColors: true`).

## Acceptance criteria

- [ ] Sphere at defaults: upstream pole visibly red, downstream wake visibly blue,
      lateral surfaces near-white — after ~2 000 steps the pattern is stable.
- [ ] Toggle off restores the plain gray material exactly (no color residue).
- [ ] Legend numbers move during spin-up and freeze at plausible values (p_max
      within ±30 % of q_ref at defaults).
- [ ] No visible shimmer/color noise: throttled updates don't fight the material.
- [ ] Model with unmapped vertices (leaky/surface-mode mesh) renders those
      vertices mid-gray (t = 0.5) — not black/garbage.
- [ ] Swapping models clears + re-attaches cleanly (no stale attribute on a new
      geometry with different vertex count — must not crash or miscolor).

## Test plan

- Manual: sphere visual per criteria; toggle on/off ×3; swap sphere→cube→sphere.
- Manual: confirm legend kPa ≈ hand-computed q_ref ≈ 135 Pa at defaults.
- Unit (optional): normalization `t` formula as a pure exported function
  `normalizePressure(p, anchors)` with clamp tests.

## Out of scope

- Per-particle pressure coloring (F014 stub stays), velocity-on-surface mode,
  contour lines, isosurfaces, legend for velocity mode, smooth normal-based
  interpolation beyond vertex colors.
