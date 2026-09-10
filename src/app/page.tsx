"use client";

import { useEffect, useRef, useState } from "react";
import { SampleGallery } from "@/components/controls/SampleGallery";
import { UploadPanel } from "@/components/controls/UploadPanel";
import { ControlPanel } from "@/components/controls/ControlPanel";
import { QualitySection } from "@/components/controls/QualitySection";
import { StepHeader } from "@/components/controls/StepHeader";
import { StatsPanel } from "@/components/controls/StatsPanel";
import { Panel } from "@/components/ui/Panel";
import { Toasts } from "@/components/ui/Toast";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import ViewportMount from "@/components/viewport/ViewportMount";
import { RotateController } from "@/components/viewport/RotateController";
import { ViewToolbar } from "@/components/viewport/ViewToolbar";
import { getSceneManager } from "@/components/viewport/viewportBridge";
import type { SceneManager } from "@/components/viewport/SceneManager";
import { useSimulation } from "@/lib/hooks/useSimulation";
import { ModelProvider, useModel } from "@/lib/sim/ModelContext";
import { UNSTABLE_LOCK_MESSAGE } from "@/lib/sim/SimEngine";
import {
  SimulationProvider,
  useSimulationContext,
} from "@/lib/sim/SimulationContext";

/** Runs the F019 frame loop + model pipeline once (null render). */
function SimulationLoopHost() {
  useSimulation();
  return null;
}

/**
 * Full-screen boot-failure panel (F022 §5): wasm load failure at boot shows
 * the message plus Retry (remounts the provider for a fresh loader attempt —
 * no page reload) and a pointer to the README troubleshooting section (F023
 * owns that section; this anchor is intentionally marker-free).
 */
function EngineBootPanel({ onRetry }: { onRetry: () => void }) {
  const { ready, error } = useSimulationContext();
  if (ready || error === null) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-neutral-950 p-6 text-center">
      <p className="text-sm font-semibold text-neutral-100">
        Simulation engine failed to load
      </p>
      <p role="alert" className="max-w-md text-xs text-neutral-400">
        {error}
      </p>
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-700"
        >
          Retry
        </button>
        <a
          href="#troubleshooting"
          className="rounded-md px-3 py-1.5 text-xs text-blue-400 hover:underline"
        >
          README troubleshooting
        </a>
      </div>
    </div>
  );
}

/**
 * Persistent double-blowup banner (F022 §3): the engine latches after two
 * recoveries within 30 s and stops auto-recovering; this polls the latch
 * (500 ms, cleaned up on unmount) and offers a full Reset. Particles and
 * stats stay frozen behind it until Reset.
 */
function UnstableBanner() {
  const { getEngine, pushToast, syncRunning } = useSimulationContext();
  const [locked, setLocked] = useState(false);
  const toastedRef = useRef(false);

  useEffect(() => {
    const id = window.setInterval(() => {
      const isLocked = getEngine().isUnstableLocked();
      setLocked(isLocked);
      if (isLocked && !toastedRef.current) {
        toastedRef.current = true;
        pushToast(UNSTABLE_LOCK_MESSAGE, "error");
      } else if (!isLocked) {
        toastedRef.current = false;
      }
    }, 500);
    return () => {
      window.clearInterval(id);
    };
  }, [getEngine, pushToast]);

  if (!locked) return null;
  return (
    <div
      role="alert"
      className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-3 rounded-md border border-red-500/50 bg-red-950/90 px-3 py-2"
    >
      <span className="whitespace-nowrap text-xs text-red-200">
        {UNSTABLE_LOCK_MESSAGE}
      </span>
      <button
        type="button"
        onClick={() => {
          getEngine().resetUnstable();
          syncRunning();
          setLocked(false);
        }}
        className="rounded border border-red-400/50 px-2 py-0.5 text-xs text-red-100 hover:bg-red-900"
      >
        Reset
      </button>
    </div>
  );
}

/**
 * WebGL context-loss overlay (F022 §4): subscribes to the live SceneManager
 * once it mounts (500 ms poll, cleaned up on unmount) and shows
 * "Graphics context lost — Reload" until `webglcontextrestored`
 * auto-recovers. The Reload button is the fallback path.
 */
function ContextLostOverlay() {
  const [lost, setLost] = useState(false);

  useEffect(() => {
    let manager: SceneManager | null = null;
    let unsubLost: (() => void) | null = null;
    let unsubRestored: (() => void) | null = null;
    const id = window.setInterval(() => {
      const live = getSceneManager();
      if (live && live !== manager) {
        unsubLost?.();
        unsubRestored?.();
        manager = live;
        setLost(live.isContextLost());
        unsubLost = live.onContextLost(() => setLost(true));
        unsubRestored = live.onContextRestored(() => setLost(false));
      }
    }, 500);
    return () => {
      window.clearInterval(id);
      unsubLost?.();
      unsubRestored?.();
    };
  }, []);

  if (!lost) return null;
  return (
    <div
      role="alert"
      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-neutral-900/90 p-6 text-center"
    >
      <p className="text-sm font-semibold text-neutral-100">
        Graphics context lost — Reload
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-700"
      >
        Reload
      </button>
    </div>
  );
}

