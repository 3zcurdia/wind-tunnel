# F021 — Quality presets (low / medium / high)

## Metadata

| Field | Value |
|-------|-------|
| ID | F021 |
| Phase | 6 |
| Size | S |
| Skill fit | `logic` |
| Depends on | F019 (context), F010 (step perf data) |
| Status | `[x]` done (2026-09-08; code + headless verification done, 4 visual/browser criteria need a browser — see notes + DECISIONS.md §F021) |

## Goal

A three-way quality switch (Low / Medium / High) in the control panel that trades
grid resolution, particle count, and smoke density against performance — persisted
to localStorage, auto-applied on first visit based on a quick device probe, with a
clear "this re-initializes the simulation" confirmation.

## Context

Grid sizes and budgets come from `ARCHITECTURE.md` §3/§7 and F010's benchmark
datapoints. Changing the grid requires full re-init (voxelization + solver state) —
the UX must say so before it happens.

## Detailed spec

1. **Preset table** (`src/lib/sim/quality.ts`):
   | Preset | Grid (nx×ny×nz) | Particles | Smoke tracers | Notes |
   |--------|-----------------|-----------|---------------|-------|
   | Low | 64×24×24 | 10 000 | 12 | τ-visualizations coarser; heatmap noisier |
   | Medium (default) | 96×36×36 | 30 000 | 25 | balanced |
   | High | 128×48×48 | 60 000 | 40 | F010 budget must hold |
   - `const QUALITY_PRESETS: Record<QualityLevel, QualitySpec>`; type
     `QualityLevel = 'low' | 'medium' | 'high'`.
   - Auto-probe (first visit only): measure one `step(8)` at Low grid right after
     engine load in a hidden warm-up — if avg_step_ms × (High grid scale factor
     ≈ 8) > 12 ms → default to Low else Medium. Simple, deterministic, documented;
     store the choice.
2. **Persistence**: localStorage key `wt.quality` (validated against known keys;
   corrupted → Medium). Apply on boot before first init.
3. **UI**: segmented control (three buttons) in ControlPanel "Quality" section;
   current selection highlighted; switching shows an inline confirm
   ("Changes grid — re-simulates from scratch. [Apply] [Cancel]") — Apply →
   context `setQuality(level)` → engine re-init sequence: `init_sim(new dims)` →
   re-voxelize current mesh (normalized geometry is cached in SimEngine from
   F019's setMesh) → `reset_flow` → `spawn_particles(preset count)` → smoke
   re-seed. Cancel → no change.
4. **Context additions**: `quality: QualityLevel`, `setQuality(level)`,
   `autoProbed: boolean` (for a one-time toast "Quality set to Low for this
   device").
5. **`DOMAIN` migration**: F005's compile-time `DOMAIN` constant becomes
   runtime-configurable — `SimEngine` holds current dims; `SceneManager` lattice→
   world mapping takes dims as a parameter (world scale stays 0.1/cell; box
   geometry rebuilt on quality change; camera presets unchanged). All consumers of
   the old constant switch to `engine.dims` / context. This is the risky part —
   enumerate consumers: SceneManager box/grid/inlet marker, ParticleSystem group
   transform, SmokeTracers rake defaults, F005 normalization target, F018 derived
   displays (unchanged — physical), StatsPanel gridDims readout.

## Files to create / modify

```
src/lib/sim/quality.ts                    (new)    — presets, probe, persistence
src/lib/sim/SimEngine.ts                  (modify) — re-init sequence, dims as state
src/lib/sim/SimulationContext.tsx         (modify) — quality API
src/components/controls/ControlPanel.tsx  (modify) — segmented control + confirm
src/components/viewport/SceneManager.ts   (modify) — dynamic domain box rebuild
src/lib/mesh/normalize.ts                 (modify) — parameterized target dims
```

## Dependencies added

- none

## Interface contract

- `QUALITY_PRESETS`, `QualityLevel`, `loadStoredQuality(): QualityLevel`,
  `storeQuality(l)`, `probeQuality(warmupStepMs): QualityLevel` — all exported,
  pure where possible (probe takes a measured number, does no wasm itself).
- `SimulationContext.setQuality` triggers exactly the re-init sequence above; no
  page reload.
- Grid dims changes must not corrupt any zero-copy pointer assumptions
  (re-fetch after init — already the §5 rule).

## Acceptance criteria

- [ ] Switching Medium→High visibly sharpens the heatmap/particles and keeps
      ≥ 45 fps on the dev machine; High→Low raises fps ≥ 1.5× at the same scene.
      **NOT VERIFIABLE HEADLESS — needs a browser** (fps + visual sharpness;
      the adaptive loop + preset grids that drive them are in place).
- [ ] Model persists across quality switch (re-voxelized, same placement —
      screenshot-comparable silhouette).
      **STRUCTURALLY PROVEN HEADLESS, screenshot needs a browser:**
      rescaled re-voxelization through the real artifact is bit-identical to
      a fresh voxelization (solid-count rel diff 0, centroids at relative
      (0.344, 0.5, 0.5) in both grids — see DECISIONS.md §F021.2); the
      display model is re-shown from the same rescaled soup. Pixel
      side-by-side outstanding.
- [x] Reload keeps the chosen preset; corrupting the localStorage value falls
      back to Medium with no crash.
      (Verified headless: `quality.test.mjs` round-trips all three tiers
      through `wt.quality`, corrupt/missing/unavailable storage all load
      Medium with no throw.)
- [ ] First visit on a slow setting (throttle CPU 20×) auto-picks Low with the
      toast; second visit does not re-toast.
      **LOGIC VERIFIED, throttle needs a browser:** probe thresholds pinned
      both sides of the 12 ms boundary (18/18 unit tests); the boot flow
      probes only when no valid key is stored and toasts exactly on a Low
      pick (code path review + build). Forcing the Low pick needs a throttled
      browser.
- [x] Cancel path changes nothing (wasm call count unchanged — dev counter).
      (By construction: Cancel only clears the panel-local pending pick —
      the handler holds no engine reference, so zero ABI calls precede
      Apply; `npm run build` type-checks the whole path. Counter check needs
      a browser.)
- [ ] All F017/F016/F014 displays remain consistent with new dims (gridDims
      readout, rake inside box).
      **PLUMBED, visual pass needs a browser:** `gridDims` comes from the
      engine's live dims; the rake clamps to `8..ny−8` on every switch and
      smoke rebuilds at the tier's tracer count (headless-verified math);
      on-screen consistency outstanding.

## Test plan

- Unit (`quality.ts`): preset table integrity, persistence round-trip + corrupt
  fallback, probe thresholds (12 ms boundary both sides).
- Manual: the criteria list; both switch directions with a sphere loaded.

## Out of scope

- Custom grid sizes beyond presets, separate particle-quality, automatic live
  downgrading mid-run (manual switch only), resolution scaling of the renderer.
