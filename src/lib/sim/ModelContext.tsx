"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { buildSampleGeometry, type SampleId } from "@/lib/mesh/samples";
import { wrapAngleDeg } from "@/lib/sim/SimEngine";
import { validateFile, type LoadedFile } from "./types";

export interface ModelMeta {
  triangles?: number;
  vertices?: number;
}

export type ModelStatus = "empty" | "valid" | "invalid";

/**
 * Angle-of-attack orientation in degrees (F024).
 *
 * Lattice space, right-handed: **yaw** about +Y (vertical turntable),
 * **pitch** about +Z (nose up/down in the X-Y plane), **roll** about +X
 * (about the wind axis). Each angle lives in `[-180, 180)`.
 */
export interface ModelOrientation {
  readonly yawDeg: number;
  readonly pitchDeg: number;
  readonly rollDeg: number;
}

/** A new model always starts unrotated (F024). */
export const DEFAULT_ORIENTATION: ModelOrientation = {
  yawDeg: 0,
  pitchDeg: 0,
  rollDeg: 0,
};

export interface ModelContextValue {
  file: LoadedFile | null;
  /**
   * Active built-in sample (F023). Mutually exclusive with `file` — the
   * latest of `setFile` / `loadSample` wins; `clear()` resets both.
   */
  sample: SampleId | null;
  status: ModelStatus;
  error?: string;
  /** Populated by F005's parse pipeline; F004 renders it when present. */
  meta?: ModelMeta;
  /** True while `File.arrayBuffer()` is in flight. */
  reading: boolean;
  /**
   * Committed angle-of-attack orientation (F024). The `useSimulation`
   * commit effect re-voxelizes + soft-restarts on every change.
   */
  orientation: ModelOrientation;
  /**
   * Merge a partial orientation over the current one, wrapping each angle
   * to `[-180, 180)`; stores and returns the applied value. Unchanged
   * values keep the same reference (no spurious commits downstream).
   */
  setOrientation(partial: Partial<ModelOrientation>): ModelOrientation;
  /** Commit back to unrotated (a no-op when already default). */
  resetOrientation(): void;
  setFile(f: File): void;
  /**
   * F023 sample path: places the procedural geometry's counts directly into
   * the pipeline state (the `useSimulation` loop rebuilds the same geometry
   * via `buildSampleGeometry` and converges with uploads at "normalized
   * geometry ready"). Clears any uploaded file.
   */
  loadSample(id: SampleId): void;
  clear(): void;
  /** F005 pipeline: record triangle/vertex counts after a successful parse. */
  setMeta(meta: ModelMeta | undefined): void;
  /** F005 pipeline: surface a parse/normalize failure as the panel error. */
  setParseError(message: string): void;
}

const ModelContext = createContext<ModelContextValue | null>(null);

