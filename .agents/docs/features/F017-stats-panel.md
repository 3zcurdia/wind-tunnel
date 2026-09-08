# F017 — Live stats panel

## Metadata

| Field | Value |
|-------|-------|
| ID | F017 |
| Phase | 4 |
| Size | S |
| Skill fit | `UI` |
| Depends on | F010 (`timing`, `is_stable`), F013 (`StatsRecord`), F009 (LatticeParams) |
| Status | `[x]` done (2026-09-08; code + headless verification done, 5 browser criteria need a browser — see notes + DECISIONS.md §F017) |

## Goal

The bottom stats bar becomes a live instrument readout: simulation FPS and steps/s,
drag coefficient, drag force, pressure extremes, Reynolds number, grid size,
particle count, and a stability badge — refreshed at 4 Hz without re-rendering the
scene or the whole app.

## Context

`StatsRecord` (F013) carries sim data; `timing()` (F010) carries perf; the model
name/counts come from `ModelContext`. The panel polls — it does not subscribe to
frame events. Until F019's `SimulationContext` exists, the panel polls the temporary
`voxelBridge` (same pattern as F014–F016; F019 swaps the data source, component
unchanged).

## Detailed spec

1. **`StatsPanel.tsx`** (bottom bar, replaces F001 placeholder):
   - Poll loop: `setInterval` 250 ms → read `bridge.getReadout()` (temporary;
     F019 provides the same shape from `SimulationContext`) → `setState`.
   - `Readout` shape (define in `src/lib/sim/types.ts` now — F019 reuses it):
     ```ts
     interface SimReadout {
       fps: number; stepsPerSecond: number;
       cd: number | null;            // null → render "—"
       dragN: number | null;
       pMinPa: number; pMaxPa: number; qRefPa: number;
       re: number; gridDims: [number, number, number];
       activeParticles: number; stable: boolean;
       modelName: string | null; modelTriangles: number | null;
     }
     ```
   - Layout: monospace (`font-mono`), small labels above values, horizontal flex
     with dividers; numbers formatted: `cd` 3 decimals, forces 2, pressures in kPa
     2 decimals, `re` compact scientific (e.g. `2.5e5`), fps integer.
   - Stability badge: `STABLE` (green) / `UNSTABLE` (red, pulsing) at the right
     end; tooltips (`title` attributes) explaining each metric in one line.
   - `cd === -1` sentinel (F013) → render "—".
2. **FPS source**: JS-side frame counter in the bridge (rAF deltas EMA) —
   simulation steps/s from wasm `steps_done()` delta per interval; both computed in
   `bridge.getReadout()`; FPS ≠ steps/s (multiple steps per frame).
3. **Perf rule**: polling updates ≤ 4 Hz; no layout thrash (fixed bar height, no
   reflow from changing numbers — use `tabular-nums`).
4. **Empty states**: no model/no run → all "—" except grid dims (from `DOMAIN`)
   and `STABLE` gray badge; no crash before wasm loads (panel renders placeholders
   until first readout).

## Files to create / modify

```
src/lib/sim/types.ts                       (modify) — SimReadout
src/components/controls/StatsPanel.tsx     (new)
src/lib/sim/voxelBridge.ts                 (modify) — getReadout() (TEMPORARY data source)
src/app/page.tsx                           (modify) — stats bar placeholder → StatsPanel
```

## Dependencies added

- none

## Interface contract

- `StatsPanel` consumes `getReadout(): SimReadout | null` (null → placeholders).
- `SimReadout` is the durable contract F019 must honor (bridge is deleted then).
- Component must render correctly (SSR-safe placeholders) before wasm exists.

## Acceptance criteria

- [ ] With cube + defaults running: fps ≈ rAF rate, steps/s = fps × actual
      steps-per-frame (±10 %), cd shows a plausible number after 200+ steps
      (matches F013's cube bracket), UNSTABLE badge appears if conditions force
      instability (set μ to min × U to max via future controls — for now test by
      temporarily calling `set_conditions` with extremes in the probe).
      **PARTIALLY VERIFIED HEADLESS, box unticked (see DECISIONS.md §F017):**
      `steps_done()` advances exactly (60/200/500/1000 on the nose), so the
      steps/s-from-delta mapping is sound; the `cd === −1` → "—" path is live
      at ≤ 60 steps; instability arrives on its own by ~200 steps at
      defaults + any cube (20³ and 8³ both flip `stable=false`, `cd` →
      finite garbage ~1e35–1e38), so the UNSTABLE data path is exercised but
      the "plausible cd after 200+ steps" half is unachievable pre-F019
      recovery. fps ≈ rAF and the ±10 % steps/s ratio need a browser.
- [ ] No model loaded: all placeholders, no errors in console.
      **PLACEHOLDER RENDERING VERIFIED, browser check outstanding:** the
      production prerender (`npm run build`, no wasm / no model on the
      server) emits the placeholder bar without crashing; console-error
      freedom needs a browser pass.
- [ ] Panel updates visibly at 4 Hz but app FPS unchanged with panel hidden vs
      shown (no measurable cost).
      **NOT VERIFIED — needs a browser** (poll loop is `setInterval` 250 ms
      over a small footer subtree; the rAF fps ticker is one timestamp
      subtraction per frame by inspection).
- [ ] kPa conversions correct: p_max at defaults ≈ q_ref ≈ 0.14 kPa
      (0.5·1.2041·15² = 135.5 Pa) ± 30 %.
      **PARTIALLY VERIFIED HEADLESS (see DECISIONS.md §F017.3):** `q_ref` is
      exact at 135.46 Pa; 20³ cube at 60 stable steps gives p_max 173.8 Pa
      (ratio 1.28, inside the band) — but there is no stable *developed*
      state at defaults, so the criterion as printed (a running value) is
      left unticked.
- [ ] `tabular-nums` prevents width jitter while numbers change.
      **CLASS PRESENT, visual check outstanding:** values carry
      `tabular-nums`, the bar height is fixed (`h-16` footer), cells
      `truncate` — jitter prevention itself needs a browser.
- [x] `npm run lint` / `npm run build` pass.
      (Verified 2026-09-08: lint zero errors/warnings, build succeeds;
      `node --test src/lib/sim/types.test.mjs` 12/12 pass.)

## Test plan

- Manual: all criteria; verify tooltip text renders on hover.
- Unit (optional): a `formatReadout(readout)` pure helper for the number formats
  (`2.5e5` scientific for re, kPa conversions) with fixed cases.

## Out of scope

- Charts/history graphs, CSV export, screenshot of stats, mass-balance display
  (fields exist in StatsRecord but v1 panel omits them — fine), settings for panel
  density.
