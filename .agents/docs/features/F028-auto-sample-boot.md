# F028 — Live first paint (auto-load a sample at boot)

## Metadata

| Field | Value |
|-------|-------|
| ID | F028 |
| Phase | 8 |
| Size | XS |
| Skill fit | `glue` |
| Depends on | F019 (ready flag), F023 (samples); composes with F025 |
| Status | `[x]` done (2026-09-10; code + `lint`/`build` clean with real wasm bindings; 4 manual/browser criteria need a browser — see notes) |

## Goal

The app never opens onto a dead viewport: once the engine reports ready and no
model has been chosen yet, the **Teardrop** sample loads automatically, so a
first-time visitor sees flow developing around a body within seconds — before
touching anything.

## Context

Today boot ends in an empty tunnel; all tuning controls sit disabled until the
user discovers the Samples panel. `ModelContext` already exposes
`loadSample(id)` and keeps samples/uploads mutually exclusive; `useSimulation`
already handles "sample selected" identically to an upload. This feature is a
single guarded effect — **no changes** to `ModelContext`, `useSimulation`, or
the sample pipeline.

## Detailed spec

1. New component `src/components/controls/AutoSampleBoot.tsx`
   (client component, renders `null`):

   ```tsx
   export function AutoSampleBoot() {
     const { ready } = useSimulationContext();
     const { file, sample, loadSample } = useModel();
     const firedRef = useRef(false);
     useEffect(() => {
       if (!ready || firedRef.current) return;
       if (file !== null || sample !== null) {
         // User beat us to it (fast click or preserved state) — never override.
         firedRef.current = true;
         return;
       }
       firedRef.current = true;
       loadSample("teardrop");
     }, [ready, file, sample, loadSample]);
     return null;
   }
   ```

   Rules encoded above, verbatim:
   - Fires **at most once** per mount (`firedRef`), only after `ready`.
   - Never fires if *any* model choice already exists — user intent always wins.
   - The sample id is the Teardrop's id **as declared in
     `src/lib/mesh/samples.ts`** — read that file and use the exact literal
     (do not guess `"teardrop"` if the file says otherwise).
2. Mount `<AutoSampleBoot />` in `src/app/page.tsx` inside `Home`, next to
   `<SimulationLoopHost />` (inside both providers).
3. Because `SimulationProvider` remounts on boot-retry (`engineAttempt` key),
   place `AutoSampleBoot` **inside** the keyed provider so a retry gets a fresh
   attempt — this is automatic if mounted next to `SimulationLoopHost`; do not
   add extra state for it.
4. The Samples gallery must show Teardrop as `active` after boot (this is
   existing `ModelContext` behavior — verify, don't implement).

## Files to create / modify

```
src/components/controls/AutoSampleBoot.tsx  (new)    — the guarded effect above
src/app/page.tsx                            (modify) — mount it next to SimulationLoopHost
```

## Dependencies added

- none

## Interface contract

- Consumes existing `useSimulationContext().ready` and
  `useModel().{file, sample, loadSample}` only. Exposes nothing.

## Acceptance criteria

- [ ] Cold load: after "Loading engine…" clears, the Teardrop appears and flow
      develops with **no user interaction**; the gallery shows Teardrop active
      and the step-2 rail enables (F025 chip flips if F025 is merged).
      **NOT VERIFIED HERE — needs a browser** (effect is verbatim per spec;
      mount point confirmed inside both providers).
- [ ] Clicking Sphere within the loading window results in Sphere, not
      Teardrop (user intent wins).
      **NOT VERIFIED HERE — needs a browser** (guard holds by construction:
      `file/sample !== null` sets `firedRef` without calling `loadSample`).
- [ ] Uploading a file immediately after boot replaces the Teardrop normally
      (existing exclusivity — no double-load, no flicker loop).
      **NOT VERIFIED HERE — needs a browser** (no changes to `ModelContext`
      exclusivity; `firedRef` prevents a second fire).
- [ ] Boot-retry path (engine load failure → Retry) still auto-loads once the
      engine comes up.
      **NOT VERIFIED HERE — needs a browser** (mount is inside the keyed
      `SimulationProvider`, so Retry remounts the effect with a fresh ref —
      verified by inspection of `page.tsx`).
- [x] Lint + build clean.
      (Verified 2026-09-10 — eslint zero errors/warnings; `next build`
      succeeds with the real `src/wasm/` bindings present.)

## Test plan

- Manual: hard-refresh with cache disabled → observe auto-load; then repeat
  while spam-clicking Cube during engine load → Cube wins.
- Manual: DevTools → throttle CPU ×6 → confirm no double `loadSample`
  (add a temporary `console.count`, remove before commit).

## Out of scope

- Remembering the last model across visits (localStorage) — deliberate: boot
  is deterministic.
- Any onboarding tour, tooltip walkthrough, or modal.
- Updating the README demo script (still valid — step 2 becomes optional).
