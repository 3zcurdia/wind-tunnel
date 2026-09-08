"use client";

import { useEffect, useRef } from "react";
import { UploadPanel } from "@/components/controls/UploadPanel";
import { ParticleCountSlider } from "@/components/controls/ParticleCountSlider";
import { SmokeProbe } from "@/components/controls/SmokeProbe";
import { VoxelDebugToggle } from "@/components/controls/VoxelDebugToggle";
import { Panel } from "@/components/ui/Panel";
import { WasmProbe } from "@/components/ui/WasmProbe";
import ViewportMount from "@/components/viewport/ViewportMount";
import { getSceneManager } from "@/components/viewport/viewportBridge";
import { useModelPipeline } from "@/lib/hooks/useModelPipeline";
import { parseModel } from "@/lib/mesh/loadModel";
import { normalizeToDomain } from "@/lib/mesh/normalize";
import { ModelProvider, useModel } from "@/lib/sim/ModelContext";
import { startParticleDriver, voxelizeGeometry } from "@/lib/sim/voxelBridge";

function ModelPipelineHost() {
  useModelPipeline();
  return null;
}

/**
 * TEMPORARY voxel pipeline (F006; folded into `SimEngine` in F019).
 * Mirrors `useModelPipeline`'s parse → normalize path, then voxelizes the
 * domain-space geometry and feeds the snapshot to the SceneManager debug
 * layer. Kept separate (with its own generation counter) because F006's file
 * list does not include the shared pipeline module.
 */
function VoxelPipelineHost() {
  const { file } = useModel();
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    if (!file) {
      getSceneManager()?.clearVoxelDebug();
      return;
    }

    let cancelled = false;
    void (async () => {
      const parsed = await parseModel(file).catch(() => null);
      if (!parsed || cancelled || generationRef.current !== generation) return;
      try {
        const normalized = normalizeToDomain(parsed.geometry);
        try {
          if (cancelled || generationRef.current !== generation) return;
          const snapshot = await voxelizeGeometry(normalized.geometry);
          if (cancelled || generationRef.current !== generation) return;
          getSceneManager()?.updateVoxelDebug(
            snapshot.occupancy,
            snapshot.nx,
            snapshot.ny,
            snapshot.nz,
          );
        } finally {
          normalized.geometry.dispose();
        }
      } catch {
        // Parse/normalize/voxelize failures surface via the main pipeline's
        // error state; the previous debug cloud is left untouched.
      } finally {
        parsed.geometry.dispose();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file]);

  return null;
}

/**
 * TEMPORARY particle driver host (F014; folded into `useSimulation` in F019).
 * Waits for the SceneManager to mount (Viewport registers it asynchronously),
 * then starts the voxelBridge particle driver; stops + disposes on unmount.
 */
function ParticleDriverHost() {
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (cancelled || stop !== null) return;
      const manager = getSceneManager();
      if (!manager) return;
      window.clearInterval(timer);
      stop = startParticleDriver(manager);
    }, 100);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      stop?.();
      stop = null;
    };
  }, []);

  return null;
}

export default function Home() {
  return (
    <ModelProvider>
      <ModelPipelineHost />
      <VoxelPipelineHost />
      <ParticleDriverHost />
      <div className="flex h-screen flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
          <h1 className="text-sm font-semibold tracking-wide">Wind Tunnel</h1>
          <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
            ※ demo placeholder
          </span>
        </header>
        <main className="flex flex-1 gap-4 p-4">
          <Panel title="Controls" className="w-80 shrink-0">
            <div className="space-y-4">
              <p className="text-xs text-neutral-500">
                Upload + tuning controls wire in F004 / F018.
              </p>
              <UploadPanel />
              <WasmProbe />
              <VoxelDebugToggle />
              <SmokeProbe />
              <ParticleCountSlider />
            </div>
          </Panel>
          <div className="min-h-[70vh] flex-1 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900">
            <ViewportMount />
          </div>
        </main>
        <footer className="h-28 shrink-0 border-t border-neutral-800 p-4">
          <Panel title="Stats" className="h-full">
            <p className="text-xs text-neutral-500">
              Live stats wire in F017.
            </p>
          </Panel>
        </footer>
      </div>
    </ModelProvider>
  );
}
