# Architecture — Wind Tunnel Simulator

Read this fully before implementing any feature. This document is the **contract** that
lets independent contributors (human or AI) work on separate features without breaking
each other. Where a feature spec and this file conflict, this file wins; record the
conflict in `.agents/docs/DECISIONS.md`.

---

## 1. Stack (pinned)

| Layer | Choice | Notes |
|-------|--------|-------|
| App framework | Next.js 16.3.4 (App Router) + React 19 + TypeScript | already scaffolded |
| Styling | Tailwind CSS 4 | already configured |
| 3D rendering | Three.js (latest stable) + `@types/three` | WebGL2, no WebGPU in v1 |
| Model parsing | three.js addons `OBJLoader` / `PLYLoader` | parsing stays in JS |
| Simulation core | Rust → `wasm-pack --target web` → `wasm-bindgen` | crate lives in `wasm/` |
| Compute model | LBM D3Q19 (BGK collision), voxel obstacle grid | simplified real CFD |
| Target device | Desktop browsers, ≥60fps goal, WebGL2 + WASM required | show a capability notice if unsupported |

> This Next.js version may differ from your training data. Before writing any
> Next-specific code, read the relevant guide in `node_modules/next/dist/docs/`.

---

## 2. Target folder layout

```
wind-tunnel/
├── src/
│   ├── app/                        # Next.js App Router
│   │   ├── layout.tsx
│   │   ├── page.tsx                # the single wind-tunnel page (client composition)
│   │   └── globals.css
│   ├── components/
│   │   ├── viewport/
│   │   │   ├── Viewport.tsx        # React wrapper: mounts SceneManager (client-only)
│   │   │   └── SceneManager.ts     # owns three.js scene/camera/renderer/loop
│   │   ├── controls/
│   │   │   ├── UploadPanel.tsx     # F004
│   │   │   ├── ControlPanel.tsx    # F018
│   │   │   └── StatsPanel.tsx      # F017
│   │   └── ui/                     # small shared atoms: Slider, Toggle, Button, Panel
│   ├── lib/
│   │   ├── sim/
│   │   │   ├── wasm.ts             # WASM loader singleton (F003)
│   │   │   ├── SimEngine.ts        # owns WASM instance; the ONLY caller of raw ABI (F010/F019)
│   │   │   ├── SimulationContext.tsx  # React context providing SimEngine state (F019)
│   │   │   └── types.ts            # shared TS types mirroring ABI structs
│   │   ├── mesh/
│   │   │   ├── loadModel.ts        # OBJ/PLY → BufferGeometry (F005)
│   │   │   └── normalize.ts        # center/scale into domain box (F005)
│   │   ├── viz/
│   │   │   ├── ParticleSystem.ts   # F014
│   │   │   ├── HeatmapOverlay.ts   # F015
│   │   │   ├── SmokeTracers.ts     # F016
│   │   │   └── colormaps.ts        # shared color maps (blue→red etc.)
│   │   └── hooks/
│   │       └── useSimulation.ts    # rAF orchestration (F019)
│   └── wasm/                       # (generated) wasm-bindgen output, gitignored
├── wasm/                           # Rust crate root
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs                  # wasm-bindgen exports — the ABI below
│       ├── voxel.rs                # F006
│       ├── lbm.rs                  # F007, F008
│       ├── units.rs                # F009
│       ├── advection.rs            # F011
│       ├── pressure.rs             # F012
│       ├── stats.rs                # F013
│       └── particles.rs            # F011 (particle pool state)
└── public/samples/                 # F023 sample models
```

Rules:
- `SceneManager` is the **only** module that touches `three.js` scene objects.
- `SimEngine` is the **only** module that calls the WASM ABI. Visualization modules
  receive typed-array views from it; they never import `wasm.ts` directly.
- React components never import `three` or `wasm` directly — only via `SceneManager`
  / `SimEngine` / contexts.

---

## 3. Domain & lattice conventions

The simulation domain is a rectangular box of lattice cells. Wind flows along **+X**.

```
        x=0 (inlet)                    x=nx-1 (outlet)
         ┌──────────────────────────────────┐
   y     │  → → →   ┌────┐      → → →  → →  │   free-slip walls on ±y, ±z
   │ →→→ │  → → →   │OBST│      → → →  → →  │
   ▼     │  → → →   └────┘      → → →  → →  │
         └──────────────────────────────────┘
```

