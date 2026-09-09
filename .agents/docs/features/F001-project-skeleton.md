# F001 — Project skeleton & conventions

## Metadata

| Field | Value |
|-------|-------|
| ID | F001 |
| Phase | 0 |
| Size | XS |
| Skill fit | `glue` |
| Depends on | — (first feature) |
| Status | `[x]` done |

## Goal

The repo's default `create-next-app` scaffold is replaced by the project's real layout:
every directory from `ARCHITECTURE.md` §2 exists with a placeholder, the default Next.js
starter page is replaced by a static "wind tunnel" shell layout (header, control-rail
placeholder, viewport area placeholder, stats-bar placeholder), and
`npm run lint` + `npm run build` pass. Nothing dynamic yet — this is pure scaffolding.

## Context

This is the first feature; all others create files inside the directories you create
here. Follow `ARCHITECTURE.md` §2 exactly — later specs reference those paths. Read
`node_modules/next/dist/docs/01-app/01-getting-started/02-project-structure.md` before
touching `src/app`.

## Detailed spec

1. **Gitignore additions** (append to existing `.gitignore`):
   ```
   wasm/target/
   src/wasm/
   ```
2. **Directory creation** — create these folders, each with a `.gitkeep` placeholder
   that later features will delete when they add real files:
   `src/components/viewport`, `src/components/controls`, `src/components/ui`,
   `src/lib/sim`, `src/lib/mesh`, `src/lib/viz`, `src/lib/hooks`, `public/samples`,
   `wasm/src`.
3. **Root layout** (`src/app/layout.tsx`): set `<html lang="en" className="dark">`,
   `<body className="bg-neutral-950 text-neutral-100 antialiased">`, metadata title
   `"Wind Tunnel Simulator"`, description from ROADMAP vision line.
4. **Placeholder page** (`src/app/page.tsx`): a static, server-renderable layout with:
   - Header bar (h-12): title "Wind Tunnel"
   - Main area: `flex` — left rail `w-80` (empty panel placeholder with title
     "Controls"), remaining area a bordered `min-h-[60vh]` box titled "Viewport".
   - Bottom bar (h-28): "Stats" placeholder.
   - No client interactivity, no `"use client"` anywhere in this feature.
5. **Delete** the default `create-next-app` page boilerplate (Geist font demo content).
   Keep `next/font` usage if trivial, otherwise drop to plain system font stack.
6. **UI atoms** (`src/components/ui/`): create `Panel.tsx` — a presentational wrapper
   (`rounded-lg border border-neutral-800 bg-neutral-900 p-4` + optional `title` prop)
   used by the placeholders above. No other atoms yet.
7. Verify `npm run lint` and `npm run build` pass; fix whatever the scaffold emits.

## Files to create / modify

```
.gitignore                                  (modify) — wasm entries
src/app/layout.tsx                          (modify) — metadata, dark theme
src/app/page.tsx                            (modify) — replace starter page
src/components/ui/Panel.tsx                 (new)    — panel atom
src/components/{viewport,controls}/.gitkeep (new)    — placeholders
src/lib/{sim,mesh,viz,hooks}/.gitkeep       (new)
public/samples/.gitkeep                     (new)
wasm/src/.gitkeep                           (new)
```

## Dependencies added

- none

## Interface contract

- `Panel` props: `{ title?: string; className?: string; children: React.ReactNode }`.
- Nothing exported elsewhere yet.

## Acceptance criteria

- [x] `npm run dev` shows: dark shell, header "Wind Tunnel", left rail "Controls",
      main "Viewport" box, bottom "Stats" bar.
- [x] All §2 `ARCHITECTURE.md` directories exist (empty ones via `.gitkeep`).
- [x] `npm run lint` and `npm run build` pass with zero errors/warnings.
- [x] No `"use client"` directives added by this feature.
- [x] `.gitignore` ignores `wasm/target/` and `src/wasm/`.

## Test plan

- Manual: run `npm run dev`, confirm layout; run `npm run build`, confirm clean exit.
- No unit tests required.

## Out of scope

- Any three.js or WASM code (F002/F003).
- Any state management, contexts, or interactivity.
- Changing `next.config.ts`, `eslint.config.mjs`, or `tsconfig.json` (unless the build
  fails for a pre-existing scaffold reason — then record in `DECISIONS.md`).
