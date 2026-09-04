<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project: Wind Tunnel Simulator

A browser-based, desktop-first wind tunnel toy: users upload a 3D model (OBJ/PLY),
a Rust→WebAssembly Lattice-Boltzmann (D3Q19) solver runs simplified-but-real CFD
around it, and Three.js renders particle streamlines, smoke tracers, and a
pressure-colored surface, with live tuning of wind speed, air pressure, and
viscosity. **Educational/visual simulator — not industrial CFD.**

## Stack

- Next.js 16.3.4 (App Router) + React 19 + TypeScript (strict) + Tailwind 4
- Three.js (WebGL2) for rendering; model parsing via its OBJ/PLY loaders (JS side)
- Rust → `wasm-pack --target web` → wasm-bindgen; crate at `wasm/`, generated
  bindings at `src/wasm/` (gitignored — build with `npm run wasm:build`)
- Simulation core: LBM D3Q19 (BGK collision), voxelized obstacle grid, 128×48×48
  default domain, wind along +X

## Where the plan lives — read before writing any code

All planning is in `.agents/docs/`:

| File | Purpose |
|------|---------|
| `.agents/docs/ROADMAP.md` | Master plan: milestones, feature board, dependency graph, risks |
| `.agents/docs/ARCHITECTURE.md` | Folder layout, domain/lattice conventions, **WASM ABI contract (§5)**, units model, perf budgets — the binding contract |
| `.agents/docs/CONVENTIONS.md` | Coding rules, Definition of Done, how to pick up a feature |
| `.agents/docs/features/F001…F023` | One self-contained spec per feature |

## Working rules

1. Read `ARCHITECTURE.md` fully, then `CONVENTIONS.md`, then **one** feature spec
   from `.agents/docs/features/`. Implement exactly one feature at a time.
2. `SimEngine` is the only module that calls the WASM ABI; `SceneManager` is the
   only module that touches three.js scene objects. Batched ABI calls only.
3. Do not refactor outside your feature's file list; do not edit another feature's
   spec. Conflicts go to `.agents/docs/DECISIONS.md` (create if missing).
4. This Next.js version differs from training data — consult
   `node_modules/next/dist/docs/` for App Router, `ssr: false` (Client Components
   only), and lazy-loading specifics.
5. Definition of Done (all required): `npm run lint` + `npm run build` clean,
   `cargo test` passing (Rust features), acceptance criteria in the spec checked,
   checkbox ticked in `ROADMAP.md`.

## Commands

```bash
npm run dev          # dev server (localhost:3000)
npm run lint         # eslint — must be clean
npm run build        # production build — must succeed
npm run wasm:build   # wasm-pack build of the Rust crate (requires wasm-pack)
cargo test           # run inside wasm/ — Rust unit tests
```
