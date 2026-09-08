"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UploadPanel } from "@/components/controls/UploadPanel";
import { ControlPanel } from "@/components/controls/ControlPanel";
import { SmokeProbe } from "@/components/controls/SmokeProbe";
import { StatsPanel } from "@/components/controls/StatsPanel";
import ViewportMount from "@/components/viewport/ViewportMount";
import { getSceneManager } from "@/components/viewport/viewportBridge";
import { useModelPipeline } from "@/lib/hooks/useModelPipeline";
import { parseModel } from "@/lib/mesh/loadModel";
import { normalizeToDomain } from "@/lib/mesh/normalize";
import { ModelProvider, useModel } from "@/lib/sim/ModelContext";
import {
  DEFAULT_CHAR_LEN_M,
  DEFAULT_CONDITIONS,
  DOMAIN_LENGTH_M,
  type FlowConditions,
} from "@/lib/sim/conditions";
import {
  resetSimFlow,
  setFlowConditions,
  startHeatmapDriver,
  startParticleDriver,
  startSmokeDriver,
  voxelizeGeometry,
} from "@/lib/sim/voxelBridge";

/** Trailing debounce for wasm condition commits (F018 §2: ≤ ~7 calls/s). */
const CONDITIONS_DEBOUNCE_MS = 150;

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
 * then starts the voxelBridge particle driver; stops + disposes on unmount or
 * while paused (pausing halts stepping — resume reuses the primed engine, so
 * the developed flow survives; smoke trails reseed).
 */
function ParticleDriverHost({ running }: { readonly running: boolean }) {
  useEffect(() => {
    if (!running) return;
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
  }, [running]);

  return null;
}

/**
 * TEMPORARY heatmap driver host (F015; folded into `useSimulation` in F019).
 * Same mount-wait pattern as `ParticleDriverHost`: starts the voxelBridge
 * heatmap driver once the SceneManager is live; stops + detaches on unmount
 * or while paused.
 */
function HeatmapDriverHost({ running }: { readonly running: boolean }) {
  useEffect(() => {
    if (!running) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (cancelled || stop !== null) return;
      const manager = getSceneManager();
      if (!manager) return;
      window.clearInterval(timer);
      stop = startHeatmapDriver(manager);
    }, 100);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      stop?.();
      stop = null;
    };
  }, [running]);

  return null;
}

/**
 * TEMPORARY smoke driver host (F016; folded into `useSimulation` in F019).
 * Same mount-wait pattern as `ParticleDriverHost`: starts the voxelBridge
 * smoke driver once the SceneManager is live; stops + disposes on unmount or
 * while paused.
 */
function SmokeDriverHost({ running }: { readonly running: boolean }) {
  useEffect(() => {
    if (!running) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (cancelled || stop !== null) return;
      const manager = getSceneManager();
      if (!manager) return;
      window.clearInterval(timer);
      stop = startSmokeDriver(manager);
    }, 100);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      stop?.();
      stop = null;
    };
  }, [running]);

  return null;
}

interface FlowBackend {
  readonly conditions: FlowConditions;
  readonly setConditions: (next: FlowConditions) => void;
  readonly resetFlow: () => void;
  readonly resetAll: () => void;
  readonly engineReady: boolean;
  readonly conditionsUnstable: boolean;
  readonly engineError: string | null;
}

/**
 * TEMPORARY conditions/transport backend (F018; `SimulationContext` in F019).
 *
 * Owns the slider state, debounces wasm commits (150 ms trailing — at most
 * ~7 `set_conditions` calls/s during a fast drag), and chains the documented
 * soft restart (`reset_flow`) onto the viscosity path only. Speed/pressure
 * commits never reset. Failures surface as `engineError` (never silent).
 */