| Property | Convention |
|----------|-----------|
| Cell indexing | `(x, y, z)` with `x ∈ [0, nx)`, row-major: `idx = x + nx*(y + ny*z)` |
| Default grid | `128 × 48 × 48` (quality presets change this, see F021) |
| Obstacle placement | centered at `x = 0.35·nx`, `y = ny/2`, `z = nz/2` |
| Lattice units | 1 cell = 1 lattice unit of length; `Δx_lattice = 1` |
| Lattice speed of sound | `c_s² = 1/3` (lattice units) |
| Stability limits | `u_lattice ≤ 0.15`, `τ ∈ [0.505, 0.95]` (clamped, never violated) |
| Physical domain length | `L_domain` meters (default `1.0`), so `Δx_phys = L_domain / nx` |

**Coordinate spaces (naming matters):**

- **model space** — raw parsed geometry, arbitrary units/origin.
- **domain space (lattice)** — geometry translated+scaled so the model fits inside the
  obstacle placement region; 1 unit = 1 lattice cell. Produced by `normalize.ts` (F005)
  and consumed by Rust. All Rust↔JS geometry exchange happens in domain space.
- **world space** — three.js render space. SceneManager maps domain space to a
  scene-pleasing scale (domain rendered as a box of e.g. 12.8 × 4.8 × 4.8 units).

---

## 4. Units model (implemented in F009, `wasm/src/units.rs`)

User-facing physical parameters:

| Parameter | Range (UI) | Default |
|-----------|-----------|---------|
| Wind speed `U` | 1 – 60 m/s | 15 m/s |
| Air pressure `P` | 50 – 110 kPa | 101.325 kPa |
| Dynamic viscosity `μ` | 0.5 – 3.0 ×10⁻⁵ Pa·s | 1.81 ×10⁻⁵ Pa·s |
| Temperature | fixed 20 °C (293.15 K) | — |

Derived (Rust owns the math):

```
ρ = P / (R_specific · T),  R_specific = 287.05 J/(kg·K)
ν = μ / ρ                                          [m²/s]
Choose Δx_phys = L_domain / nx
Choose u_lattice (target 0.05–0.15, clamped ≤ 0.15)
Δt = u_lattice · Δx_phys / U                       [s]
ν_lattice = ν · Δt / Δx_phys²
τ = ν_lattice / c_s² + 0.5,  c_s² = 1/3            [lattice]
Re = U · L_char / ν   (L_char = obstacle bbox longest side)
```

If `τ` falls outside `[0.505, 0.95]`, adjust `u_lattice` downward (or lengthen the
domain conceptually) until it fits; if impossible, report `unstable: true`.

Pressure for display: LBM density `ρ_lattice` → `p_rel = c_s² · (ρ_lattice − ρ₀)` in
lattice units, converted to Pa via `p_rel_phys = c_s²(ρ_lattice − 1) · ρ_phys · (Δx_phys/Δt)²`.
The heatmap primarily uses *normalized relative pressure* (−1…+1 mapped against
½ρU² stagnation reference) — exact formulas live in F012/F013.

---

## 5. WASM ABI contract (single source of truth)

All exports live in `wasm/src/lib.rs` via `#[wasm_bindgen]`. **Batched calls only** —
nothing in this ABI may be called per-particle or per-cell in a loop from JS.

