# F026 — Flow scenario presets (one-click conditions)

## Metadata

| Field | Value |
|-------|-------|
| ID | F026 |
| Phase | 8 |
| Size | S |
| Skill fit | `UI` / `logic` |
| Depends on | F018 (conditions module), F019 (setConditions), F025 (rail layout) |
| Status | `[ ]` todo |

## Goal

Non-experts get a **Scenarios** row at the top of the "Tune & run" rail: one click
sets wind speed / pressure / viscosity to a recognizable real-world situation with
a one-line "what to look for" caption. The original expert controls — the Flow
sliders, Derived readouts, Particles, and Smoke sections — **move under a
collapsed "Advanced" disclosure**, so the default view is: Scenarios, Layers,
Playback. Nothing is removed; the sliders remain fully functional one click away.
All presets live **inside the solver's honest envelope** (subsonic, 1–60 m/s,
50–110 kPa) — there is deliberately no "jet" or "supersonic" preset; a short
static note explains why.

## Context

The solver is incompressible LBM with `u_lattice ≤ 0.15` (ARCHITECTURE.md §3/§6):
it cannot represent transonic or supersonic flow, and slider ranges
(`src/lib/sim/conditions.ts`) cap at 60 m/s / 50 kPa. Presets are therefore pure
`FlowConditions` values — they reuse the existing `setConditions` path (debounce,
viscosity soft-restart) with **zero engine changes**. A preset is just data + a
button.

## Detailed spec

1. **Preset data** — append to `src/lib/sim/conditions.ts` (pure module, keep it
   Node-importable, no React):

   ```ts
   export interface FlowPreset {
     readonly id: "breeze" | "city" | "race" | "mountain";
     readonly label: string;      // button text
     readonly caption: string;    // one line under the buttons when active
     readonly conditions: FlowConditions;
   }

   export const FLOW_PRESETS: readonly FlowPreset[] = [
     {
       id: "breeze",
       label: "Breeze",
       caption: "A stiff sea breeze — gentle, attached flow.",
       conditions: { uMps: 8, pressureKpa: 101.5, viscosityPas: 1.81e-5 },
     },
     {
       id: "city",
       label: "City drive",
       caption: "≈50 km/h at sea level — the everyday car case.",
       conditions: { uMps: 14, pressureKpa: 101.5, viscosityPas: 1.81e-5 },
     },
     {
       id: "race",
       label: "Race car",
       caption: "≈200 km/h — watch the wake grow and drag climb.",
       conditions: { uMps: 55, pressureKpa: 101.5, viscosityPas: 1.81e-5 },
     },
     {
       id: "mountain",
       label: "High altitude",
       caption: "≈4,000 m up — thinner air, same speed, less drag.",
       conditions: { uMps: 25, pressureKpa: 61.5, viscosityPas: 1.81e-5 },
     },
   ] as const;
   ```

   Note: every numeric value above sits on its slider grid (speed step 0.5,
   pressure step 0.5, viscosity equals the default) — do not change them.
2. **Active-preset matcher** — same file, pure and tested:

   ```ts
   export function matchPreset(c: FlowConditions): FlowPreset["id"] | null
   ```

   Returns the id of the preset whose three values all match `c` within
   `1e-9` absolute tolerance, else `null` (moving any slider after a preset
   click deselects it).
3. **UI** — new file `src/components/controls/PresetRow.tsx`, exporting
   `PresetRow({ conditions, setConditions }: { conditions: FlowConditions;
   setConditions: (next: FlowConditions) => void })`:
   - A 2×2 button grid (`grid grid-cols-2 gap-1`). Each button: preset label,
     `text-xs`, styling copied from the quality segmented control — active
     (matched) preset `bg-blue-600 text-white`, others
     `bg-neutral-900 text-neutral-300 hover:bg-neutral-800`, all
     `rounded-md border border-neutral-800 px-2 py-1.5`.
   - Click → `setConditions({ ...preset.conditions })`. Nothing else — the
     existing context handles debounce and the viscosity soft-restart.
   - Under the grid, when a preset is matched, show its `caption` in
     `text-[11px] text-neutral-400`; when none matched show
     `"Custom conditions — pick a scenario or keep tuning."` in the same style.
   - Below that, always, the static envelope note in
     `text-[11px] text-neutral-600`:
     `"Why no jet or supersonic? This tunnel simulates subsonic air only — shock
     waves and compressibility are beyond its physics, so we won't pretend."`
4. **Placement** — in `src/components/controls/ControlPanel.tsx`, render
   `<section><SectionTitle>Scenarios</SectionTitle><PresetRow … /></section>`
   as the **first** section inside the existing disabled fieldset. Pass through
   the `conditions` / `setConditions` props the panel already receives.
