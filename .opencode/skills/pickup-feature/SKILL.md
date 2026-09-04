---
name: pickup-feature
description: Pick up and implement one feature spec from the wind-tunnel project roadmap (.agents/docs/features/F001-F023) end-to-end, with verification and status bookkeeping. Use when the user says "pick up a feature", "implement F0XX", "next feature", "work on the roadmap", "continue the project", or names a feature ID like F005.
---

# Pick up & implement a wind-tunnel feature

Implement **exactly one feature** per invocation of this skill. The specs in
`.agents/docs/features/` are self-contained; this workflow is how you consume
them correctly. Never batch two features into one run.

## 1. Select the feature

- If the user named a feature (e.g. "implement F006"), use it — after confirming
  it isn't already done.
- Otherwise: open `.agents/docs/ROADMAP.md`, list the unchecked `[ ]` features,
  and keep only those whose "Depends on" entries are **all** checked `[x]`.
  Choose the candidate with the lowest phase, then lowest ID.
- The UI track (F004/F005, F014–F018, F020) and the Rust solver track
  (F006–F013) run in parallel after F003 — see ROADMAP's dependency graph. If
  two candidates are equally unblocked and the choice materially changes the
  work, ask the user which track to take.
- Announce before starting: feature ID + title, size/skill tags from its
  metadata table, and one line on why it's unblocked.

## 2. Required reading — in order, before writing any code

1. `.agents/docs/ARCHITECTURE.md` — fully. It is the binding contract
   (folder layout, domain conventions, WASM ABI §5, budgets).
2. `.agents/docs/CONVENTIONS.md` — especially Definition of Done.
3. The chosen feature spec — fully, including Out of scope.
4. The **Interface contract** sections of the specs it depends on (not the
   whole files).
5. If the feature touches Next.js APIs (App Router, `ssr: false`, dynamic
   imports, config): read the relevant guide in `node_modules/next/dist/docs/`
   first — this Next.js version intentionally differs from training data.

## 3. Blockers & conflicts

- Any dependency unchecked → do not start. Report the blocker and offer the
  next unblocked feature instead.
- Spec conflicts with code reality or with another spec → **stop coding**.
  Write a dated note in `.agents/docs/DECISIONS.md` (create the file if
  missing) describing the conflict and the smallest change consistent with
  `ARCHITECTURE.md`. Never silently deviate from a spec.
- Never edit another feature's spec file, `AGENTS.md`, or `next.config.ts`
  unless your own spec explicitly says so.

## 4. Implement

- Create/modify **only** the files in the spec's "Files to create / modify"
  list, plus package installs it sanctions (record them under the spec's
  "Dependencies added").
- Honor every interface contract verbatim — signatures, buffer semantics,
  naming, return shapes. If the spec says to update `ARCHITECTURE.md` §5 in the
  same change, do it.
- Rust features: no panics in exported functions, no allocation in steady-state
  step/advect loops, `wasm_bindgen` only in `lib.rs`, and unit tests named
  exactly as the spec's Test plan lists them with the spec's literal tolerances.
- TS/React features: three.js and wasm usage stays client-only (mount via
  Client Components / `ssr: false` per the bundled Next docs), dispose all
  listeners/loops/GPU resources on unmount, no `any`.
- Anything the spec marks **TEMPORARY** is deliberate scaffolding — build it as
  written; F019 removes it. Do not "clean it up" early.
- Do not refactor neighboring code that looks wrong but is outside the file
  list. Note issues in the final report instead.

## 5. Verify — Definition of Done (all required)

```bash
npm run lint                 # zero errors AND zero warnings
npm run build                # must succeed
cargo test                   # in wasm/ — required when Rust files were touched
```

- Rust features: `npm run wasm:build` must regenerate working bindings. If
  `wasm-pack` is not installed, say so, verify via `cargo test` only, and list
  the end-to-end check as an open item for the user.
- Implement and run every test named in the spec's Test plan. Keep the spec's
  exact tolerances — do not loosen them to make a test pass; a tolerance that
  can't be met is a DECISIONS.md entry.
- Where the spec asks to record observed values (benchmarks, Cd brackets) in
  `DECISIONS.md`, do it.
- Manual/visual acceptance criteria: perform what's possible in this
  environment; explicitly list any you could not perform so the user can check
  them in a browser.

## 6. Finish — bookkeeping & report

1. Tick each acceptance-criteria checkbox in the feature spec that you actually
   demonstrated. Leave unticked (with a short note) any you couldn't verify.
2. Tick the feature's checkbox in `.agents/docs/ROADMAP.md` (both the phase
   board entry — there is one list).
3. Sweep for leftovers: no `console.log`, no dev counters, no TODO comments
   beyond ones the spec itself requests.
4. Final report to the user: what was built, DoD command results, observed
   numbers worth knowing, unverified manual steps, and discovered issues in
   neighboring code (if any).

Do **not** commit unless the user explicitly asks. When asked, use Conventional
Commits scoped to the feature: `feat(F006): flood-fill voxelization`,
`fix(F010): ...`, `docs: ...`.
