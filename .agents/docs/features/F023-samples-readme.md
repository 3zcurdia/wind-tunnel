# F023 — Built-in sample models + README

## Metadata

| Field | Value |
|-------|-------|
| ID | F023 |
| Phase | 6 |
| Size | S |
| Skill fit | `docs` |
| Depends on | F019 (pipeline), F022 (error paths stable) |
| Status | `[x]` done (2026-09-08; code + headless verification done, 5 visual/browser criteria need a browser — see notes) |

## Goal

The app is demoable without any file on hand: a "Samples" section offers Sphere,
Cube, and Teardrop (car-ish body) generated procedurally client-side, flowing the
moment they're clicked. The README becomes the real project front door: what this
is, how to run it (including wasm-pack prerequisites), architecture pointer, and a
troubleshooting section (the `#troubleshooting` anchor F022 links to).

## Context

Samples are generated with three.js geometry APIs (no binary assets in git —
procedural keeps the repo clean and the files tiny). They bypass the upload panel:
same pipeline entry point (`parseModel` output shape), different producer. Teardrop:
lathe geometry approximating a rounded car-like body (parameterized LatheGeometry
profile — aesthetic, not precise).

## Detailed spec

1. **`src/lib/mesh/samples.ts`**:
   ```ts
   export type SampleId = 'sphere' | 'cube' | 'teardrop';
   export interface SampleDef { id: SampleId; label: string; description: string }
   export const SAMPLES: SampleDef[];
   export function buildSampleGeometry(id: SampleId): THREE.BufferGeometry
   ```
   - `sphere`: `SphereGeometry(0.5, 48, 32)` (vertex-count sane for heatmap).
   - `cube`: `BoxGeometry(0.5, 0.5, 0.5, 1, 1, 1)` — face-on to the wind (+X face
     normal along X — three.js box faces align; verify visually).
   - `teardrop`: `LatheGeometry` profile — rounded nose (radius ramp), cylindrical
     mid-section, tapering tail; oriented along X (lathe produces Y-axis body →
     rotate geometry −90° about Z so the long axis is X; nose faces −X upstream).
     ~64 profile points × 48 segments.
   - All returned as non-indexed-friendly BufferGeometry with positions + index,
     ready for `normalizeToDomain`.
2. **Samples UI**: `SampleGallery.tsx` in the Controls rail above/inside the Model
   panel: three cards (label + one-line description); click → builds geometry →
   feeds the same pipeline as uploads (sets a synthetic `LoadedFile`-like entry:
   `{ name: 'Sample: Sphere', format: 'obj', data: encoded OBJ? }` — decision: do
   **not** fake a file; instead extend `ModelContext` with
   `loadSample(id: SampleId)` that places the parsed geometry directly into the
   pipeline state (meta counts included). Upload and sample paths converge at
   "normalized geometry ready".)
   - Active sample highlighted; uploading a file deselects samples.
3. **README rewrite** (`README.md`, replace scaffold text):
   - Hero: one-paragraph vision (from ROADMAP) + screenshot placeholder comment.
   - Features list (particles, heatmap, smoke, stats, tunables).
   - Quick start: `npm install`, `npm run dev`; prerequisites: Node 20+, Rust
     toolchain + `wasm-pack` (install commands), `npm run wasm:build` before first
     Rust-dependent run; note that generated `src/wasm/` is gitignored.
   - Architecture section: link `.agents/docs/ARCHITECTURE.md` (data-flow diagram
     reference) and `.agents/docs/ROADMAP.md` for the feature map.
   - **`## Troubleshooting`** section (anchor target for F022): wasm load failure
     (`npm run wasm:build` missing → exact error text), WebGL2 unsupported
     (browser list), blank viewport (hardware acceleration toggle), perf tips
     (quality presets, F021).
   - "Not industrial CFD" disclaimer sentence.
