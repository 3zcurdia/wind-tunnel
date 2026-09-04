# F019 — Simulation loop orchestration

## Metadata

| Field | Value |
|-------|-------|
| ID | F019 |
| Phase | 5 |
| Size | M |
| Skill fit | `glue` |
| Depends on | F003–F018 (the integration feature: lands after everything it wires) |
| Status | `[ ]` todo |

## Goal

Replace all temporary bridges/probes with the real runtime: `SimEngine` owns the
WASM instance and every ABI call; `useSimulation` runs the rAF loop with adaptive
steps-per-frame; `SimulationContext` exposes state/actions to React; divergence
auto-recovers; the full pipeline (upload → voxelize → simulate → visualize) works
end-to-end driven by real code.

## Context

This feature *is* `ARCHITECTURE.md` §6. It deletes every `TEMPORARY` artifact
created by F003/F006/F011/F014/F015/F016/F017 and the `useModelPipeline` from F005.
The only allowed surviving pattern: React ↔ context ↔ SimEngine ↔ wasm, and
SceneManager ↔ viz classes. Read §6 again before starting.

## Detailed spec

1. **`SimEngine.ts`** (singleton class, all wasm calls move here):
   - Lifecycle: `await loadWasm()` → `init_sim(DOMAIN, particleCapacity)` →
     `set_conditions(defaults)` → `reset_flow()`.
   - Model API: `setMesh(geometry: THREE.BufferGeometry)` — builds the triangle
     f32 array (from F005's normalized geometry), calls wasm `set_mesh`, stores
     solid count + surface flag + re-fetches pointers.
   - Conditions API: `setConditions(params)` → wasm `set_conditions` → store
     `LatticeParams` + compute `speedNorm = [0, 1.3 × u_inlet_lattice × ...]`
     anchors for F014; viscosity flag → caller triggers `resetFlow()` (semantics
     stay in the caller to keep SimEngine dumb? No — **decision**: `setConditions`
     returns `{ viscosityChanged: boolean }` and SimEngine performs the
     `reset_flow()` itself when viscosity changed. Document here if deviating).
   - Transport: `play()`, `pause()`, `resetFlow()`, `resetAll()`.
   - `tick(budgetMs: number): TickResult` — the frame unit:
     1. if running: choose `steps` (adaptive: start 2; if `avg_step_ms × steps`
        > budgetMs×0.6 → halve steps (min 1); if < 0.25× → double (max 8));
     2. `wasm.step(steps)`; check `is_stable()` → if false: `pause()` +
        reduce u_mps to 50 % + `setConditions` + `resetFlow()` + mark
        `recovered: true` in the result (one recovery per 5 s max — counter);
     3. `advect_particles(dt)`; respawn to target count (≤ 2 000/frame);
     4. refresh buffer views; return
        `{ stepsRun, recovered, activeParticles, stable }`.
   - Readout: `getReadout()` assembling `SimReadout` (F017's type) from wasm stats
     + timing + fps EMA (rAF deltas measured in the loop).
2. **`useSimulation.ts`** (hook, mounted once in `page.tsx`):
   - `useEffect`: create engine, load, subscribe `SceneManager.onFrame` →
     `engine.tick(12)` (12 ms solver budget of the 16.7 ms frame), then drive viz:
     ParticleSystem.update, HeatmapOverlay.update (every 3rd frame),
     SmokeTracers.update; render happens inside SceneManager's loop already.
   - Cleanup on unmount: engine.dispose (cancel rAF ref, wasm instance kept —
     reload is cheap; document choice: keep instance, re-init on remount).
   - Handles pipeline events from `ModelContext` (absorbing F005's
     `useModelPipeline`): parse → normalize → `engine.setMesh` → `resetFlow` →
     `play()`.
3. **`SimulationContext.tsx`**: provides
   `{ ready, error, readout (4 Hz), conditions, setConditions, transport,
   particleCount, setParticleCount, smoke*, heatmapToggle }` — every temporary
   control's data path now runs through here (F014's slider, F016's controls,
   F015's toggle, F018's panel all consume this single context).
4. **Deletions** (the point of this feature):
   `voxelBridge.ts`, `WasmProbe.tsx`, `VoxelDebugToggle.tsx` (voxel debug view
   stays but moves behind F020's layer toggle — keep `SceneManager.setVoxelDebugVisible`),
   `useModelPipeline.ts`, `SmokeProbe.tsx`, all temporary rAF drivers in viz
   classes' call-sites.
5. **Error surface**: wasm load failure / parse failure / unstable-recovery toasts
   (simple top-right toast list, `src/components/ui/Toast.tsx`, auto-dismiss 4 s).
6. **Bootstrap UX**: "Loading engine…" overlay over the viewport until
   `ready === true`; first-run flow: empty domain + uniform particles running
   (no mesh) so the app is alive immediately.

## Files to create / modify

```
src/lib/sim/SimEngine.ts                  (new)    — the wasm owner
src/lib/hooks/useSimulation.ts            (new)    — rAF orchestration
src/lib/sim/SimulationContext.tsx         (modify) — full API (F004 skeleton extended)
src/components/ui/Toast.tsx               (new)
src/app/page.tsx                          (modify) — real wiring, overlay, toasts
DELETE: src/lib/sim/voxelBridge.ts, WasmProbe.tsx, VoxelDebugToggle.tsx,
        useModelPipeline.ts, SmokeProbe.tsx, temporary drivers in F014/F015/F016
```

## Dependencies added

- none

## Interface contract

- `SimulationContext` API exactly as §3 above (F018/F020/F021 build against it).
- `SimEngine.tick(budgetMs)` — single entry point per frame; no other wasm calls
  from the loop.
- Adaptive stepping bounds: 1–8 steps/frame; solver budget 12 ms; recovery
  throttle: 1 per 5 s.
- All F014–F017 component signatures stay unchanged (they were designed for this).

## Acceptance criteria

- [ ] Cold load → "Loading engine…" → empty tunnel with particles flowing within
      2 s; no console errors.
- [ ] Full journey: upload sphere → voxelize → flow develops → heatmap colors in →
      smoke wraps → stats live; then swap to a cube — all without page reload,
      no zombie rAFs (verify via Performance > rAF count).
- [ ] Force instability (60 m/s, min viscosity): within ~2 s app pauses,
      auto-recovers at 30 m/s, toast shown, badge returns to STABLE; throttled to
      one recovery per 5 s (spamming conditions doesn't loop-crash).
- [ ] Frame budget: default scene holds 55+ fps; steps-per-frame self-adjusts
      (expose current value in dev-only console via a debug flag — remove after
      verifying).
- [ ] All temporary components deleted; `rg -i "temporary|TODO"` over src/ shows
      no orphaned bridges (spec-file mentions don't count).
- [ ] Pause/resume/reset from F018 controls all behave through the context.
- [ ] `npm run lint` / `npm run build` pass; no wasm import outside SimEngine
      (`rg "loadWasm|wasm\\)" src --glob '!lib/sim/SimEngine.ts'` → no hits).

## Test plan

- Manual: the full journey above, twice; unmount/remount stress (React StrictMode
  double-mount in dev — engine must survive it: singleton guard).
- Manual: network-throttled load (CPU 6×) — overlay persists, no white screen.
- Unit (context-level, optional): `setConditions` viscosity flag → reset path with
  a mocked engine (pure logic in a `decideAction` helper if extraction is natural;
  don't over-abstract).

## Out of scope

- OffscreenCanvas/Worker threading (§8), quality presets (F021), persistence,
  multi-model scenes, undo/history.