/**
 * Step 1 rail (F025): sample gallery, upload, and quality — the tunnel
 * setup flow. The header chip is active until a model lands (step 2 becomes
 * the active side).
 */
function SetupRail() {
  const { file, sample, meta } = useModel();
  const hasModel = (file !== null || sample !== null) && meta !== undefined;

  return (
    <div className="w-72 shrink-0 space-y-4 overflow-y-auto pr-1">
      <StepHeader step={1} label="Load & set up" active={!hasModel} />
      <SampleGallery />
      <UploadPanel />
      <Panel title="Tunnel">
        <QualitySection />
      </Panel>
    </div>
  );
}

/**
 * Step 2 rail (F025): live flow controls. Visually dimmed with a hint until
 * a model exists; transport stays functional so the empty-tunnel demo flow
 * is preserved (the fieldset only disables the tuning inputs).
 */
function TuneRail() {
  const sim = useSimulationContext();
  const { file, sample, meta } = useModel();
  const hasModel = (file !== null || sample !== null) && meta !== undefined;

  return (
    <div className="w-80 shrink-0 space-y-4 overflow-y-auto pl-1">
      <StepHeader step={2} label="Tune & run" active={hasModel} />
      {!hasModel ? (
        <p className="text-[11px] text-neutral-500">
          Pick a sample or upload a model to start the tunnel.
        </p>
      ) : null}
      <div className={hasModel ? undefined : "opacity-60"}>
        <ControlPanel
          conditions={sim.conditions}
          setConditions={sim.setConditions}
          transport={sim.transport}
          controlsDisabled={!sim.ready || !hasModel}
          conditionsUnstable={sim.conditionsUnstable}
          engineError={sim.error}
        />
      </div>
    </div>
  );
}

function ViewportPane() {
  const { ready, error } = useSimulationContext();
  const { file, sample, meta } = useModel();
  // Rotate toggle gate (F024): a model counts as loaded once the pipeline
  // recorded its counts (same rule as the controls rail below).
  const hasModel = (file !== null || sample !== null) && meta !== undefined;
  // F020 fullscreen target: the container, so the toolbar rides along.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // F022 §6: ErrorBoundary Reset remounts the viewport through this key.
  const [viewportKey, setViewportKey] = useState(0);
  // F024 rotate mode: local to the pane; the controller mounts only while
  // active. Losing the model (clear / new upload resetting `meta`) exits
  // via render-time adjustment (re-renders immediately — no effect needed,
  // and a stale `true` can never re-arm orbit-gating behind the user's
  // back when the next model lands).
  const [rotateMode, setRotateMode] = useState(false);
  if (rotateMode && !hasModel) {
    setRotateMode(false);
  }
  const rotateActive = rotateMode && hasModel;

  return (
    <div
      ref={viewportRef}
      className="relative min-h-[70vh] flex-1 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900"
    >
      <ErrorBoundary onReset={() => setViewportKey((k) => k + 1)}>
        <ViewportMount key={viewportKey} />
      </ErrorBoundary>
      <UnstableBanner />
      <ContextLostOverlay />
      {!ready ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-neutral-900/80">
          <span className="flex items-center gap-2 text-xs text-neutral-300">
            <span
              aria-hidden="true"
              className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-500 border-t-transparent"
            />
            Loading engine…
          </span>
          {error !== null ? (
            <p role="alert" className="max-w-sm text-center text-[11px] text-red-400">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
      <ViewToolbar
        fullscreenTargetRef={viewportRef}
        rotateActive={rotateActive}
        onToggleRotate={() => {
          if (ready && hasModel) setRotateMode((active) => !active);
        }}
        rotateDisabled={!ready || !hasModel}
      />
      {rotateActive ? (
        <RotateController
          containerRef={viewportRef}
          onExit={() => setRotateMode(false)}
        />
      ) : null}
    </div>
  );
}

function Shell({ onEngineRetry }: { onEngineRetry: () => void }) {
  const { toasts, dismissToast } = useSimulationContext();

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <EngineBootPanel onRetry={onEngineRetry} />
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
        <h1 className="text-sm font-semibold tracking-wide">Wind Tunnel</h1>
      </header>
      <main className="flex min-h-0 flex-1 gap-4 p-4">
        <SetupRail />
        <ViewportPane />
        <TuneRail />
      </main>
      <footer className="h-16 shrink-0 border-t border-neutral-800 px-4 py-2">
        <StatsPanel />
      </footer>
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export default function Home() {
  // F022 §5: boot-retry generation — Retry remounts the provider (fresh
  // loader attempt) without a full page reload.
  const [engineAttempt, setEngineAttempt] = useState(0);

  return (
    <ModelProvider>
      <SimulationProvider key={engineAttempt}>
        <SimulationLoopHost />
        <Shell onEngineRetry={() => setEngineAttempt((n) => n + 1)} />
      </SimulationProvider>
    </ModelProvider>
  );
}