export function ModelProvider({ children }: { children: ReactNode }) {
  const [file, setFileState] = useState<LoadedFile | null>(null);
  const [sample, setSampleState] = useState<SampleId | null>(null);
  const [status, setStatus] = useState<ModelStatus>("empty");
  const [error, setError] = useState<string | undefined>(undefined);
  const [meta, setMeta] = useState<ModelMeta | undefined>(undefined);
  const [reading, setReading] = useState(false);
  const [orientation, setOrientationState] =
    useState<ModelOrientation>(DEFAULT_ORIENTATION);
  const generationRef = useRef(0);

  const setOrientation = useCallback(
    (partial: Partial<ModelOrientation>): ModelOrientation => {
      // Compares against the rendered value (this callback re-binds every
      // render, so it is current for event/effect callers) and keeps the
      // same reference when nothing changed.
      const yawDeg = wrapAngleDeg(
        partial.yawDeg !== undefined ? partial.yawDeg : orientation.yawDeg,
      );
      const pitchDeg = wrapAngleDeg(
        partial.pitchDeg !== undefined
          ? partial.pitchDeg
          : orientation.pitchDeg,
      );
      const rollDeg = wrapAngleDeg(
        partial.rollDeg !== undefined ? partial.rollDeg : orientation.rollDeg,
      );
      if (
        yawDeg !== orientation.yawDeg ||
        pitchDeg !== orientation.pitchDeg ||
        rollDeg !== orientation.rollDeg
      ) {
        const next: ModelOrientation = { yawDeg, pitchDeg, rollDeg };
        setOrientationState(next);
        return next;
      }
      return orientation;
    },
    [orientation],
  );

  const resetOrientation = useCallback(() => {
    // New-model paths (setFile/loadSample/clear) reuse this too: a new
    // model always starts unrotated. An already-default state keeps its
    // reference (no spurious commit-effect runs).
    setOrientationState((prev) =>
      prev.yawDeg === 0 && prev.pitchDeg === 0 && prev.rollDeg === 0
        ? prev
        : DEFAULT_ORIENTATION,
    );
  }, []);

  const setFile = useCallback((f: File) => {
    const validation = validateFile(f);
    if (!validation.ok) {
      // New attempt clears any in-flight read and any previous file.
      generationRef.current += 1;
      setReading(false);
      setFileState(null);
      setSampleState(null);
      setMeta(undefined);
      setStatus("invalid");
      setError(validation.reason);
      resetOrientation();
      return;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    // New attempt clears the previous error and any active sample.
    setError(undefined);
    setSampleState(null);
    setReading(true);
    resetOrientation();
    void (async () => {
      try {
        const data = await f.arrayBuffer();
        if (generationRef.current !== generation) return;
        setFileState({
          name: f.name,
          format: validation.format,
          data,
          sizeBytes: f.size,
        });
        setSampleState(null);
        setMeta(undefined);
        setStatus("valid");
        setError(undefined);
      } catch {
        if (generationRef.current !== generation) return;
        setFileState(null);
        setMeta(undefined);
        setStatus("invalid");
        setError("Failed to read file");
      } finally {
        if (generationRef.current === generation) setReading(false);
      }
    })();
  }, [resetOrientation]);

  const loadSample = useCallback((id: SampleId) => {
    // Latest wins: bump the generation so an in-flight file read is
    // abandoned, then synchronously replace any uploaded file.
    generationRef.current += 1;
    setReading(false);
    resetOrientation();
    const geometry = buildSampleGeometry(id);
    try {
      const position = geometry.getAttribute("position");
      const vertices = position?.count ?? 0;
      const index = geometry.getIndex();
      const triangles = index
        ? Math.floor(index.count / 3)
        : Math.floor(vertices / 3);
      setSampleState(id);
      setFileState(null);
      setMeta({ triangles, vertices });
      setStatus("valid");
      setError(undefined);
    } finally {
      // The loop rebuilds the same geometry on demand; only counts live here.
      geometry.dispose();
    }
  }, [resetOrientation]);

  const clear = useCallback(() => {
    generationRef.current += 1;
    setFileState(null);
    setSampleState(null);
    setMeta(undefined);
    setStatus("empty");
    setError(undefined);
    setReading(false);
    resetOrientation();
  }, [resetOrientation]);

  const setMetaValue = useCallback((m: ModelMeta | undefined) => {
    setMeta(m);
  }, []);

  const setParseError = useCallback((message: string) => {
    setMeta(undefined);
    setStatus("invalid");
    setError(message);
  }, []);

  const value = useMemo<ModelContextValue>(
    () => ({
      file,
      sample,
      status,
      error,
      meta,
      reading,
      orientation,
      setOrientation,
      resetOrientation,
      setFile,
      loadSample,
      clear,
      setMeta: setMetaValue,
      setParseError,
    }),
    [
      file,
      sample,
      status,
      error,
      meta,
      reading,
      orientation,
      setOrientation,
      resetOrientation,
      setFile,
      loadSample,
      clear,
      setMetaValue,
      setParseError,
    ],
  );

  return (
    <ModelContext.Provider value={value}>{children}</ModelContext.Provider>
  );
}

export function useModel(): ModelContextValue {
  const ctx = useContext(ModelContext);
  if (ctx === null) {
    throw new Error("useModel must be used inside <ModelProvider>");
  }
  return ctx;
}
