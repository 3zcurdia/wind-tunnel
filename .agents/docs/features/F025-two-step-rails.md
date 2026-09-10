# F025 — Two-step rails (Load & set up / Tune & run)

## Metadata

| Field | Value |
|-------|-------|
| ID | F025 |
| Phase | 8 |
| Size | S |
| Skill fit | `UI` |
| Depends on | F018, F019, F020, F021, F023 (all shipped) |
| Status | `[ ]` todo |

## Goal

The single left controls rail becomes **two rails flanking the viewport**, mirroring
the two steps a first-time user actually takes: **left rail "1 · Load & set up"**
(sample gallery, upload, quality) and **right rail "2 · Tune & run"** (flow
controls, layers, playback). A visible step indicator tells non-experts which side
to touch first; step 2 is visually dimmed until a model is loaded (the existing
`controlsDisabled` fieldset already disables it functionally).

## Context

Today `ControlsRail` in `src/app/page.tsx` stacks `SampleGallery`, `UploadPanel`,
and `ControlPanel` in one `w-80` column, and `QualitySection` lives *inside*
`ControlPanel.tsx`. Non-experts face ~10 sections in one scroll with no ordering
cue. This feature is **layout + component extraction only** — no behavior,
context, wasm, or state changes. `SimulationContext` / `ModelContext` APIs are
untouched. Quality moves to the setup rail because grid resolution is tunnel
setup, not a live tuning knob (it re-simulates from scratch).

## Detailed spec

1. **Extract `QualitySection`** from `src/components/controls/ControlPanel.tsx`
   into a new file `src/components/controls/QualitySection.tsx`:
   - Move the `QualitySection` function **verbatim** (including its
     `useState` hooks, `handleApply`, `handleCancel`, JSX) plus the imports it
     needs (`useState`, `useSimulationContext`, `QUALITY_LEVELS`,
     `QUALITY_PRESETS`, `QualityLevel`). Export it as a named export.
   - Also move the private `SectionTitle` helper? **No** — `SectionTitle` stays
     in `ControlPanel.tsx`; `QualitySection.tsx` gets its own private copy of
     the same 5-line `SectionTitle` component (duplication is acceptable; do
     not create a shared file for it).
   - `ControlPanel.tsx` deletes the moved function and its now-unused imports,
     and **removes** the `<div className="mt-5"><QualitySection /></div>` block
     from its JSX. Everything else in `ControlPanel.tsx` stays byte-identical.
2. **Step header atom** — new file `src/components/controls/StepHeader.tsx`:

   ```tsx
   export function StepHeader({
     step,
     label,
     active,
   }: {
     readonly step: 1 | 2;
     readonly label: string;
     readonly active: boolean;
   })
   ```

   Renders a row: a circular number chip (`h-5 w-5 rounded-full text-[11px]
   font-semibold flex items-center justify-center`) followed by the label
   (`text-xs font-semibold uppercase tracking-wider`). Colors:
   `active` → chip `bg-blue-600 text-white`, label `text-neutral-200`;
   inactive → chip `bg-neutral-800 text-neutral-500`, label `text-neutral-500`.
3. **Rework `ControlsRail` in `src/app/page.tsx` into two components**:
   - `SetupRail` (left, `w-72 shrink-0 space-y-4 overflow-y-auto pr-1`):
     `<StepHeader step={1} label="Load & set up" active={!hasModel} />`, then
     `SampleGallery`, `UploadPanel`, and `QualitySection` wrapped in a
     `Panel` titled `"Quality"`? **No** — `QualitySection` already renders its
     own `<section>` with a "Quality" title; wrap it in the shared `Panel`
     component with `title="Tunnel"` so it visually matches the other cards.
   - `TuneRail` (right, `w-80 shrink-0 space-y-4 overflow-y-auto pl-1`):
     `<StepHeader step={2} label="Tune & run" active={hasModel} />`, then the
     existing `ControlPanel` with the exact same props as today. When
     `!hasModel`, wrap the `ControlPanel` in a `div` with `opacity-60` and add
     directly under the step header the hint line:
     `<p className="text-[11px] text-neutral-500">Pick a sample or upload a
     model to start the tunnel.</p>` (hidden once `hasModel`).
   - `hasModel` uses the exact existing expression from `ControlsRail`:
     `(file !== null || sample !== null) && meta !== undefined`.
   - `main` layout becomes `SetupRail` · `ViewportPane` · `TuneRail`
     (viewport stays `flex-1` in the middle). Delete the old `ControlsRail`.
4. **No other changes.** Stats footer, toasts, overlays, header all stay.

## Files to create / modify

```
src/components/controls/QualitySection.tsx  (new)    — moved verbatim from ControlPanel
src/components/controls/StepHeader.tsx      (new)    — step number chip + label
src/components/controls/ControlPanel.tsx    (modify) — delete QualitySection + unused imports
src/app/page.tsx                            (modify) — ControlsRail → SetupRail + TuneRail
```

## Dependencies added

- none

## Interface contract

- `StepHeader({ step, label, active })` — presentational only.
- `QualitySection()` — same behavior/contract as today (consumes
  `useSimulationContext().{ready, quality, setQuality}`); only its file moved.
- `ControlPanelProps` unchanged.

## Acceptance criteria

- [ ] Viewport is flanked: samples/upload/quality on the left, flow controls on
      the right; nothing lost (every section from the old rail appears exactly once).
- [ ] With no model loaded: left chip is blue ("1" active), right chip is gray,
      right rail shows the hint line and renders at `opacity-60`; transport
      buttons still work (empty-tunnel demo flow preserved).
- [ ] After clicking a sample: right chip turns blue, left chip gray, hint line
      gone, opacity restored, all sliders enabled.
- [ ] Quality Apply/Cancel flow works identically from its new home (stage a
      tier → amber confirm → Apply re-inits engine).
- [ ] `npm run lint` and `npm run build` clean; no changes under `src/lib/`.

## Test plan

- Manual: run the F023 demo script steps 1–2 and 9 — they must still pass with
  the new layout (quality switch now on the left rail).
- Manual: shrink the window height — both rails scroll independently.

## Out of scope

- Any change to `SimulationContext`, `ModelContext`, `useSimulation`, or wasm.
- Responsive/mobile layout, collapsible rails, drag-to-resize.
- Reordering sections *within* `ControlPanel` (F026/F027 own follow-up edits).
- Moving the stats footer or viewport toolbar.
