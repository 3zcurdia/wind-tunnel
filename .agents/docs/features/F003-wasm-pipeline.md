# F003 — Rust→WASM pipeline wired into Next.js

## Metadata

| Field | Value |
|-------|-------|
| ID | F003 |
| Phase | 0 |
| Size | M |
| Skill fit | `Rust/build` |
| Depends on | F001 |
| Status | `[ ]` todo |

## Goal

A Rust crate in `wasm/` compiles to WebAssembly via `wasm-pack --target web`, is
loaded client-side by a singleton loader (`src/lib/sim/wasm.ts`), and a trivial
exported function is callable from the app. `npm run wasm:build` regenerates the
bindings; `npm run build` succeeds with the WASM artifact committed-or-generated
locally. This de-risks the entire toolchain before any real solver work.

## Context

All future Rust features (F006–F013) export functions from this crate; the ABI is
defined in `ARCHITECTURE.md` §5 — this feature only adds a temporary `ping()` probe
function to prove the pipeline, structured so real exports can be added without
touching the loader. `ARCHITECTURE.md` forbids any module except `SimEngine` from
calling the raw ABI; `SimEngine` does not exist yet, so `wasm.ts` is the singleton
owner for now and F019 will move call-sites behind `SimEngine`.

## Detailed spec

1. **Rust crate** (`wasm/`):
   ```toml
   # wasm/Cargo.toml
   [package]
   name = "windtunnel"
   version = "0.1.0"
   edition = "2021"

   [lib]
   crate-type = ["cdylib", "rlib"]

   [dependencies]
   wasm-bindgen = "0.2"

   [profile.release]
   opt-level = 3
   lto = true
   ```
   - `wasm/src/lib.rs`: `use wasm_bindgen::prelude::*;` plus
     `#[wasm_bindgen] pub fn ping() -> String { "pong".to_string() }`.
   - Add `wasm/.gitignore`: `/target`.
2. **Build script** — `package.json` scripts:
   - `"wasm:build": "wasm-pack build wasm --target web --out-dir ../src/wasm --out-package windtunnel"` 
   - `"predev"`/`"prebuild"` hooks are NOT added (builds stay explicit to avoid
     requiring Rust for TS-only work). Document in README that Rust work requires
     `npm run wasm:build` first.
   - If `wasm-pack` output layout differs (this tooling changes between versions),
     adapt flags minimally; the contract is: generated JS glue + `.wasm` land in
     `src/wasm/` and are importable as a module. Record exact commands that worked in
     `DECISIONS.md`.
3. **Loader** (`src/lib/sim/wasm.ts`):
   - Module-level singleton: `let loadPromise: Promise<WasmApi> | null`.
   - `export async function loadWasm(): Promise<WasmApi>` — dynamic
     `import('@/src/wasm/windtunnel')` (path adjusted to actual output), calls its
     default `init()` (wasm-bindgen `--target web` pattern), caches the result,
     returns an object starting as `{ ping(): string }` plus the raw exports for
     later growth.
   - On failure: throw a typed `WasmLoadError` with a human-readable message
     ("Simulation engine failed to load — run `npm run wasm:build`").
   - Export `export type WasmApi = { ping(): string }` for now.
4. **Dev probe**: temporary client component `src/components/ui/WasmProbe.tsx` shown
   in the Controls rail: a small button "Test engine" that calls `loadWasm()`,
   displays `ping()` result (`pong` in green) or the error message (in red). This
   component is deleted in F019 (note it in the spec's Files list with "temporary").
5. **Turbopack/webpack check**: run `npm run build`. If the bundler mishandles the
   `.wasm` import, fallback plan (documented, in this order):
   a. Mark `src/wasm/**` as external + copy artifacts to `public/wasm/` in the build
      script and fetch-instantiate manually in `wasm.ts` via
      `WebAssembly.instantiateStreaming` with a tiny hand-written glue object.
   b. Whichever path works, implement only that one, and document it precisely in
      `wasm.ts` comments and `DECISIONS.md` so later features don't fight it.
6. **TypeScript**: add `src/wasm/` to tsconfig `exclude` if generated JS has type
   errors; write a minimal `src/lib/sim/wasm-types.d.ts` declaring the module shape.

## Files to create / modify

```
wasm/Cargo.toml                    (new)    — crate manifest
wasm/src/lib.rs                    (new)    — ping() probe
wasm/.gitignore                    (new)    — /target
src/lib/sim/wasm.ts                (new)    — singleton loader + WasmLoadError
src/lib/sim/wasm-types.d.ts        (new)    — module declaration (if needed)
src/components/ui/WasmProbe.tsx    (new)    — TEMPORARY dev probe (deleted in F019)
src/components/controls/.gitkeep   (delete) — replaced by real files later; keep for now
package.json                       (modify) — wasm:build script
src/app/page.tsx                   (modify) — WasmProbe into Controls rail
tsconfig.json                      (modify) — exclude src/wasm if required
src/wasm/**                        (generated, gitignored)
```

## Dependencies added

- Rust crates: `wasm-bindgen` (in `wasm/Cargo.toml`)
- Tooling: `wasm-pack` — record the install command used (`cargo install wasm-pack`
  or brew) in README "Development prerequisites" section (small addition, one line).

## Interface contract

- `loadWasm(): Promise<WasmApi>` — memoized; concurrent callers share one promise;
  subsequent calls after rejection retry fresh (never cache a rejected promise).
- `WasmLoadError extends Error`, `name: 'WasmLoadError'`.
- `ping(): string` — temporary probe export, removed with F019.

## Acceptance criteria

- [ ] `npm run wasm:build` produces `src/wasm/` artifacts from a clean clone (after
      installing wasm-pack), without warnings that would break release.
- [ ] Browser: clicking "Test engine" shows `pong` in green.
- [ ] Breaking the artifact deliberately (rename) makes the button show the
      `WasmLoadError` message in red, and the app does not crash.
- [ ] `npm run build` succeeds including the WASM asset in the client bundle.
- [ ] `cargo test` passes inside `wasm/` (trivial — proves toolchain).
- [ ] Loader is idempotent: two rapid clicks produce one load (singleton verified via
      console counter in dev only — remove counter after verifying).

## Test plan

- Manual: full flow above; also test a fresh page load → click → success.
- Manual: `npm run build` after `wasm:build`; confirm no bundler errors.
- Rust: `cargo test` runs (no tests yet — proves command works).

## Out of scope

- Any solver math, `init_sim`, buffers, or real ABI functions (F006+).
- Calling WASM from `SceneManager` or render loop.
- Worker/OffscreenCanvas offloading (explicitly out for v1, see ARCHITECTURE §8).
- Committing generated `src/wasm/` (stays gitignored; document that a fresh clone
  needs `npm run wasm:build` before Rust-dependent features work).
