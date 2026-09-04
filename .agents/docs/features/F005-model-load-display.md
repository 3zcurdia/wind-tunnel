# F005 — Parse, display & normalize model

## Metadata

| Field | Value |
|-------|-------|
| ID | F005 |
| Phase | 1 |
| Size | S |
| Skill fit | `UI/3D` |
| Depends on | F002 (SceneManager), F004 (LoadedFile + context) |
| Status | `[ ]` todo |

## Goal

When a valid file lands in `ModelContext`, it is parsed with three.js loaders, shown
in the viewport, and normalized into **domain space** ready for voxelization. The
upload panel shows triangle/vertex counts; parse failures surface as the upload
panel's error state.

## Context

Implements the "model space → domain space" mapping from `ARCHITECTURE.md` §3.
Domain space targets a fixed placement region: the model must fit inside the box
centered at `(0.35·nx, ny/2, nz/2)` with its **longest bbox side = 0.25·nx lattice
cells** (nx=128 → 32 cells). SceneManager maps lattice→world (1 cell = 0.1 world
units), so the same normalized geometry renders in the right place. three.js loaders
live in `three/addons/loaders/{OBJLoader,PLYLoader}.js` — import them dynamically to
keep the main bundle lean.

## Detailed spec

1. **`src/lib/mesh/loadModel.ts`**:
   ```ts
   export interface ParsedModel {
     geometry: THREE.BufferGeometry;   // non-indexed where loaders produce it; keep as-is
     vertices: number;                 // position count
     triangles: number;                // index/3 (or positions/9 when non-indexed)
   }
   export async function parseModel(file: LoadedFile): Promise<ParsedModel>
   ```
   - `format === 'obj'`: `OBJLoader().parse(decode buffer as UTF-8 text)` → it may
     return a `Group` of child meshes → merge all child geometries' positions/indices
     into one `BufferGeometry` (use `BufferGeometryUtils.mergeGeometries` from
     `three/addons/utils/BufferGeometryUtils.js`).
   - `format === 'ply'`: `PLYLoader().parse(buffer)` → `BufferGeometry` directly
     (handles both ASCII and binary PLY).
   - Throw `ModelParseError` (typed) with the loader's message on garbage input.
   - If geometry has no `index`, keep non-indexed but report `triangles = position.count / 3`.
2. **`src/lib/mesh/normalize.ts`**:
   ```ts
   export interface NormalizedModel {
     geometry: THREE.BufferGeometry;    // domain-space copy
     transform: { scale: number; translation: [number, number, number] };
     bboxLattice: { min: Vec3; max: Vec3 };  // AABB in lattice cells
   }
   export function normalizeToDomain(geometry: THREE.BufferGeometry): NormalizedModel
   ```
   - Constants: `NX = 128, NY = 48, NZ = 48` (single source: export from
     `src/lib/sim/types.ts` as `DOMAIN = { nx, ny, nz }` — F021 makes these runtime
     later; they are constants here).
   - Algorithm: compute bbox → uniform scale so longest side = 0.25·NX → translate so
     bbox center lands at `(0.35·NX, NY/2, NZ/2)` → clone geometry, `applyMatrix4`
     (translate·scale composed). Zero-size bbox (degenerate) → throw
     `DegenerateModelError`.
   - Y/Z axes: three.js is Y-up; the tunnel is Z-up visually. SceneManager renders the
     domain with Z-up already accounted for by F002's box orientation — normalization
     does **not** swap axes; it maps model Y→lattice Y. (Camera/lighting in F002
     already treats Y as up.)
3. **SceneManager additions** (extend, don't bypass):
   ```ts
   showModel(geometry: THREE.BufferGeometry): void   // replaces previous model
   clearModel(): void
   ```
   - Mesh: `MeshStandardMaterial` (`color #9ca3af`, `metalness 0.1`, `roughness 0.65`,
     `flatShading true`), added to `getLayer('meshModel')`. `geometry.computeVertexNormals()`
     if missing. Center camera target on the model: set OrbitControls target to the
     model's world position and keep current camera offset.
4. **Pipeline hook** (`src/lib/hooks/useModelPipeline.ts` — temporary name; F019 will
   absorb it): subscribes to `ModelContext`; on new valid file: `parseModel` →
   `normalizeToDomain` → `sceneManager.showModel` → set `meta { triangles, vertices }`
   in ModelContext; on parse error → set context error state; on `clear()` →
   `clearModel()`.
   - Rendering must be async-safe: ignore stale files (generation counter).
   - This module is the **only** bridge between `ModelContext` and `SceneManager`
     until F019 replaces it with the unified loop.
5. **SceneManager instantiation**: F002 created it inside `Viewport`; expose a
   `viewportBridge` — a module-level `RefObject`-style accessor
   (`src/components/viewport/viewportBridge.ts`) where `Viewport.tsx` registers the
   live `SceneManager` instance and the pipeline reads it (or `null` before mount).
   Keep it minimal — no React state involved.

## Files to create / modify

```
src/lib/sim/types.ts                      (modify) — DOMAIN constant, error types
src/lib/mesh/loadModel.ts                 (new)    — parseModel
src/lib/mesh/normalize.ts                 (new)    — normalizeToDomain
src/components/viewport/SceneManager.ts   (modify) — showModel/clearModel
src/components/viewport/viewportBridge.ts (new)    — live instance accessor
src/lib/hooks/useModelPipeline.ts         (new)    — file → scene pipeline
src/app/page.tsx                          (modify) — run pipeline hook
src/components/controls/UploadPanel.tsx   (modify) — render meta counts + parse errors
```

## Dependencies added

- none (three.js already present from F002)

## Interface contract

- `parseModel(file: LoadedFile): Promise<ParsedModel>`; rejects with
  `ModelParseError | DegenerateModelError` (both extend `Error`, exported from
  `src/lib/sim/types.ts`).
- `normalizeToDomain(geometry): NormalizedModel` — geometry positions are mutated
  clones; caller owns the input.
- `SceneManager.showModel/clearModel` — idempotent; calling twice replaces cleanly
  (dispose old geometry/material).

## Acceptance criteria

- [ ] A known-good OBJ (e.g. a low-poly sphere from any public source or generated
      for testing) uploads and renders centered in the domain box, inside the
      placement region, sized ≈ 1/4 of the box's X length.
- [ ] A binary PLY of the same object renders identically (swap formats in test).
- [ ] Upload panel now shows triangle and vertex counts matching the file.
- [ ] Uploading a text file renamed to `.obj` → parse error appears in the upload
      panel (red), previous model (if any) is untouched.
- [ ] Remove + re-upload cycles leak no geometry (`renderer.info.memory` stable, no
      console warnings).
- [ ] A multi-object OBJ (Group with 2+ meshes) renders as one merged body.
- [ ] `npm run lint` / `npm run build` pass.

## Test plan

- Manual (core): generate a unit sphere OBJ offline (or `public/samples` scratch file
  outside git), verify placement/size visually against the domain box.
- Manual: corrupt-file and non-watertight cases above.
- Optional unit: `normalizeToDomain` bbox math on a synthetic 2×1×1 box geometry —
  assert scale = 32, center = (44.8, 24, 24) ± 0.01.
- No WASM involved; `cargo test` unaffected.

## Out of scope

- Voxelization (F006), material color changes for heatmap (F015), merge-vertices
  optimization, Draco/compressed formats, loading state modals (inline states only).
