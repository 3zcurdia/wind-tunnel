# Wind Tunnel Simulator — Master Roadmap

A browser-based, desktop-first **wind tunnel toy**: upload a 3D model (OBJ or PLY), a
Rust/WebAssembly solver runs simplified-but-real CFD (Lattice Boltzmann) around it, and
Three.js renders the flow as particle streamlines, smoke tracers, and a pressure-colored
surface — with live tuning of wind speed, air pressure, and viscosity.

> This is an educational/visual simulator, **not** an industrial CFD tool.

**Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done

---

## Milestones

| Milestone | Meaning | Features |
|-----------|---------|----------|
| M0 — Foundation | App shell renders a 3D scene; Rust→WASM toolchain works end-to-end | F001–F003 |
| M1 — Model Ingestion | User can upload OBJ/PLY, see it in the scene, and it gets voxelized | F004–F006 |
| M2 — Solver Core | LBM solver produces a stable flow field; sampling/pressure/stats APIs exist | F007–F013 |
| M3 — Visualization (v1 usable) | Particles, heatmap, smoke, stats, and control panel all wired and live | F014–F020 |
| M4 — Hardened v1 | Presets, edge cases, sample models; project is demo-ready | F021–F023 |
| M5 — Post-v1 interaction | In-viewport model rotation (angle-of-attack control) | F024 |
| M6 — UX for non-experts | Two-step rails, scenario presets, plain-language copy, live first paint, simple stats | F025–F029 |

---

## Feature Board

Phases are ordered, but note the **parallel track**: Phase 2 (Rust solver) only depends on
F003 and can proceed while Phase 1 UI work happens.

### Phase 0 — Foundation

- [x] [F001 — Project skeleton & conventions](features/F001-project-skeleton.md) — `XS` `glue`
- [x] [F002 — Three.js scene shell](features/F002-scene-shell.md) — `S` `UI/3D`
- [x] [F003 — Rust→WASM pipeline wired into Next.js](features/F003-wasm-pipeline.md) — `M` `Rust/build`

### Phase 1 — Model Ingestion

- [x] [F004 — Upload UI (drag & drop, validation)](features/F004-upload-ui.md) — `S` `UI`
- [x] [F005 — Parse, display & normalize model](features/F005-model-load-display.md) — `S` `UI/3D`
- [x] [F006 — Rust: mesh → obstacle voxel grid](features/F006-voxelization.md) — `M` `Rust`

### Phase 2 — Solver Core (Rust)

- [x] [F007 — LBM D3Q19 core step](features/F007-lbm-core.md) — `M` `Rust`
- [x] [F008 — Boundary conditions (inlet/outlet/obstacles)](features/F008-boundary-conditions.md) — `M` `Rust`
- [x] [F009 — Physical ↔ lattice units mapping](features/F009-units-mapping.md) — `S` `logic`
- [x] [F010 — Step driver, stability & perf budget](features/F010-step-driver.md) — `S` `Rust`

### Phase 3 — Data Extraction (Rust)

- [x] [F011 — Velocity sampling & particle advection](features/F011-velocity-sampling.md) — `M` `Rust`
- [x] [F012 — Surface pressure → per-vertex scalars](features/F012-surface-pressure.md) — `M` `Rust`
- [x] [F013 — Drag coefficient & flow stats](features/F013-drag-stats.md) — `S` `Rust`

### Phase 4 — Visualization

- [x] [F014 — Particle streamlines](features/F014-particle-streamlines.md) — `M` `UI/3D` (2026-09-08; code + headless verification done, 3 visual/perf criteria need a browser — see spec notes)
- [x] [F015 — Surface pressure heatmap](features/F015-pressure-heatmap.md) — `S` `UI/3D` (2026-09-08; code + headless verification done, 5 visual/browser criteria need a browser — see spec notes)
- [x] [F016 — Smoke tracer lines](features/F016-smoke-tracers.md) — `M` `UI/3D` (2026-09-08; code + headless verification done, 5 visual/browser criteria need a browser — see spec notes)
- [x] [F017 — Live stats panel](features/F017-stats-panel.md) — `S` `UI` (2026-09-08; code + headless verification done, 5 visual/browser criteria need a browser — see spec notes)

### Phase 5 — Controls & Orchestration

- [x] [F018 — Control panel (wind speed / pressure / viscosity)](features/F018-control-panel.md) — `S` `UI` (2026-09-08; code + headless verification done, 7 visual/browser criteria need a browser — see spec notes)
- [x] [F019 — Simulation loop orchestration](features/F019-sim-loop.md) — `M` `glue` (2026-09-08; code + headless verification done, 5 visual/browser criteria need a browser — see spec notes)
- [x] [F020 — Viewport polish (camera presets, layer toggles)](features/F020-viewport-polish.md) — `S` `UI` (2026-09-08; code + headless verification done, 5 visual/browser criteria need a browser — see spec notes)

### Phase 6 — Hardening

- [x] [F021 — Quality presets (low/medium/high)](features/F021-quality-presets.md) — `S` `logic` (2026-09-08; code + headless verification done, 4 visual/browser criteria need a browser — see spec notes)
- [x] [F022 — Edge cases & error handling](features/F022-edge-cases.md) — `M` `logic` (2026-09-08; code + headless verification done, 5 manual/browser criteria need a browser — see spec notes)
- [x] [F023 — Built-in sample models + README](features/F023-samples-readme.md) — `S` `docs` (2026-09-08; code + headless verification done, 5 visual/browser criteria need a browser — see spec notes)

