# F029 — Simple stats mode (hero numbers for non-experts)

## Metadata

| Field | Value |
|-------|-------|
| ID | F029 |
| Phase | 8 |
| Size | S |
| Skill fit | `UI` |
| Depends on | F017 (stats bar), F019 (readout); composes with F027 copy |
| Status | `[x]` done (2026-09-10; code + `node --test`/lint/build clean, SSR-prerender verified; 3 live-browser criteria outstanding — see notes) |

## Goal

The stats footer gets a **Simple / Advanced** toggle. Simple mode (the default
for first-time visitors) shows four things a layperson can read at a glance —
the model, the wind speed in km/h, the drag force with a relatable caption, and
the stability badge. Advanced mode is today's full instrument row, unchanged.
The choice persists in localStorage.

## Context

`StatsPanel.tsx` (F017) renders ten `StatCell`s fed by
`SimulationContext.readout`. Experts need them; non-experts see noise. Wind
speed is not in the readout — it comes from `SimulationContext.conditions`
(committed slider state), which is exactly what "wind speed" should show.
Persistence copies the F021 localStorage pattern (`quality.ts`) — same
try/catch hygiene, same corrupt-value fallback.

## Detailed spec

1. **Mode module** — new file `src/lib/sim/statsMode.ts` (pure, mirroring
   `quality.ts` structure so it stays `node --test` importable):

   ```ts
   export type StatsMode = "simple" | "advanced";
   export const DEFAULT_STATS_MODE: StatsMode = "simple";
   export const STATS_MODE_STORAGE_KEY = "wt.statsMode";
   export function isStatsMode(v: unknown): v is StatsMode;
   export function loadStoredStatsMode(): StatsMode;  // corrupt/missing → simple
   export function storeStatsMode(mode: StatsMode): void;  // never throws
   ```

   Copy the `readStorage` try/catch approach from `quality.ts` verbatim
   (private helper, not imported across files).
2. **StatsPanel changes** (`src/components/controls/StatsPanel.tsx`):
   - Local state: `const [mode, setMode] = useState<StatsMode>(DEFAULT_STATS_MODE)`
     then `useEffect(() => setMode(loadStoredStatsMode()), [])` (SSR-safe:
     server renders simple; storage read happens client-side only).
   - Toggle button pinned at the right end of the bar (before the badge):
     text `Advanced` when simple, `Simple` when advanced;
     `rounded border border-neutral-700 px-2 py-0.5 text-[10px] font-medium
     text-neutral-400 hover:bg-neutral-800`. Clicking flips mode and calls
     `storeStatsMode`.
   - **Advanced mode**: render exactly today's cells (no changes).
   - **Simple mode** renders four cells using the existing `StatCell`:
     | Label | Value | `title` |
     |---|---|---|
     | Model | same as today | same as today |
     | Wind | `formatKmh(conditions.uMps)` (from `useSimulationContext().conditions`; F027 helper — if F027 is unmerged, implement `formatKmh` in `conditions.ts` per its spec §2 as part of this feature) | `"Wind speed at the tunnel inlet"` |
     | Drag | `withUnit(formatDragN(readout.dragN), "N")`, placeholder when empty | `"Force the air pushes back with — one newton is about the weight of an apple"` |
     | *(badge)* | existing Stable/Unstable badge, unchanged | — |
     Empty state (`readout === null` or no model): placeholders exactly like
     the advanced empty state.
3. **No context changes**: `conditions` is already exposed by
   `SimulationContext` (it feeds `ControlPanel`); consume it directly in
   `StatsPanel` via `useSimulationContext()`.

## Files to create / modify

```
src/lib/sim/statsMode.ts                   (new)    — mode type + storage helpers
src/lib/sim/statsMode.test.mjs             (new)    — storage/validation tests
src/components/controls/StatsPanel.tsx     (modify) — toggle + simple layout
src/lib/sim/conditions.ts                  (modify, only if F027 unmerged) — formatKmh
```

## Dependencies added

- none

## Interface contract

- `statsMode.ts` exports above; nothing else changes signature.
- `StatsPanel()` keeps its zero-prop signature.

## Acceptance criteria

- [x] First visit (no storage key): footer shows Model / Wind / Drag / badge
      only, plus the `Advanced` toggle.
      (Verified 2026-09-10 in the SSR prerender `.next/server/app/index.html`:
      footer contains exactly the Model / Wind / Drag cells with `—`
      placeholders, the spec's `title` strings verbatim, the `Advanced`
      button, and the gray Stable badge; zero occurrences of the advanced
      cells.)
- [ ] Toggling to Advanced shows all ten F017 cells; reload keeps Advanced;
      `localStorage["wt.statsMode"] === "advanced"`.
      (2026-09-10: code path reviewed — toggle flips state, persists via
      `storeStatsMode`, hydration reads it on mount; live reload needs a
      browser — no browser in this environment.)
- [ ] Poisoning the key (`localStorage.setItem("wt.statsMode","turbo")`) +
      reload falls back to simple without a crash.
      (2026-09-10: fallback logic unit-tested — corrupt values load as
      simple; the reload half needs a browser.)
- [ ] In simple mode, dragging wind speed to 30 m/s updates Wind to `108 km/h`
      live (uses committed conditions, so within the 150 ms debounce).
      (2026-09-10: `formatKmh(30) === "108 km/h"` confirmed by execution and
      the cell reads committed `conditions.uMps` from context; live drag
      needs a browser.)
- [x] `node --test`, lint, build clean; advanced mode markup is byte-equivalent
      to pre-feature output (visual diff: no cell added/removed/reworded there
      beyond F027's tooltips if merged).
      (Verified 2026-09-10: 63/63 `node --test`, lint zero errors/warnings,
      `next build` succeeds; the ten advanced cells are verbatim copies —
      only the toggle button and a `gap-2` on the right container added.)

## Test plan

- Unit (`statsMode.test.mjs`): `isStatsMode` truth table; `loadStoredStatsMode`
  fallback on missing/corrupt; `storeStatsMode` roundtrip (skip when
  `localStorage` undefined — mirror `quality.test.mjs` technique).
- Manual: toggle both ways with and without a model loaded; check the empty
  placeholders.

## Out of scope

- Removing or rewording any advanced cell (F027 owns tooltip copy).
- Comparison features ("vs sphere"), history, sparklines, exporting stats.
- Moving the toggle into settings/quality; syncing mode across tabs.
