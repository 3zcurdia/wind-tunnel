# F004 — Upload UI (drag & drop, validation)

## Metadata

| Field | Value |
|-------|-------|
| ID | F004 |
| Phase | 1 |
| Size | S |
| Skill fit | `UI` |
| Depends on | F001 (Panel atom); designed against F005's consumer API |
| Status | `[ ]` todo |

## Goal

The Controls rail contains an upload panel: users drag a `.obj`/`.ply` file (or click
to browse) and, on success, the app holds the raw file data ready for parsing. Invalid
files and over-size files are rejected with clear inline errors. No parsing or 3D work
happens in this feature — it produces a `LoadedFile` handed to F005's pipeline.

## Context

`ARCHITECTURE.md` §2 places upload UI in `src/components/controls/UploadPanel.tsx`.
File reading stays simple: `File.arrayBuffer()` for both formats (PLY may be ASCII —
the three.js `PLYLoader` accepts an ArrayBuffer regardless). The consumer hook-up
(order of implementation): this feature defines the `LoadedFile` type and a `ModelContext`
skeleton; F005 fills the parsing pipeline that reacts to it.

## Detailed spec

1. **Types** (`src/lib/sim/types.ts` — create if absent):
   ```ts
   export type ModelFormat = 'obj' | 'ply';
   export interface LoadedFile {
     name: string;            // original filename
     format: ModelFormat;
     data: ArrayBuffer;       // full file bytes
     sizeBytes: number;
   }
   ```
2. **Validation rules** (exported `validateFile(file: File): { ok: true; format: ModelFormat } | { ok: false; reason: string }`):
   - Extension (case-insensitive) must be `.obj` or `.ply`; else reason
     `"Unsupported format — use .obj or .ply"`.
   - Size ≤ 50 MB; else `"File too large (max 50 MB)"`.
   - Size > 0; else `"File is empty"`.
3. **`ModelContext`** (`src/lib/sim/ModelContext.tsx`): React context + provider
   holding `{ file: LoadedFile | null; status: 'empty' | 'valid' | 'invalid';
   error?: string; setFile(f: File): void; clear(): void }`. `setFile` runs
   validation, reads the ArrayBuffer on success, stores `LoadedFile`. Context lives
   in `lib/sim` but is a `.tsx` (provider holds UI-agnostic state only — no three.js).
4. **`UploadPanel.tsx`** (Controls rail, inside a `Panel` titled "Model"):
   - Drop zone: dashed border (`border-dashed border-neutral-700`), min-h-32,
     "Drop an OBJ or PLY file here" + "or click to browse". Full drop zone is a
     `<button>`-like clickable area opening a hidden `<input type="file" accept=".obj,.ply">`.
   - Drag-over state: border and background highlight (`border-blue-500/60`).
   - While reading (arrayBuffer in flight): spinner glyph + "Reading file…",
     input disabled.
   - Success state: filename, size in KB/MB, format badge, triangle/vertex counts
     if available (F005 populates these — leave a `meta?: { triangles?: number; vertices?: number }`
     field in context now, render "—" when absent).
   - Error state: red inline message above the drop zone; field clears after a new
     attempt.
   - "Remove" button in success state → `clear()` back to empty state.
   - Whole panel: `<Panel title="Model">`.
5. **Page wiring**: wrap `page.tsx` content in `ModelProvider`; mount `UploadPanel`
   in the Controls rail above the (temporary) WasmProbe from F003.
6. **Accessibility**: drop zone focusable, `aria-label="Upload 3D model file"`,
   error text `role="alert"`.

## Files to create / modify

```
src/lib/sim/types.ts                     (new or modify) — LoadedFile, ModelFormat
src/lib/sim/ModelContext.tsx             (new)    — provider + useModel() hook
src/components/controls/UploadPanel.tsx  (new)    — drop zone + states
src/app/page.tsx                         (modify) — provider wrap + mount panel
```

## Dependencies added

- none

## Interface contract

- `useModel(): ModelContextValue` (throws if outside provider).
- `ModelContextValue.meta` is set by F005; F004 renders it when present.
- `validateFile` is exported from `types.ts` and unit-testable without React.

## Acceptance criteria

- [ ] Dropping `model.obj` (< 50 MB) → success card with name/size/format, no errors.
- [ ] Dropping a `.stl` → inline error "Unsupported format — use .obj or .ply".
- [ ] Creating a 60 MB dummy `.obj` (`dd`/`head -c`) → "File too large (max 50 MB)".
- [ ] Zero-byte file → "File is empty".
- [ ] Drag-over highlights the drop zone; drag-leave resets it; drop outside the
      zone does nothing harmful.
- [ ] Remove button returns panel to empty state; uploading a second file replaces
      the first.
- [ ] Keyboard: tab to drop zone, Enter opens file picker.
- [ ] `npm run lint` / `npm run build` pass.

## Test plan

- Unit (`types.ts` validation only, run manually via `node --test` if the spec author
  adds it — optional per CONVENTIONS): extension/size/empty cases.
- Manual: all acceptance-criteria flows via real drag & drop and file picker.
- Manual: upload a binary-mangled `.obj` (random bytes) — must still reach the
  success state here (parsing errors are F005's concern, surfaced later through
  `meta`/parse pipeline).

## Out of scope

- Parsing, geometry, three.js (F005).
- Multiple-file selection, folder drops, model libraries, server upload (never —
  fully client-side per ARCHITECTURE §8).
- Any WASM calls.
