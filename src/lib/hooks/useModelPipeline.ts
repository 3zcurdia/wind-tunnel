"use client";

import { useEffect, useRef } from "react";
import { getSceneManager } from "@/components/viewport/viewportBridge";
import { parseModel } from "../mesh/loadModel";
import { normalizeToDomain } from "../mesh/normalize";
import { useModel } from "../sim/ModelContext";

/**
 * Temporary file → scene pipeline (F005; F019 absorbs it into the unified
 * loop). Subscribes to ModelContext; on each new valid file it parses,
 * normalizes to domain space, shows the model, and records meta counts.
 * Parse failures surface as the context error state and leave the previous
 * 3D model untouched. Stale files (superseded uploads) are ignored via a
 * generation counter. This module is the only bridge between ModelContext
 * and SceneManager until F019.
 */
export function useModelPipeline(): void {
  const { file, setMeta, setParseError } = useModel();
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    if (!file) {
      getSceneManager()?.clearModel();
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const parsed = await parseModel(file);
        if (cancelled || generationRef.current !== generation) return;
        const normalized = normalizeToDomain(parsed.geometry);
        if (cancelled || generationRef.current !== generation) return;
        getSceneManager()?.showModel(normalized.geometry);
        if (cancelled || generationRef.current !== generation) return;
        setMeta({ triangles: parsed.triangles, vertices: parsed.vertices });
      } catch (err) {
        if (cancelled || generationRef.current !== generation) return;
        setParseError(err instanceof Error ? err.message : "Failed to parse model");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file, setMeta, setParseError]);
}
