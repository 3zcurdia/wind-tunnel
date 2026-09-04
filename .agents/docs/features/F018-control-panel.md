# F018 — Control panel (wind speed / pressure / viscosity)

## Metadata

| Field | Value |
|-------|-------|
| ID | F018 |
| Phase | 5 |
| Size | S |
| Skill fit | `UI` |
| Depends on | F009 (`set_conditions`), F010 (`reset_flow`), F019 (SimulationContext — implement after F019 or against its API) |
| Status | `[ ]` todo |

## Goal

The Controls rail becomes the wind-tunnel instrument: wind speed, air pressure, and
dynamic viscosity sliders with live unit readouts and derived values (ρ, ν, Re,
q_ref), plus play/pause/reset transport buttons. Changes take effect immediately:
speed/pressure via `set_conditions`; viscosity additionally triggers the documented
soft restart.

## Context

`ARCHITECTURE.md` §4 fixes ranges/defaults. §6 fixes the parameter-change semantics:
**viscosity change → `reset_flow()`** (τ shift destabilizes a converged field);
speed/pressure change → `set_conditions` only (no reset). This feature assumes
F019's `SimulationContext` API exists (implement F018 after F019, or concurrently
against the contract below).

## Detailed spec

1. **`ControlPanel.tsx`** (Controls rail, replaces temporary controls from
   F003/F006/F014/F016 where they overlap — coordinate deletions listed below):
   - **Section "Flow"**:
     - Slider "Wind speed" 1–60 m/s, step 0.5, default 15 — readout
       `15.0 m/s`.
     - Slider "Air pressure" 50–110 kPa, step 0.5, default 101.3 — readout
       `101.3 kPa`.
     - Slider "Dynamic viscosity" 0.5–3.0, step 0.05, default 1.81 — readout
       `1.81 ×10⁻⁵ Pa·s` (slider unit = µPa·s).
   - **Section "Derived"** (read-only, updates with sliders): ρ (kg/m³, 3 decimals),
     ν (m²/s scientific 3 digits), q_ref (Pa), Re (scientific) — computed by a pure
     helper `derivedValues(u, p, mu, charLen)` in `src/lib/sim/conditions.ts`
     mirroring F009's formulas for display (Rust remains authoritative; display math
     duplicated intentionally for responsiveness — document).
   - **Section "Transport"**: buttons ▶ Run / ⏸ Pause (toggle), ↺ Reset flow,
     ↺↺ Reset all (flow + conditions to defaults). Space bar toggles
     run/pause (global keydown, ignored when focus is in an input).
   - All controls disabled while wasm loads or no mesh present, except transport
     (reset works pre-mesh, enabling an "empty tunnel" demo flow).
2. **Actions wiring** (through `SimulationContext` from F019):
   - `setConditions({ uMps, pressureKpa, viscosityPas })` — context debounce 150 ms;
     viscosity-change path adds `resetFlow()` automatically.
   - `charLen` (model longest side in meters) is passed through from
     `ModelContext` meta (F005 stores it as `charLengthM` — add to its meta in this
     feature: `normalizeToDomain` already returns scale; charLen = scale factor ×
     domain_length_m; compute in the pipeline, not here).
   - Play/pause/reset → context transport API.
3. **Move-in of temporary controls**: particle count slider (F014) and smoke
   controls (F016) relocate into this panel under sections "Particles" and "Smoke";
   heatmap toggle (F015) under "Layers" (full layer toggles remain F020's job).
   Delete `WasmProbe`, `VoxelDebugToggle` remnants per F019's cleanup list.
4. **Slider atom**: implement/reuse `src/components/ui/Slider.tsx`
   (label, min/max/step/value, onChange, unit readout right-aligned) — used by all
   sliders for consistent styling.

## Files to create / modify

```
src/components/ui/Slider.tsx              (new)    — shared slider atom
src/lib/sim/conditions.ts                 (new)    — derivedValues helper
src/components/controls/ControlPanel.tsx  (new)    — Flow/Derived/Transport sections
src/components/controls/UploadPanel.tsx   (modify) — stays first; styling only
src/app/page.tsx                          (modify) — replace temporary rail content
(deletions: temporary controls from F003/F006/F014/F015/F016 that moved here)
```

## Dependencies added

- none

## Interface contract

- Consumes (from F019's `SimulationContext`):
  `setConditions(params: { uMps, pressureKpa, viscosityPas }): void` (debounced),
  `transport: { running: boolean; toggleRun(): void; resetFlow(): void;
  resetAll(): void }`, `readout: SimReadout | null`.
- `derivedValues(uMps, pressureKpa, muPas, charLenM)` returns
  `{ rhoKgM3, nuM2S, qRefPa, re }` — pure, tested.
- Slider atom props: `{ label, min, max, step, value, onChange, unit?, format? }`.

## Acceptance criteria

- [ ] Moving wind speed 15→40 visibly accelerates the flow within ~1 s (particles),
      stats q_ref follows ≈ 0.5·ρ·40² ≈ 963 Pa ± 10 %, no reset needed.
- [ ] Changing viscosity: flow field resets (visible re-development) and τ changes
      (verifiable via stats/derived readout); changing speed does **not** reset.
- [ ] Extreme settings (60 m/s + min viscosity) either stay stable or the F019
      recovery kicks in — panel never freezes silently.
- [ ] Space toggles run/pause from anywhere except focused inputs; buttons reflect
      running state (icon + label swap).
- [ ] Reset flow re-develops the pattern from uniform; Reset all returns sliders to
      defaults too.
- [ ] All sliders disabled (grayed) until a model is loaded; transport enabled.
- [ ] Derived readouts match hand-computed values at defaults
      (ρ=1.204, ν=1.506e-5, q_ref=135.5 Pa, Re=2.49e5 with charLen 0.25).

## Test plan

- Unit (`conditions.ts`): the four hand-computed defaults above + clamp-edge cases.
- Manual: each slider's live effect; debounce feel (no wasm call spam — add a
  dev-only counter, verify ≤ 7 calls/s during a fast drag, remove counter).

## Out of scope

- Grid resolution/particle-count as "solver tuning" (F021 presets own grid;
  particles slider already exists), temperature control, wind direction,
  profiles, persistence (F021 localStorage only).
