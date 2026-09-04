# FXXX — Feature title

> **Copy this template** into `F<NNN>-<slug>.md` and fill every section. Delete nothing
> except the placeholder text. The goal: an implementer who has read `ARCHITECTURE.md`
> + `CONVENTIONS.md` + this file alone can build the feature correctly.

## Metadata

| Field | Value |
|-------|-------|
| ID | FXXX |
| Phase | 0–6 |
| Size | XS / S / M |
| Skill fit | `UI` / `UI/3D` / `Rust` / `logic` / `glue` / `docs` / `build` |
| Depends on | FYYY (what must exist first) |
| Status | `[ ]` todo |

## Goal

One paragraph: what exists after this feature that didn't before, from the user's or
the system's perspective.

## Context

What the implementer needs to know: relevant sections of `ARCHITECTURE.md`, prior
decisions, why the approach is the way it is. Link, don't restate, unless the detail
is essential here.

## Detailed spec

The actual work, numbered and unambiguous. Include exact function/component names,
file paths, algorithms, data shapes, defaults. Prefer tables and code blocks over
prose. Specify behavior for edge cases that appear in Acceptance criteria.

## Files to create / modify

```
path/to/new-file.ts        (new) — what it contains
path/to/existing-file.ts   (modify) — what changes and why
```

## Dependencies added

- `package-name@version` — why (or "none")

## Interface contract

Signatures this feature exposes to the rest of the app, and signatures it consumes
from dependencies. Must match `ARCHITECTURE.md`; if you need to change an existing
contract, stop and record it in `DECISIONS.md` instead.

## Acceptance criteria

- [ ] Concrete, checkable statements ("viewport shows X", "wasm.set_mesh returns 27 for the unit cube grid"). Include exact numbers where possible.

## Test plan

- Unit tests (Rust `#[cfg(test)]` or TS): list each test by name and what it asserts,
  including tolerances for numeric checks.
- Manual verification: exact steps a human performs in the browser and what they see.

## Out of scope

Explicit list of things a well-meaning implementer might add but must NOT (guards
against scope creep across models).