function useFlowBackend(): FlowBackend {
  const [conditions, setConditionsState] =
    useState<FlowConditions>(DEFAULT_CONDITIONS);
  const [engineReady, setEngineReady] = useState(false);
  const [conditionsUnstable, setConditionsUnstable] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const lastMuRef = useRef(DEFAULT_CONDITIONS.viscosityPas);
  const pendingRef = useRef<FlowConditions | null>(null);
  const timerRef = useRef<number | null>(null);

  const fireBackend = useCallback(
    async (next: FlowConditions, forceReset: boolean): Promise<void> => {
      try {
        const applied = await setFlowConditions(
          {
            uMps: next.uMps,
            pressureKpa: next.pressureKpa,
            viscosityPas: next.viscosityPas,
          },
          DEFAULT_CHAR_LEN_M,
          DOMAIN_LENGTH_M,
        );
        if (forceReset || next.viscosityPas !== lastMuRef.current) {
          await resetSimFlow();
        }
        lastMuRef.current = next.viscosityPas;
        setConditionsUnstable(applied.unstable);
        setEngineError(null);
        setEngineReady(true);
      } catch {
        setEngineError("Engine update failed — retry shortly.");
      }
    },
    [],
  );

  const setConditions = useCallback(
    (next: FlowConditions) => {
      setConditionsState(next);
      pendingRef.current = next;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (pending !== null) {
          void fireBackend(pending, false);
        }
      }, CONDITIONS_DEBOUNCE_MS);
    },
    [fireBackend],
  );

  const resetFlow = useCallback(() => {
    void (async () => {
      try {
        await resetSimFlow();
        setEngineError(null);
      } catch {
        setEngineError("Engine reset failed — retry shortly.");
      }
    })();
  }, []);

  const resetAll = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    setConditionsState(DEFAULT_CONDITIONS);
    void fireBackend(DEFAULT_CONDITIONS, true);
  }, [fireBackend]);

  // Prime the engine with the slider defaults on mount (also the readiness
  // probe gating the sliders); flush any pending drag value on unmount.
  // The state sets below run only after the async engine load resolves, never
  // synchronously in the effect body — this is external-system
  // synchronization, the sanctioned effect use.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fireBackend(DEFAULT_CONDITIONS, false);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending !== null) {
        void fireBackend(pending, false);
      }
    };
  }, [fireBackend]);

  return useMemo(
    () => ({
      conditions,
      setConditions,
      resetFlow,
      resetAll,
      engineReady,
      conditionsUnstable,
      engineError,
    }),
    [
      conditions,
      setConditions,
      resetFlow,
      resetAll,
      engineReady,
      conditionsUnstable,
      engineError,
    ],
  );
}

/**
 * Controls rail: UploadPanel first, then the F018 instrument panel, then the
 * remaining temporary probe (F011's SmokeProbe — deleted in F019 with the
 * rest of the temporary layer).
 */
function ControlsRail({
  running,
  onToggleRun,
}: {
  readonly running: boolean;
  readonly onToggleRun: () => void;
}) {
  const { file, meta } = useModel();
  const backend = useFlowBackend();
  const hasModel = file !== null && meta !== undefined;

  const transport = useMemo(
    () => ({
      running,
      toggleRun: onToggleRun,
      resetFlow: backend.resetFlow,
      resetAll: backend.resetAll,
    }),
    [running, onToggleRun, backend.resetFlow, backend.resetAll],
  );

  return (
    <div className="w-80 shrink-0 space-y-4 overflow-y-auto pr-1">
      <UploadPanel />
      <ControlPanel
        conditions={backend.conditions}
        setConditions={backend.setConditions}
        transport={transport}
        controlsDisabled={!backend.engineReady || !hasModel}
        conditionsUnstable={backend.conditionsUnstable}
        engineError={backend.engineError}
      />
      <SmokeProbe />
    </div>
  );
}

export default function Home() {
  const [running, setRunning] = useState(true);
  const toggleRun = useCallback(() => {
    setRunning((r) => !r);
  }, []);

  return (
    <ModelProvider>
      <ModelPipelineHost />
      <VoxelPipelineHost />
      <ParticleDriverHost running={running} />
      <HeatmapDriverHost running={running} />
      <SmokeDriverHost running={running} />
      <div className="flex h-screen flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
          <h1 className="text-sm font-semibold tracking-wide">Wind Tunnel</h1>
          <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
            ※ demo placeholder
          </span>
        </header>
        <main className="flex min-h-0 flex-1 gap-4 p-4">
          <ControlsRail running={running} onToggleRun={toggleRun} />
          <div className="min-h-[70vh] flex-1 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900">
            <ViewportMount />
          </div>
        </main>
        <footer className="h-16 shrink-0 border-t border-neutral-800 px-4 py-2">
          <StatsPanel />
        </footer>
      </div>
    </ModelProvider>
  );
}