5. **Advanced disclosure** — new file
   `src/components/controls/AdvancedSection.tsx`:

   ```tsx
   export function AdvancedSection({
     children,
     defaultOpen = false,
   }: {
     readonly children: React.ReactNode;
     readonly defaultOpen?: boolean;
   })
   ```

   - Plain `useState(defaultOpen)` toggle — no persistence, no context.
   - Header button (full width, `flex items-center justify-between rounded-md
     border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs font-medium
     text-neutral-300 hover:bg-neutral-800`, with `aria-expanded`):
     left text `"Advanced controls"`, right chevron `"▸"` closed / `"▾"` open.
   - Body: `hidden` when closed, `mt-3 space-y-5` when open — **always
     mounted** (CSS hide, not conditional render) so slider state, derived
     readouts, and the F027 sublabels keep updating while collapsed.
   - Under the header when closed, a summary line in
     `text-[11px] text-neutral-500`:
     `` `${conditions.uMps.toFixed(1)} m/s · ${conditions.pressureKpa.toFixed(1)} kPa · ${viscosityPasToCoef(conditions.viscosityPas).toFixed(2)} ×10⁻⁵ Pa·s` ``
     — pass `conditions` in as a prop for this
     (`summary?: string` prop is also acceptable; pick one and keep it typed).
6. **Restructure `ControlPanel` section order** (all inside the existing
   fieldset): **Scenarios**, then `<AdvancedSection>` containing — in this
   order — **Flow**, **Derived** (with its stability-assist warning), the
   existing **Particles** and **Smoke** sections, then after the disclosure
   **Layers**. The Playback (Transport) section stays where it is, outside the
   fieldset. The amber "stability assist" box renders inside Advanced (it
   belongs to Derived); additionally, when `conditionsUnstable` is true and the
   disclosure is **closed**, show a compact amber dot + text
   `"stability assist on"` appended to the summary line so the warning is never
   fully hidden.

## Files to create / modify

```
src/lib/sim/conditions.ts                  (modify) — FLOW_PRESETS + matchPreset
src/lib/sim/conditions.test.mjs            (modify) — matcher + on-grid tests
src/components/controls/PresetRow.tsx        (new)    — preset buttons + captions
src/components/controls/AdvancedSection.tsx  (new)    — collapsed disclosure wrapper
src/components/controls/ControlPanel.tsx     (modify) — Scenarios on top; Flow/Derived/Particles/Smoke under Advanced
```

## Dependencies added

- none

## Interface contract

- Consumes only the existing `ControlPanelProps.conditions` /
  `setConditions` — no new context fields, no wasm calls, no ABI changes.
- `matchPreset(conditions)` pure; `FLOW_PRESETS` readonly data.

## Acceptance criteria

- [ ] Clicking **Race car** moves the wind-speed slider to 55.0 m/s within one
      render, the button turns blue, its caption appears, and flow visibly
      speeds up (no reset — speed/pressure path).
- [ ] Clicking **High altitude** after it: pressure slider reads 61.5 kPa and
      derived ρ reads ≈ 0.731 kg/m³ (±0.001).
- [ ] Dragging any slider afterwards deselects all preset buttons and shows the
      "Custom conditions" line.
- [ ] Reset all (transport) returns to defaults → no preset matched (defaults
      are intentionally not a preset).
- [ ] The subsonic note is always visible in the Scenarios section.
- [ ] Default view of the panel shows only: Scenarios, the collapsed
      "Advanced controls" header with its live summary line, Layers, and
      Playback — no sliders visible.
- [ ] Clicking a preset while Advanced is **closed** updates the summary line
      (e.g. Race car → `55.0 m/s · 101.5 kPa · 1.81 ×10⁻⁵ Pa·s`); opening
      Advanced shows the sliders already at those positions.
- [ ] Slider edits inside Advanced behave exactly as before this feature
      (debounce, viscosity soft-restart, disabled-fieldset gating) and
      deselect the active preset.
- [ ] At 60 m/s + min viscosity with Advanced closed, the summary line shows
      the amber "stability assist on" marker.
- [ ] Collapsing/expanding Advanced never resets slider values or re-runs the
      simulation (state is CSS-hidden, not unmounted).
- [ ] `node --test` passes with new cases; lint + build clean.

## Test plan

- Unit (`conditions.test.mjs`):
  - `matchPreset(FLOW_PRESETS[i].conditions) === FLOW_PRESETS[i].id` for all four.
  - `matchPreset(DEFAULT_CONDITIONS) === null`.
  - `matchPreset({ ...race, uMps: 54.5 }) === null`.
  - Every preset value is on its slider grid: `(uMps - min) % step ≈ 0` etc.
- Manual: click each preset with the Teardrop loaded; verify captions and the
  drag stat direction (race ≫ city; mountain < city at matched speed—note
  mountain runs faster, compare q_ref instead).

## Out of scope

- Jet/supersonic presets of any kind (see the envelope note — this is a
  deliberate product decision, do not "add one more").
- Presets changing model, camera, quality, or layers.
- Persisting the last preset or the Advanced open/closed state; animating
  slider transitions or the disclosure (no height animation).
- Removing, renaming, or re-ranging any slider — Advanced contains the F018
  controls unchanged.
- Auto-opening Advanced when conditions become "custom".
- Temperature or characteristic-length controls.
