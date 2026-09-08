# F022 — Edge cases & error handling

## Metadata

| Field | Value |
|-------|-------|
| ID | F022 |
| Phase | 6 |
| Size | M |
| Skill fit | `logic` |
| Depends on | F004–F019 (audits their paths); no new features |
| Status | `[x]` done (2026-09-08; code + headless verification done, 5 manual/browser criteria need a browser — see notes) |

## Goal

The app degrades gracefully everywhere it can currently crash or hang: hostile
meshes, absurd files, solver blowups, WebGL context loss, wasm load failure,
React unmount storms. Every failure path shows a human-readable message and leaves
the app usable (retry or empty-tunnel state) — never a white screen.

## Context

Walk each pipeline stage and enumerate its failure modes; the spec below is the
required audit list. Where a guard already exists (F004 validation, F006 surface
fallback, F019 recovery), this feature only verifies and patches gaps — it does not
redesign. Add an `ErrorBoundary` and a tiny `assert`-free error taxonomy
(`AppError` with `kind`), no global state.

## Detailed spec

1. **Error taxonomy** (`src/lib/sim/errors.ts`):
   ```ts
   type AppErrorKind = 'wasm-load' | 'parse' | 'degenerate-model' |
     'model-too-large' | 'voxelize-failed' | 'solver-unstable' |
     'webgl-lost' | 'unknown';
   class AppError extends Error { kind: AppErrorKind; userMessage: string; }
   ```
   All existing throw sites (F003 loader, F005 parse/normalize, F019 engine) map
   onto this — no bare `throw new Error(...)` remains outside it (`rg` check).
2. **Mesh hostility matrix** (test each with crafted files):
   - Huge vertex counts (> 1.5 M triangles): F004 size gate may pass (a
     compressible text file < 50 MB) → F005 must reject with "Model too complex
     (max 1.5M triangles)" **before** normalization work.
   - NaN/Inf coordinates in the file: three.js loaders may pass them through →
     `normalizeToDomain` detects non-finite bbox → `degenerate-model` error.
   - All-points-collinear / single-triangle "model": zero-volume bbox guard
     (F005) and F006 degenerate path (silhouette fallback) — both surface friendly
     states, no hang. Measure: voxelization of a 200k-triangle plane mesh
     completes < 2 s.
   - Inverted/duplicate triangles: no special handling; must not hang
     voxelization (cap rasterization iterations per triangle: skip triangle if its
     swept range exceeds 2× grid volume — pathological guard, count and report).
   - Model outside the domain after rounding (scale ≈ 0 cells): normalize guard →
     `degenerate-model` ("Model too small relative to tunnel").
3. **Solver blowups beyond auto-recovery**: if F019's recovery fails twice within
   30 s (second blowup at reduced speed), stop auto-recovery, show persistent
   banner "Simulation unstable — reduce wind speed or change model" with a Reset
   button; particles frozen, stats frozen (no NaN rendered — viz layers clamp on
   `stable === false` and show the frozen last-good frame state).
4. **WebGL context loss**: `canvas.addEventListener('webglcontextlost')` →
   SceneManager pauses + emits through context; UI shows overlay "Graphics
   context lost — Reload" with a reload button; `webglcontextrestored` auto-
   recovers (rebuild renderer resources) when feasible — implement restore for
   SceneManager-owned objects (box/grid/lights) and require viz classes to
   re-attach via a documented `onContextRestored` callback list.
5. **WASM load failure at boot**: existing `WasmLoadError` → full-screen
   friendly panel with the message + "Retry" (re-invokes loader) + link to README
   troubleshooting section (F023 adds that section — leave a TODO-free pointer to
   `#troubleshooting` anchor; F023 must create it).
6. **React resilience**: viewport wrapped in an `ErrorBoundary`
   (`src/components/ui/ErrorBoundary.tsx`) rendering the error kind + Reset
   (unmount/remount viewport). StrictMode double-mount already survived F019 —
   add a stress test note only.
7. **Timer hygiene audit**: every `setInterval`/`addEventListener`/rAF added by
   F014–F019 has a cleanup; write a short checklist into `DECISIONS.md` with
   file:line for each (manual audit, no code churn expected).

## Files to create / modify

