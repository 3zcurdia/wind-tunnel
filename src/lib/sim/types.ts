export type ModelFormat = "obj" | "ply";

export interface LoadedFile {
  /** Original filename */
  name: string;
  format: ModelFormat;
  /** Full file bytes */
  data: ArrayBuffer;
  sizeBytes: number;
}

export const MAX_MODEL_FILE_BYTES = 50 * 1024 * 1024;

/** Lattice domain size in cells (F005 constants; F021 makes these runtime). */
export const DOMAIN = { nx: 128, ny: 48, nz: 48 } as const;

/** 3-component vector tuple used for lattice-space bounds/offsets. */
export type Vec3 = readonly [number, number, number];

/** three.js loader failed to parse the file bytes. */
export class ModelParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelParseError";
  }
}

/** Geometry is degenerate (e.g. zero-size bounding box) and cannot be placed. */
export class DegenerateModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DegenerateModelError";
  }
}

type ValidateOk = { ok: true; format: ModelFormat };
type ValidateErr = { ok: false; reason: string };

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Validate an upload candidate (F004). Pure — no React, no I/O.
 * Extension check is case-insensitive; size in bytes.
 */
export function validateFile(file: File): ValidateOk | ValidateErr {
  const ext = extensionOf(file.name);
  if (ext !== "obj" && ext !== "ply") {
    return { ok: false, reason: "Unsupported format — use .obj or .ply" };
  }
  if (file.size === 0) {
    return { ok: false, reason: "File is empty" };
  }
  if (file.size > MAX_MODEL_FILE_BYTES) {
    return { ok: false, reason: "File too large (max 50 MB)" };
  }
  return { ok: true, format: ext };
}
