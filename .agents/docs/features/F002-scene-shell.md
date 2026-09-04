# F002 — Three.js scene shell

## Metadata

| Field | Value |
|-------|-------|
| ID | F002 |
| Phase | 0 |
| Size | S |
| Skill fit | `UI/3D` |
| Depends on | F001 |
| Status | `[ ]` todo |

## Goal

A live three.js scene renders inside the page's viewport area: orbit-controllable
camera, domain box outline (the wind tunnel volume), ground grid, and lighting —
animated at 60fps, resizing with the window, and disposed cleanly. This provides the
rendering foundation every visualization feature builds on.

## Context

Per `ARCHITECTURE.md`: `SceneManager` is the only module touching three.js scene
objects; `Viewport.tsx` is the only React component that mounts it. This Next.js
version differs from training data — before writing client-only code read:
`node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`
and `node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md`. Key confirmed rule:
`next/dynamic` with `ssr: false` **only works inside a Client Component**.

Coordinate mapping (ARCHITECTURE.md §3): the domain is `nx × ny × nz = 128 × 48 × 48`
lattice cells with flow along +X. SceneManager maps 1 lattice cell → 0.1 world units,
so the domain box renders as 12.8 × 4.8 × 4.8, centered at the world origin.

## Detailed spec

1. `npm install three @types/three` (dev types as devDependency).
2. **`SceneManager.ts`** — a class, constructor takes the canvas element:
   - `WebGLRenderer` (`antialias: true`, `alpha: false`, `powerPreference: 'high-performance'`), `setPixelRatio(min(devicePixelRatio, 2))`, sRGB output.
   - `Scene` with background color `#0b0d10` and subtle fog (`FogExp2`, density 0.015).
   - `PerspectiveCamera` (fov 50, near 0.1, far 200) at position `(14, 7, 14)`,
     looking at domain center.
   - `OrbitControls` from `three/addons/controls/OrbitControls.js` — damping enabled
     (`dampingFactor 0.08`), target at domain center, min/max distance 2–60.
   - Lights: hemisphere light (sky `#cfe8ff`, ground `#202020`, intensity 0.9) +
     directional light from `(8, 12, 6)` intensity 1.2, no shadows (v1).
   - **Domain box**: `LineSegments` from `EdgesGeometry(BoxGeometry(12.8, 4.8, 4.8))`,
     color `#3b82f6` (blue-500), opacity 0.6, positioned centered at origin.
   - **Ground grid**: `GridHelper` (size 20, divisions 40, colors `#1f2937`/`#111827`)
     at `y = -2.4` (domain bottom plane).
   - **Inlet plane marker**: a subtle `Mesh` plane (1 × 4.8 × 4.8, wireframe,
     `#22d3ee`, opacity 0.25) at the domain's −X face — hint of where wind enters.
   - Public API (exact):
     ```ts
     class SceneManager {
       constructor(canvas: HTMLCanvasElement)
       start(): void                      // begins rAF render loop
       stop(): void                       // cancels rAF
       dispose(): void                    // full teardown (renderer, controls, listeners)
       onFrame(cb: (dtSeconds: number) => void): () => void  // subscribe; returns unsubscribe
     }
     ```
   - The internal loop calls subscribed callbacks (future viz features) with frame
     delta, then `renderer.render`. If `document.hidden`, skip rendering.
   - Resize: `ResizeObserver` on the canvas parent → update camera aspect + renderer
     size. Remove observer in `dispose`.
3. **`Viewport.tsx`** — client component (`"use client"`):
   - Renders `<canvas className="h-full w-full block">` filling its container.
   - In `useEffect`: instantiate `SceneManager` (dynamic `import('./SceneManager')` to
     keep three.js out of the server bundle), `start()`, return cleanup calling
     `stop()` + `dispose()`.
   - Exported **default** through a wrapper: page imports it via
     `dynamic(() => import('@/components/viewport/Viewport'), { ssr: false })` from a
     small client-component parent `ViewportMount.tsx` (per lazy-loading guide), with
     a loading fallback of a centered "Loading 3D viewport…" text.
4. **Page integration**: replace the F001 viewport placeholder box with
   `<ViewportMount />` filling the flex area (`min-h-[70vh]`). Keep F001 placeholders
   for controls/stats untouched.
5. **Layer scaffolding**: SceneManager exposes a `getLayer(name: DomainLayers)` that
   returns a `THREE.Group` for future features — pre-create groups `particles`,
   `meshModel`, `smoke`, `debug` and add all to the scene. Empty for now.

## Files to create / modify

```
src/components/viewport/SceneManager.ts   (new)    — scene owner class
src/components/viewport/Viewport.tsx      (new)    — canvas + client mount
src/components/viewport/ViewportMount.tsx (new)    — dynamic ssr:false wrapper
src/app/page.tsx                          (modify) — viewport placeholder → ViewportMount
package.json                              (modify) — three + @types/three
src/components/viewport/.gitkeep          (delete)
```

## Dependencies added

- `three` (runtime) — rendering engine
- `@types/three` (dev) — types

## Interface contract

- `SceneManager` public API exactly as specified above (later features extend via new
  methods, never by bypassing it).
- `getLayer(name)` accepts `'particles' | 'meshModel' | 'smoke' | 'debug'`.
- `ViewportMount` renders full-size with no scrollbars; must work inside any flex
  container that gives it height.

## Acceptance criteria

- [ ] Browser shows a 3D scene: blue wireframe domain box, ground grid, inlet plane
      marker; camera orbits with mouse (drag = rotate, wheel = zoom).
- [ ] Resizing the browser window keeps the scene filling the viewport without
      distortion.
- [ ] Rendering stops (rAF cancelled, GPU memory released) when the component
      unmounts — verify via React DevTools unmount + no WebGL context leak warnings.
- [ ] Page loads with no SSR errors and no `window is not defined` errors.
- [ ] `npm run lint` and `npm run build` pass.

## Test plan

- Manual: dev server, orbit/zoom the scene, resize window, confirm visuals above.
- Manual: comment out the mount, hard-refresh, confirm no three.js code fetched
  (Network tab) — proves ssr:false split.
- No automated tests required (visual feature).

## Out of scope

- Loading/normalizing user models (F005), any particles/heatmap/smoke (Phase 4),
  any WASM interaction (F003), camera preset tweening (F020 — keep OrbitControls
  simple now), shadows and post-processing.