4. **Docs polish**: ROADMAP gets a "Demo script" appendix — a 10-step click-path
   for presenting the app (open → sample sphere → tune speed → toggle layers →
   read stats). Keep it in ROADMAP (project-level doc), not README.

## Files to create / modify

```
src/lib/mesh/samples.ts                   (new)
src/components/controls/SampleGallery.tsx (new)
src/lib/sim/ModelContext.tsx              (modify) — loadSample path
src/lib/hooks (F019 engine)               (modify) — accept sample geometry into pipeline
src/app/page.tsx                          (modify) — mount gallery
README.md                                 (rewrite)
.agents/docs/ROADMAP.md                   (modify) — demo script appendix
```

## Dependencies added

- none

## Interface contract

- `buildSampleGeometry(id)` returns geometry equivalent in shape to `parseModel`
  output (has position, index, computable normals) — the pipeline accepts either
  source via the converged "normalized geometry ready" state.
- `ModelContext.loadSample(id)` and `file` are mutually exclusive (latest wins);
  `clear()` resets both.
- README troubleshooting anchor `#troubleshooting` exists exactly once.

## Acceptance criteria

- [ ] Fresh clone + README quick-start commands → running app (Rust prerequisite
      steps are accurate — follow them literally on a clean machine or careful
      simulation of one).
      **NOT VERIFIED HERE — needs a clean machine:** the commands match the
      pinned toolchain (`wasm-pack build wasm --target web --out-dir ../src/wasm`
      per `package.json`) and the verified F003 pipeline by inspection; no
      clean-clone run was performed in this environment.
- [ ] Each sample flows immediately when clicked: sphere shows the classic
      stagnation/wake heatmap; cube shows strong separation; teardrop shows
      smoother attached flow with lower cd than the cube (read from stats panel —
      teardrop cd < cube cd at defaults).
      **NOT VERIFIABLE HEADLESS — needs a browser** (pipeline wiring is per
      spec: sample → normalize → `setMesh` → `resetFlow` → `play()` through the
      single `useSimulation` effect; heatmap/Cd readouts need live rendering).
- [ ] Sample ↔ upload interplay: uploading after a sample replaces it; samples
      gallery deselects on upload; no stale geometry (swap 6× fast — no crash).
      **NOT VERIFIABLE HEADLESS — needs a browser** (mutual exclusivity holds
      by construction: `setFile` clears `sample`, `loadSample` clears `file`
      and bumps the generation guard so in-flight reads are abandoned).
- [ ] Teardrop is visually car-ish and nose-upstream (wind from left hits the
      rounded end).
      **GEOMETRY VERIFIED, aesthetics need a browser:** headless probe confirms
      long axis = X (1.0 vs 0.5 diameter), nose pole at −X (upstream, wind
      blows +X), closed poles, 64×48 lathe resolution; "car-ish" is a human
      visual call.
- [x] README renders correctly on GitHub (tables, anchors); no leftover
      create-next-app text.
      (Verified 2026-09-08 by inspection: single `## Troubleshooting` heading
      → `#troubleshooting` anchor, tables/commands intact, no scaffold text;
      only change from the pre-existing draft is the WebGL2 browser list.)
- [ ] Demo script in ROADMAP is followable step-by-step (a person who has never
      seen the app completes it in < 3 minutes).
      **WRITTEN, NOT USER-TESTED:** the 10-step appendix follows the shipped UI
      order (samples → stats → sliders → toolbar → presets → upload); no fresh
      person has timed it.

## Test plan

- Unit (`samples.ts`): each geometry has > 0 vertices, finite bbox, index
  divisible by 3, teardrop long-axis = X.
  (Verified 2026-09-08: headless node probe imports the real module — all
  three geometries pass every check, plus a `normalizeToDomain` smoke check
  on each sample.)
- Manual: all criteria; follow the demo script verbatim as written.

## Out of scope

- Sample files with external URLs, GLTF/Draco samples, user-uploaded gallery
  persistence, animated/moving samples, sample-specific tuned conditions.
