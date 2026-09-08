/**
 * Application error taxonomy (F022).
 *
 * Every user-facing failure maps onto `AppError` with a stable `kind` and a
 * short `userMessage` (≤ 90 chars, no stack traces in the UI). Technical
 * detail goes through `console.error` at the throw/catch site, never into
 * `userMessage`.
 *
 * Pure module — no React, no three.js, no wasm imports — so any layer
 * (`loadModel`, `normalize`, `SimEngine`, `SceneManager`, page wiring) can
 * depend on it without creating cycles.
 */

export type AppErrorKind =
  | "wasm-load"
  | "parse"
  | "degenerate-model"
  | "model-too-large"
  | "voxelize-failed"
  | "solver-unstable"
  | "webgl-lost"
  | "unknown";

export class AppError extends Error {
  readonly kind: AppErrorKind;
  /** Human-readable message for the UI (≤ 90 chars, no stack traces). */
  readonly userMessage: string;

  constructor(
    kind: AppErrorKind,
    userMessage: string,
    options?: { cause?: unknown },
  ) {
    super(userMessage, options);
    this.name = "AppError";
    this.kind = kind;
    this.userMessage = userMessage;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/**
 * Map any thrown value onto an `AppError` for UI display (F022 §1).
 *
 * Known typed errors keep their F005/F003 identities at the throw site (those
 * contracts are preserved); this helper translates them at the display
 * boundary so every failure path renders a friendly message and leaves the
 * app usable. Unknown values become `kind: "unknown"`.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) {
    switch (err.name) {
      case "WasmLoadError":
        return new AppError("wasm-load", toUserMessage(err), { cause: err });
      case "ModelParseError":
        return new AppError("parse", toUserMessage(err), { cause: err });
      case "DegenerateModelError":
        return new AppError("degenerate-model", toUserMessage(err), {
          cause: err,
        });
      case "ScreenshotError":
        return new AppError("webgl-lost", toUserMessage(err), { cause: err });
      default:
        return new AppError("unknown", toUserMessage(err), { cause: err });
    }
  }
  return new AppError("unknown", "Something went wrong — retry shortly.");
}

/**
 * Derive a ≤ 90-char UI message from a raw error. Prefers an existing short
 * message; truncates anything longer (no stacks — `Error.message` never
 * contains one).
 */
function toUserMessage(err: Error): string {
  const raw = (err.message ?? "").trim().replace(/\s+/g, " ");
  if (raw.length === 0) return "Something went wrong — retry shortly.";
  if (raw.length <= 90) return raw;
  return `${raw.slice(0, 87)}…`;
}
