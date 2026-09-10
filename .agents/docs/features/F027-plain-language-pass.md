# F027 — Plain-language pass (dual units, altitude, friendly warnings)

## Metadata

| Field | Value |
|-------|-------|
| ID | F027 |
| Phase | 8 |
| Size | S |
| Skill fit | `UI` |
| Depends on | F018, F022 (warning surfaces exist); composes with F025/F026 but does not require them |
| Status | `[x]` done (2026-09-10; code + `node --test`/lint/build verified, 2 live-browser criteria noted below) |

## Goal

Every user-facing string a non-expert meets gets a plain-language companion:
wind speed shows km/h next to m/s, air pressure shows an approximate altitude,
the viscosity slider explains itself in one line, and the two scary warnings
(stability assist, solver blow-up) are reworded so a curious teenager
understands what happened. **Copy and formatting only — zero behavior changes.**

## Context

Slider labels/units come from `src/components/ui/Slider.tsx` via props in
`ControlPanel.tsx`; the stability-assist paragraph is inline in
`ControlPanel.tsx`; the blow-up banner text is `UNSTABLE_LOCK_MESSAGE` in
`src/lib/sim/SimEngine.ts`; layer names in `LayersSection`. All numbers shown
remain SI-first — companions are additions, not replacements (the app still
teaches real units).

If F026 has landed, the three Flow sliders live inside its "Advanced controls"
disclosure — the sublabel edits below apply to them wherever they render (open
the disclosure to verify manually). This feature does not move any section.

## Detailed spec

1. **Slider sublabel support** — `src/components/ui/Slider.tsx` gains an
   optional prop `sublabel?: string`. When present, render under the slider row:
   `<p className="mt-0.5 text-[10px] text-neutral-500">{sublabel}</p>`.
   No other Slider changes.
2. **Helpers** — append to `src/lib/sim/conditions.ts` (pure, tested):

   ```ts
   /** 15 → "54 km/h" (round to integer). */
   export function formatKmh(uMps: number): string

   /** ISA altitude from station pressure: h = 44330·(1 − (kPa/101.325)^0.1903),
    *  clamped to ≥ 0, rounded to the nearest 100 m.
    *  101.3 → "sea level"; otherwise "≈ 1,900 m altitude" (en-US grouping). */
   export function formatAltitude(pressureKpa: number): string
   ```

   `formatAltitude` returns `"sea level"` whenever the computed altitude rounds
   to 0 m.
3. **Wire sublabels in `ControlPanel.tsx`** (values recompute on every render
   from `conditions` — they are cheap):
   | Slider | `sublabel` value |
   |---|---|
   | Wind speed | `` `${formatKmh(conditions.uMps)} — highway speed is ≈ 100 km/h` `` |
   | Air pressure | `` `${formatAltitude(conditions.pressureKpa)} — thinner air pushes less` `` |
   | Dynamic viscosity | `"How “sticky” the air is — honey would be far off this scale"` |
4. **Reword the stability-assist warning** (`ControlPanel.tsx`, same amber box,
   replace the paragraph text with exactly):
   > Heads up: these settings are past what this tunnel can compute exactly, so
   > it's running a smoothed approximation. The flow pattern is still
   > representative, but the Re number reads higher than what is simulated.
5. **Reword the blow-up message** — in `src/lib/sim/SimEngine.ts` change the
   `UNSTABLE_LOCK_MESSAGE` string constant (its export name and every usage
   stay) to exactly:
   `"The simulation blew up — extreme settings can do that. Press Reset to calm the air and try gentler values."`
6. **Rename surface strings**:
   - `LayersSection` toggle label `"Domain box"` → `"Tunnel bounds"`.
   - `ControlPanel` section title `"Transport"` → `"Playback"`.
   - Stats bar (`StatsPanel.tsx`) `title` tooltip for **Cd (confined)**
     becomes: `"Drag score for comparing shapes in this tunnel — lower is
     sleeker. Not comparable to textbook Cd values (walls and coarse grid
     inflate it)."` The label itself stays `Cd (confined)`.
   - Stats bar **Unstable** badge `title` becomes: `"The math diverged —
     the app resets the flow automatically."`
7. **Do not touch** the Derived section labels/values, any ARIA labels, or the
   README.

## Files to create / modify

```
src/components/ui/Slider.tsx               (modify) — optional sublabel prop
src/lib/sim/conditions.ts                  (modify) — formatKmh, formatAltitude
src/lib/sim/conditions.test.mjs            (modify) — helper tests
src/components/controls/ControlPanel.tsx   (modify) — sublabels, warning copy, Playback
src/lib/sim/SimEngine.ts                   (modify) — UNSTABLE_LOCK_MESSAGE text only
src/components/controls/StatsPanel.tsx     (modify) — two tooltip strings
```

## Dependencies added

- none

## Interface contract

- `Slider` prop addition is backward-compatible (optional).
- `formatKmh` / `formatAltitude` pure exports.
- `UNSTABLE_LOCK_MESSAGE`: same export, new value — no signature changes
  anywhere. The WASM ABI and `SimulationContext` are untouched.

## Acceptance criteria

- [x] At defaults the wind-speed sublabel reads `54 km/h — highway speed is
      ≈ 100 km/h` and the pressure sublabel starts with `sea level`.
- [x] Pressure at 80.0 kPa → sublabel starts with `≈ 1,900 m altitude`;
      at 50.0 kPa → `≈ 5,600 m altitude`.
- [ ] Driving 60 m/s + min viscosity shows the new amber copy verbatim.
      (2026-09-10: copy verified verbatim in source — JSX whitespace collapses
      to the exact spec sentence; live trigger needs a browser + wasm run.)
- [ ] The layers list shows "Tunnel bounds"; the run/pause section is titled
      "Playback"; both still function. (2026-09-10: labels verified in source
      + `grep "Domain box"` empty; click-function needs a browser.)
- [x] `node --test`, lint, build all clean; `grep -r "Domain box" src/` empty.

## Test plan

- Unit (`conditions.test.mjs`):
  - `formatKmh(15) === "54 km/h"`, `formatKmh(60) === "216 km/h"`.
  - `formatAltitude(101.3) === "sea level"`,
    `formatAltitude(80) === "≈ 1,900 m altitude"`,
    `formatAltitude(50) === "≈ 5,600 m altitude"`,
    `formatAltitude(110)` → `"sea level"` (negative altitude clamps to 0).
- Manual: drag each slider end to end and confirm sublabels track live.

## Out of scope

- Unit *switching* (mph, imperial) or replacing SI readouts.
- Rewording Derived-section math tooltips, README, or error-boundary text.
- i18n/localization infrastructure.
- Any logic change to when warnings appear.
