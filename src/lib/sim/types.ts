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

/**
 * Live simulation readout for the stats bar (F017).
 *
 * Durable contract: F019's `SimEngine.getReadout()` / `SimulationContext`
 * assembles this same shape (the temporary `voxelBridge.getReadout()` is
 * deleted then, the component consuming it is unchanged).
 */
export interface SimReadout {
  /** Display refresh rate from JS-side rAF deltas (EMA), frames/s. */
  fps: number;
  /** Lattice steps computed per second (wasm `steps_done()` delta). */
  stepsPerSecond: number;
  /** Time-averaged drag coefficient; null while the F013 sentinel holds. */
  cd: number | null;
  /** Drag force [N]; null while the F013 sentinel holds. */
  dragN: number | null;
  /** Min/max vertex pressure [Pa] plus the stagnation reference [Pa]. */
  pMinPa: number;
  pMaxPa: number;
  qRefPa: number;
  /** Reynolds number U·L/ν from the last `set_conditions`. */
  re: number;
  /** Lattice grid dimensions in cells. */
  gridDims: [number, number, number];
  /** Currently alive particles in the wasm pool. */
  activeParticles: number;
  /** Latched stability flag (F010; `reset_flow()` clears it). */
  stable: boolean;
  /** Uploaded model filename (null when no model is loaded). */
  modelName: string | null;
  /** Parsed triangle count (null when unknown). */
  modelTriangles: number | null;
}

/** Em dash placeholder for "no meaningful value" cells. */
export const READOUT_PLACEHOLDER = "—";

/**
 * Pure number formatters for the stats bar (F017 test plan). All map
 * non-finite input to the placeholder; `formatCd` additionally maps the
 * F013 `cd === -1` sentinel (the bridge already nulls it — this is belt
 * and braces so the panel can never render "-1.000").
 */
export function formatCd(cd: number | null): string {
  if (cd === null || !Number.isFinite(cd) || cd === -1) {
    return READOUT_PLACEHOLDER;
  }
  return cd.toFixed(3);
}

/** Drag force [N] with 2 decimals; null/non-finite → placeholder. */
export function formatDragN(dragN: number | null): string {
  if (dragN === null || !Number.isFinite(dragN)) {
    return READOUT_PLACEHOLDER;
  }
  return dragN.toFixed(2);
}

/** Pascals as kPa with 2 decimals (spec §1); non-finite → placeholder. */
export function formatKPa(pa: number): string {
  if (!Number.isFinite(pa)) return READOUT_PLACEHOLDER;
  return (pa / 1000).toFixed(2);
}

/**
 * Compact scientific notation, e.g. 249472 → "2.5e5" (spec §1 example).
 * `toExponential` emits "2.5e+5" — the "+" is stripped to match.
 */
export function formatRe(re: number): string {
  if (!Number.isFinite(re)) return READOUT_PLACEHOLDER;
  return re.toExponential(1).replace("e+", "e");
}

/** Integer display for fps / steps-per-second / particle counts. */
export function formatInt(n: number): string {
  if (!Number.isFinite(n)) return READOUT_PLACEHOLDER;
  return String(Math.max(0, Math.round(n)));
}

/** Compact triangle count, e.g. 12345 → "12.3k"; null → placeholder. */
export function formatTriangles(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return READOUT_PLACEHOLDER;
  const rounded = Math.max(0, Math.round(n));
  if (rounded < 10000) return String(rounded);
  return `${(rounded / 1000).toFixed(1)}k`;
}
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
