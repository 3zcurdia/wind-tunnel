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
import { validateFile, type LoadedFile } from "./types";

export interface ModelMeta {
  triangles?: number;
  vertices?: number;
}

export type ModelStatus = "empty" | "valid" | "invalid";

export interface ModelContextValue {
  file: LoadedFile | null;
  status: ModelStatus;
  error?: string;
  /** Populated by F005's parse pipeline; F004 renders it when present. */
  meta?: ModelMeta;
  /** True while `File.arrayBuffer()` is in flight. */
  reading: boolean;
  setFile(f: File): void;
  clear(): void;
  /** F005 pipeline: record triangle/vertex counts after a successful parse. */
  setMeta(meta: ModelMeta | undefined): void;
  /** F005 pipeline: surface a parse/normalize failure as the panel error. */
  setParseError(message: string): void;
}

const ModelContext = createContext<ModelContextValue | null>(null);

export function ModelProvider({ children }: { children: ReactNode }) {
  const [file, setFileState] = useState<LoadedFile | null>(null);
  const [status, setStatus] = useState<ModelStatus>("empty");
  const [error, setError] = useState<string | undefined>(undefined);
  const [meta, setMeta] = useState<ModelMeta | undefined>(undefined);
  const [reading, setReading] = useState(false);
  const generationRef = useRef(0);

  const setFile = useCallback((f: File) => {
    const validation = validateFile(f);
    if (!validation.ok) {
      // New attempt clears any in-flight read and any previous file.
      generationRef.current += 1;
      setReading(false);
      setFileState(null);
      setMeta(undefined);
      setStatus("invalid");
      setError(validation.reason);
      return;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    // New attempt clears the previous error immediately.
    setError(undefined);
    setReading(true);
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
  }, []);

  const clear = useCallback(() => {
    generationRef.current += 1;
    setFileState(null);
    setMeta(undefined);
    setStatus("empty");
    setError(undefined);
    setReading(false);
  }, []);

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
      status,
      error,
      meta,
      reading,
      setFile,
      clear,
      setMeta: setMetaValue,
      setParseError,
    }),
    [file, status, error, meta, reading, setFile, clear, setMetaValue, setParseError],
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