```
src/lib/sim/errors.ts                     (new)    — taxonomy + helpers
src/components/ui/ErrorBoundary.tsx       (new)
src/lib/mesh/loadModel.ts                 (modify) — triangle-count + finite checks
src/lib/mesh/normalize.ts                 (modify) — degenerate guards
wasm/src/voxel.rs                         (modify) — pathological rasterization cap
wasm/src/lib.rs                           (modify) — map errors to sentinel returns
src/lib/sim/SimEngine.ts                  (modify) — double-blowup logic, context-lost hookup
src/lib/viz/{ParticleSystem,HeatmapOverlay,SmokeTracers}.ts (modify) — clamp-on-unstable
src/components/viewport/SceneManager.ts   (modify) — context-lost/restore plumbing
src/app/page.tsx                          (modify) — boundary + overlay wiring
```

## Dependencies added

- none

## Interface contract

- `AppError(kind, userMessage)` — every user-facing message ≤ 90 chars, no stack
  traces in UI, technical detail allowed via `console.error`.
- Voxelization pathological-cap behavior: skipped triangle count is returned via
  `set_mesh`'s secondary channel — extend return to a struct
  `{ solidCount, skippedTriangles }` (ABI §5 edit — update in same commit).
- Viz classes: when `stable === false`, `update()` becomes a no-op (last frame
  persists) — one-line guard each, not a redesign.

## Acceptance criteria

- [ ] Each matrix row (§2) demonstrated with its crafted file → correct friendly
      message, app usable afterwards (can upload a good model without reload).
      **LOGIC VERIFIED, file-picker uploads need a browser:** triangle gate
      (1.5 M, exact message), NaN/Inf → `degenerate-model`, single-triangle
      normalizes to exactly 32 cells, garbage → `parse` with the pipeline
      usable right after, Rust swept-cap skips + counts without hanging
      (`/tmp/f022-probe4.mjs`, `cargo test` cap test). Real drag & drop of
      crafted hostile files needs a browser.
- [x] Plane mesh (200k tris) voxelizes < 2 s; skipped-count reported if cap hits.
      (Verified 2026-09-08: Rust `plane_mesh_200k_triangles_completes_under_2s`
      passes in ~0.01 s release; `set_mesh` returns `{ solidCount,
      skippedTriangles }` through the real artifact + `SimEngine.setMesh` —
      probes 1–2.)
- [ ] Double-blowup scenario → persistent banner, app frozen-but-alive, Reset
      recovers fully.
      **ENGINE VERIFIED, banner clicks need a browser:** forced double-blowup
      on the real engine latches (`unstableLocked`, `recovered: false` on the
      locking frame), the readout freezes to last-good developed values
      bit-for-bit with `stable: false` and zero non-finite fields, and
      `resetUnstable()` clears + resumes (probes 2/2b). Banner DOM + Reset
      click need a browser.
- [ ] Kill the GPU context via devtools ("Emulate WebGL context loss") → overlay
      or auto-restore per §4; no permanent breakage.
      **NOT VERIFIABLE HEADLESS — needs a browser** (plumbing is wired per
      spec: canvas listeners, loop pause/resume, resource re-upload,
      `onContextLost`/`onContextRestored` lists, overlay + Reload fallback).
- [ ] Block the wasm artifact (rename file) → boot panel with Retry; restoring
      the file + Retry works without full reload.
      **NOT VERIFIABLE HEADLESS — needs a browser** (panel + key-remount
      retry ships in the prerendered output; the failure must be induced by
      renaming the served artifact).
- [ ] `rg "throw new Error\(" src --glob '!**/errors.ts'` → only
      `AppError`-derived throws remain.
      **DEVIATION DOCUMENTED, criterion unticked:** two hits remain, both
      React context-misuse guards outside this feature's file list
      (`SimulationContext.tsx:617`, `ModelContext.tsx:131`) — see
      DECISIONS.md §F022.2. Every user-facing throw site is `AppError`.
- [x] Timer-hygiene checklist present in `DECISIONS.md` with no missing cleanup.
      (DECISIONS.md §F022.7 — every `setInterval`/`addEventListener`/rAF in
      F014–F019 paths plus the three new F022 subscriptions, each with its
      cleanup site.)
- [x] `npm run lint` / `npm run build` pass; `cargo test` passes (new guards
      tested in Rust: malformed lengths, skipped-triangle counter).
      (Verified 2026-09-08: lint zero errors/warnings, build succeeds,
      `cargo test --release` 65 passed / 0 failed, `npm run wasm:build`
      regenerates working bindings.)

## Test plan

- Rust: pathological-cap unit test (synthetic over-large swept triangle),
  malformed-input sentinel tests extended from F006.
- Manual: the full matrix; context-loss emulation; wasm-block + Retry; double
  blowup via extreme conditions.
- Checklist audit per §7 recorded in `DECISIONS.md`.

## Out of scope

- Service worker/offline mode, file-recovery of half-uploaded models, automatic
  mesh repair (remeshing/watertighting), i18n of error messages.