```rust
// ── lifecycle ────────────────────────────────────────────────────────────
/// Allocate domain & solver state. Safe to call again to rebuild (resets everything).
init_sim(nx: u32, ny: u32, nz: u32, particle_capacity: u32)

/// Compute lattice parameters from physical inputs. Pure function.
/// Returns (u_lattice, tau, dt, dx_phys, re, unstable_flag) as a plain object.
set_conditions(u_mps: f64, pressure_kpa: f64, viscosity_pas: f64,
               domain_length_m: f64, char_length_m: f64) -> LatticeParams

/// Voxelize a mesh. Triangles are 9 floats each, in DOMAIN space.
/// Returns number of solid cells. Replaces any previous mesh.
set_mesh(triangles: &[f32]) -> u32
clear_mesh()

/// Re-initialize the flow field to uniform inlet conditions (keeps the mesh).
reset_flow()

// ── simulation ───────────────────────────────────────────────────────────
/// Advance exactly n lattice steps.
step(n: u32)
/// Stability check (cheap): false if any NaN / ρ ≤ 0 detected since last call.
is_stable() -> bool

// ── buffers (zero-copy views into wasm linear memory) ───────────────────
/// Particle pool: xyz triplets, active-first ordering.
particles_ptr() -> *const f32          // len = particle_capacity * 3
speeds_ptr()   -> *const f32           // per active particle, lattice speed |u|
active_particle_count() -> u32
/// Per-mesh-vertex relative pressure scalar, in order of `set_mesh` vertices.
vertex_pressure_ptr() -> *const f32
/// Obstacle grid, 1 byte per cell (0 empty / 1 solid), row-major as §3.
occupancy_ptr() -> *const u8

// ── sampling & action ────────────────────────────────────────────────────
/// Batch velocity sampling. points = n×3 domain-space coords, out = n×3 velocities.
sample_velocity_batch(points: &[f32], out: &mut [f32])

/// (Re)seed particles at the inlet plane. Clears the pool.
spawn_particles(count: u32)

/// Integrate particles one dt. Kills those exiting the domain or entering solid.
advect_particles(dt_lattice: f32)

// ── stats ────────────────────────────────────────────────────────────────
/// Aggregated stats; cheap enough to call at ~4 Hz from JS.
stats() -> StatsRecord
// StatsRecord { cd: f64, drag_n: f64, p_min_pa: f64, p_max_pa: f64,
//               re: f64, steps: u64, active_particles: u32, stable: bool }
```

**Buffer-view rules (JS side, in `SimEngine`):**

```ts
const pos = new Float32Array(wasm.memory.buffer, wasm.particles_ptr() as number, cap * 3);
```

- Pointers are stable **only** until the next allocation-triggering call
  (`init_sim`, `set_mesh`, `spawn_particles`). After those, re-fetch pointers.
- Never hold a view across such calls; `SimEngine.refreshViews()` re-fetches.
- Copy out (or read synchronously in the same frame) everything you need.

**Forbidden:** per-particle `sample_velocity` calls from JS; JS-side re-implementation
of solver math; exporting more than the above without updating this file first.

---

## 6. Runtime data flow

```
User drags file ──► UploadPanel (F004) ──► loadModel (F005, three.js loader)
      ──► normalize to domain space (F005)
      ──► SimEngine.setMesh(verts, indices)            [JS: build triangle f32 array]
      ──► wasm.set_mesh(...) ──► voxel grid (F006)
      ──► wasm.reset_flow() ──► uniform flow

Per animation frame (useSimulation, F019):
      ──► SimEngine.tick(frameBudget):
            wasm.step(stepsPerFrame)                   [adaptive: 1–8]
            wasm.advect_particles(dt)
            (heatmap throttle) read vertex_pressure view
            stats at 4 Hz
      ──► SceneManager.render():
            ParticleSystem.update(positions, speeds)   [F014]
            HeatmapOverlay.update(vertexPressure)      [F015]
            SmokeTracers.update(sampledVelocities)     [F016]
            renderer.render(scene, camera)
```

Control flow for parameter changes (F018 → F009 → F010): UI slider change →
`SimEngine.setConditions({U, P, μ})` → `wasm.set_conditions(...)` → if `unstable`,
clamp + surface a warning; **viscosity changes trigger a soft restart**
(`reset_flow`) because τ changes mid-run destabilize a converged field.

---

## 7. Performance budget (desktop, mid-range GPU/CPU, 2024+)

| Item | Budget |
|------|--------|
| `wasm.step(1)` @ 128×48×48 | ≤ 4 ms |
| `wasm.advect_particles` @ 60k particles | ≤ 2 ms |
| three.js render (particles + mesh + tracers) | ≤ 8 ms |
| Frame total | ≤ 16.7 ms (60 fps), acceptable dips to 30 fps |
| WASM memory | ≤ 512 MB (grid ~45 MB at defaults, particles ~2 MB) |

Adaptive strategy (F019): measure `step` time with a rolling window; adjust
steps-per-frame (1–8) and warn (not crash) when the budget is exceeded.

---

## 8. Anti-goals (v1)

- No server-side compute, no network calls at runtime (fully client-side).
- No turbulence models, no thermal coupling, no compressibility beyond LBM's weak one.
- No mobile layout work (desktop-first; F022 only ensures it degrades gracefully).
- No WebGPU compute. No workers in v1 (WASM stays on the main thread; F022 notes the
  OffscreenCanvas/Worker escape hatch as future work).
- No account system, no persistence beyond quality-preset localStorage (F021).
