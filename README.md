# Wind Tunnel Simulator

A browser-based, desktop-first **wind tunnel toy**: upload a 3D model (OBJ or PLY),
a Rust/WebAssembly Lattice-Boltzmann solver runs simplified-but-real CFD around it,
and Three.js renders the flow as particle streamlines, smoke tracers, and a
pressure-colored surface — with live tuning of wind speed, air pressure, and
viscosity.

> **Educational/visual simulator — not industrial CFD.**

<!-- TODO: screenshot after F014–F017 land (docs/screenshot.png) -->

## Features

- **Model upload** — drag & drop `.obj` / `.ply`; models are normalized into the
  tunnel domain automatically
- **Real-ish flow physics** — Lattice Boltzmann (D3Q19) solver compiled to
  WebAssembly, running voxelized CFD around your model in the browser
- **Particle streamlines** — up to 100k particles colored by flow speed
- **Surface pressure heatmap** — the classic wind-tunnel look: blue → white → red
  on the model surface, with live legend
- **Smoke tracers** — a rake of fading smoke ribbons you can position and resize
- **Live instrument readout** — drag coefficient, drag force, pressure extremes,
  Reynolds number, FPS
- **Tunable air** — wind speed (1–60 m/s), air pressure (50–110 kPa), dynamic
  viscosity — everything responds live
- **Quality presets** — Low / Medium / High grid & particle budget, auto-probed
  for your machine

## Quick Start

Prerequisites:

- **Node.js 20+**
- **Rust toolchain** (only needed to build the simulation engine):
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  cargo install wasm-pack        # or: brew install wasm-pack (macOS)
  ```

Run it:

```bash
npm install
npm run wasm:build   # builds the Rust engine → src/wasm/ (gitignored)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), drop an OBJ/PLY file (or pick
a built-in sample), and watch the air move.

TS-only changes don't need a wasm rebuild; any Rust change does.

## Architecture

The plan, contracts, and 23 self-contained feature specs live in
[`.agents/docs/`](.agents/docs/):

- [`ARCHITECTURE.md`](.agents/docs/ARCHITECTURE.md) — stack, data flow, domain
  conventions, the WASM ABI contract
- [`ROADMAP.md`](.agents/docs/ROADMAP.md) — milestones, feature board, dependency
  graph
- [`CONVENTIONS.md`](.agents/docs/CONVENTIONS.md) — coding rules & Definition of
  Done
- [`features/`](.agents/docs/features/) — one spec per feature (F001–F023)

In short: **Next.js 16 + React 19 + TypeScript** app shell · **Three.js** renders
the scene and parses models · **Rust → wasm-pack** owns the LBM solver, particle
pool, pressure extraction, and stats · the two sides talk through one batched,
zero-copy typed-array ABI.

## Commands

| Command | What it does |
|---------|--------------|
| `npm run dev` | Dev server at `localhost:3000` |
| `npm run build` | Production build (must pass) |
| `npm run lint` | ESLint (must be clean) |
| `npm run wasm:build` | `wasm-pack` build of the Rust crate into `src/wasm/` |
| `cargo test` *(in `wasm/`)* | Rust unit tests for solver/voxelization/units |

## Troubleshooting

- **"Simulation engine failed to load — run `npm run wasm:build`"** — the
  generated WASM bindings are missing (they're gitignored). Install `wasm-pack`
  (see prerequisites) and run `npm run wasm:build`.
- **`wasm-pack: command not found`** — install it: `cargo install wasm-pack`
  (or `brew install wasm-pack` on macOS).
- **Blank viewport / WebGL errors** — this app needs WebGL2 (current Chrome,
  Edge, Firefox, or Safari). Update your browser, and make sure hardware
  acceleration is enabled in browser settings.
- **Low framerate** — switch the quality preset to Low; close other WebGL tabs.
- **Upload rejected** — only `.obj` / `.ply` ≤ 50 MB are accepted; check the file
  extension and size.