### Phase 7 — Post-v1 Interaction

- [x] [F024 — Viewport model rotation (angle of attack)](features/F024-viewport-model-rotation.md) — `M` `UI/3D` (rev 2 2026-09-09: camera-relative gestures + arrow-key/button stepping + snap-back fix; rev 1 2026-09-08. Visual/browser criteria need a browser — see spec notes)

### Phase 8 — UX for non-experts

Ordering: F025 first (it moves components the others touch). F026 depends on
F025; F027/F028/F029 are independent of each other and can run in parallel
after F025 lands (F027 and F026 both edit `ControlPanel.tsx` — sequence them
to avoid conflicts). All five are TypeScript/UI only — no wasm, no ABI changes.

- [ ] [F025 — Two-step rails (Load & set up / Tune & run)](features/F025-two-step-rails.md) — `S` `UI`
- [ ] [F026 — Flow scenario presets (one-click conditions)](features/F026-flow-presets.md) — `S` `UI/logic`
- [ ] [F027 — Plain-language pass (dual units, altitude, friendly warnings)](features/F027-plain-language-pass.md) — `S` `UI`
- [ ] [F028 — Live first paint (auto-load a sample at boot)](features/F028-auto-sample-boot.md) — `XS` `glue`
- [ ] [F029 — Simple stats mode (hero numbers for non-experts)](features/F029-simple-stats-mode.md) — `S` `UI`

---

## Dependency Graph

```
F001 ─► F002 ─► F005 ─► F004          (UI track)
  └────► F003 ─┬─► F006 ─► F008 ─► F007 ─► F010 ─► F011 ─┐
               │        └────────────────► F012 ─► F013  │  (solver track)
               └─► F009 ────────────────────────────────►│
                                                         ▼
        F004+F005+F006+F011+  F012/F013 ─► F014 / F015 / F016 / F017
                                                         │
                              F018 ─► F019 ─► F020 ──────┘
                                              │
                              F021 / F022 / F023
```

Practical reading:

- F001 must come first (folder layout everyone else builds into).
- F002, F003, F009 are independent of each other and can run in parallel after F001.
- F012/F013 need F006+F007+F009 but not F008 to be *testable* (they need a flow field).
- F014–F017 are independent of each other; all need F011 (and F012 for the heatmap).
- F019 is the integration feature — it depends on nearly everything before it.

---

## Risk Register

| Risk | Mitigation | Lives in |
|------|------------|----------|
| LBM diverges at high wind speed | τ clamping, u_lattice ≤ 0.15, auto-throttle + soft restart | F009, F010, F019 |
| WASM/JS call overhead kills framerate | Batched APIs only (no per-particle calls), zero-copy buffer views | ARCHITECTURE.md → ABI |
| Non-watertight meshes break flood-fill voxelization | Surface-only fallback mode + user notice | F006, F022 |
| Next.js 16 + wasm-pack integration quirks | Isolated in F003 with documented fallback loading path | F003 |
| 60fps budget blown by solver + rendering | Quality presets, adaptive steps-per-frame | F010, F019, F021 |
| Different AI models producing inconsistent code | Strict contracts in ARCHITECTURE.md, DoD in CONVENTIONS.md | both |

---

## How to work on this project

1. Read [ARCHITECTURE.md](ARCHITECTURE.md) once, fully.
2. Read [CONVENTIONS.md](CONVENTIONS.md) (short) — especially Definition of Done.
3. Pick **one** feature file from `features/`, read it completely.
4. Implement only what the spec says. Do not redesign adjacent systems.
5. Verify: `npm run lint`, `npm run build`, `cargo test` (in `wasm/`) all pass.
6. Mark the checkbox here (both in this file's board) and check off the acceptance
   criteria inside the feature file.

Never edit another feature's spec. If you find a conflict between specs, stop and
record it in `.agents/docs/DECISIONS.md` (create if missing) instead of silently
deviating.

---

## Appendix — Demo script (F023)

A 10-step click-path for presenting the app. A person who has never seen the
app should complete it in under 3 minutes.

1. Open the app and wait for "Loading engine…" to clear — the empty tunnel
   already flows with particles.
2. In the **Samples** panel, click **Sphere** — the model appears and flow
   starts developing around it within seconds.
3. Watch the surface heatmap: red stagnation zone on the upstream face, cooler
   wake behind — the classic wind-tunnel look.
4. Read the stats bar: note the drag coefficient (Cd) once it settles (the
   `—` placeholder clears after ~200 steps).
5. Click **Cube** — separation is visibly stronger and the settled Cd reads
   higher than the sphere's.
6. Click **Teardrop** (rounded nose faces left, into the wind) — flow stays
   attached and the settled Cd reads lower than the cube's.
7. Drag the **wind speed** slider up — particles accelerate and stats respond
   live; drag it back down to recover calm flow.
8. Toggle layers from the viewport toolbar: particles, smoke, heatmap, and
   the voxel debug view on/off.
9. Switch the quality preset to **Low** and back — the tunnel rebuilds and
   flow resumes without a reload.
10. Drop any `.obj` / `.ply` file (≤ 50 MB) onto the Model panel — the gallery
    deselects, your model swaps in, and the tunnel keeps running.
