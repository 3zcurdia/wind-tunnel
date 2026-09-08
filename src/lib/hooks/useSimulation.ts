"use client";

import { useEffect, useRef } from "react";
import type { SceneManager } from "@/components/viewport/SceneManager";
import { getSceneManager } from "@/components/viewport/viewportBridge";
import { parseModel, type ParsedModel } from "@/lib/mesh/loadModel";
import {
  normalizeToDomain,
  type NormalizedModel,
} from "@/lib/mesh/normalize";
import { useModel } from "@/lib/sim/ModelContext";
import {
  PARTICLE_CAPACITY,
  SIM_TICK_BUDGET_MS,
  SMOKE_TRACER_COUNT,
} from "@/lib/sim/SimEngine";
import { useSimulationContext } from "@/lib/sim/SimulationContext";
import { HeatmapOverlay } from "@/lib/viz/HeatmapOverlay";
import { ParticleSystem } from "@/lib/viz/ParticleSystem";
import { SmokeTracers } from "@/lib/viz/SmokeTracers";

/**
 * Lattice time step per frame for smoke integration: 1.0 lattice time unit
 * per solver step — NOT `LatticeParams.dt` (physical seconds, ~4e-5 s),
 * which would freeze the ribbons if used for lattice-space `p += v·dt`
 * integration (see DECISIONS.md F016.1). Matches the engine's particle
 * `advect_particles(1.0)` cadence.
 */
const SMOKE_DT_LATTICE = 1.0;

/** Shared empty pressure view (no mesh yet) — never written to. */
const EMPTY_PRESSURE = new Float32Array(0);

interface VizInstances {
  particles: ParticleSystem | null;
  overlay: HeatmapOverlay | null;
  tracers: SmokeTracers | null;
}

const NO_VIZ: VizInstances = {
  particles: null,
  overlay: null,
  tracers: null,
};

/**
 * Wait for the viewport's SceneManager (registered asynchronously by the
 * client-only `Viewport`). Polls on a 100 ms interval like the pre-F019
 * drivers did;
 * rejects on unmount-cancel so async setups never touch a dead tree.
 */
function waitForSceneManager(signal: { cancelled: boolean }): Promise<SceneManager> {
  const live = getSceneManager();
  if (live) return Promise.resolve(live);
  return new Promise<SceneManager>((resolve, reject) => {
    const timer = window.setInterval(() => {
      if (signal.cancelled) {
        window.clearInterval(timer);
        reject(new Error("useSimulation unmounted while waiting for viewport"));
        return;
      }
      const manager = getSceneManager();
      if (manager) {
        window.clearInterval(timer);
        resolve(manager);
      }
    }, 100);
  });
}

/**
 * rAF orchestration (F019, ARCHITECTURE.md §6). Mounted once in `page.tsx`
 * inside `<SimulationProvider>` (and `<ModelProvider>`).
 *
 * - Frame loop: awaits the engine, waits for the SceneManager, builds the
 *   three viz instances once, then subscribes a single `onFrame` callback:
 *   `engine.tick(12)` → particles → heatmap (every 3rd frame inside the
 *   overlay) → smoke. Rendering stays inside SceneManager's loop.
 * - Model pipeline (the F005 file→scene pipeline, absorbed here): parse →
 *   normalize → `engine.setMesh` → `showModel` → `resetFlow` → `play()`.
 * - Cleanup on unmount: unsubscribe + dispose all viz instances; the wasm
 *   instance is kept (`engine.dispose` only resets the fps baseline —
 *   reload is cheap but a rebuild would lose the developed flow, so a
 *   remount resumes instead).
 */
export function useSimulation(): void {
  const sim = useSimulationContext();
  const { file, setMeta, setParseError } = useModel();
  const {
    getEngine,
    notifyRecovery,
    pushToast,
    syncRunning,
    smokeEnabled,
    heatmapEnabled,
    smokeRake,
    smokeHistoryLen,
  } = sim;

  // Latest loop-relevant settings for the subscribed callback + async
  // setups. A ref mirror (synced every render) keeps the single `onFrame`
  // subscription stable across toggles — no resubscribe churn.
  const settingsRef = useRef({
    smokeEnabled,
    heatmapEnabled,
    smokeRake,
    smokeHistoryLen,
  });
  useEffect(() => {
    settingsRef.current = {
      smokeEnabled,
      heatmapEnabled,
      smokeRake,
      smokeHistoryLen,
    };
  });

  // Live viz instances (owned by the loop effect below; read by the
  // rake/history sync effects).
  const vizRef = useRef<VizInstances>({ ...NO_VIZ });

  // ── frame loop + viz lifecycle (mount once) ───────────────────────────
  useEffect(() => {
    const signal = { cancelled: false };
    const engine = getEngine();
    let manager: SceneManager | null = null;
    let unsubscribe: (() => void) | null = null;
    let particles: ParticleSystem | null = null;
    let overlay: HeatmapOverlay | null = null;
    let tracers: SmokeTracers | null = null;
    // Fresh emission on smoke re-enable (the deleted driver's toggle rule).
    let wasSmokeEnabled = settingsRef.current.smokeEnabled;

    void (async () => {
      try {
        await engine.whenReady();
      } catch {
        // Init failure surfaces via context error + toast; the loop idles.
        return;
      }
      if (signal.cancelled) return;
      try {
        manager = await waitForSceneManager(signal);
      } catch {
        return;
      }
      if (signal.cancelled || !manager) return;

      const settings = settingsRef.current;
      const live = manager;
      particles = new ParticleSystem(
        live.getLayer("particles"),
        PARTICLE_CAPACITY,
      );
      overlay = new HeatmapOverlay();
      tracers = new SmokeTracers(live.getLayer("smoke"), {
        tracerCount: SMOKE_TRACER_COUNT,
        historyLen: settings.smokeHistoryLen,
        seedLine: { ...settings.smokeRake },
      });
      live.getLayer("smoke").visible = settings.smokeEnabled;
      vizRef.current = { particles, overlay, tracers };

      unsubscribe = live.onFrame(() => {
        const flags = settingsRef.current;
        const vizParticles = vizRef.current.particles;
        const vizOverlay = vizRef.current.overlay;
        const vizTracers = vizRef.current.tracers;
        if (!vizParticles || !vizOverlay || !vizTracers) return;
        try {
          const result = engine.tick(SIM_TICK_BUDGET_MS);
          if (result.recovered) {
            notifyRecovery();
          }
          if (!engine.isRunning) {
            // Paused: stepping halts and buffers stay on screen untouched.
            return;
          }
          // Particles: mirror the active pool prefix into GPU attributes.
          const views = engine.getParticleViews();
          vizParticles.update(
            views.positions,
            views.speeds,
            views.active,
            "speed",
            engine.getSpeedNorm(),
          );
          // Heatmap: reconcile with the live model, then paint (the overlay
          // throttles color fills to every 3rd call itself).
          const geometry = flags.heatmapEnabled
            ? live.getModelGeometry()
            : null;
          if (!geometry) {
            if (vizOverlay.attachedGeometry) {
              vizOverlay.clear();
              live.setModelVertexColors(false);
            }
          } else {
            if (vizOverlay.attachedGeometry !== geometry) {
              vizOverlay.attach(geometry);
              live.setModelVertexColors(true);
            }
            const pressure =
              engine.getSolidCount() > 0
                ? engine.getPressureView()
                : EMPTY_PRESSURE;
            vizOverlay.update(pressure, engine.getAnchors());
          }
          // Smoke: read-only sampling after this frame's `step` (never
          // steps itself — the tick above owns stepping).
          const smokeLayer = live.getLayer("smoke");
          if (!flags.smokeEnabled) {
            smokeLayer.visible = false;
            wasSmokeEnabled = false;
            return;
          }
          smokeLayer.visible = true;
          if (!wasSmokeEnabled) {
            vizTracers.setRake(
              flags.smokeRake.yCenter,
              flags.smokeRake.zCenter,
              flags.smokeRake.halfWidth,
            );
            wasSmokeEnabled = true;
          }
          vizTracers.update(SMOKE_DT_LATTICE, (points, out) => {
            engine.sampleVelocity(points, out);
          });
        } catch {
          // A poisoned instance must not kill the render loop: skip the
          // frame on last buffers. (Unreachable by the Rust no-panic
          // contract; the readout poll independently reports null.)
          return;
        }
      });
    })();

    return () => {
      signal.cancelled = true;
      unsubscribe?.();
      unsubscribe = null;
      tracers?.dispose();
      if (overlay?.attachedGeometry) {
        overlay.clear();
        manager?.setModelVertexColors(false);
      }
      particles?.dispose();
      vizRef.current = { ...NO_VIZ };
      engine.dispose();
      manager = null;
      particles = null;
      overlay = null;
      tracers = null;
    };
  }, [getEngine, notifyRecovery]);

  // ── smoke rake/history sync (param change re-seeds live, per spec) ─────
  // Construction already uses the latest settings, so a pre-mount change is
  // never lost when the instance is still null; `setHistoryLen` no-ops when
  // the clamped value is unchanged, while `setRake` always reseeds — hence
  // the equality guard below (one reseed per user change, not per render).
  useEffect(() => {
    const tracers = vizRef.current.tracers;
    if (!tracers) return;
    const current = tracers.rake;
    if (
      current.yCenter === smokeRake.yCenter &&
      current.zCenter === smokeRake.zCenter &&
      current.halfWidth === smokeRake.halfWidth
    ) {
      return;
    }
    tracers.setRake(smokeRake.yCenter, smokeRake.zCenter, smokeRake.halfWidth);
  }, [smokeRake]);

  useEffect(() => {
    vizRef.current.tracers?.setHistoryLen(smokeHistoryLen);
  }, [smokeHistoryLen]);

  // ── model pipeline (the F005 file→scene pipeline, absorbed here) ───────
  // parse → normalize → engine.setMesh → showModel → meta → resetFlow →
  // play(). Parse failures surface as the context error state + toast and
  // leave the previous 3D model and voxel mesh untouched. Stale files
  // (superseded uploads) are ignored via the cancel flag.
  useEffect(() => {
    const signal = { cancelled: false };
    const engine = getEngine();

    void (async () => {
      try {
        await engine.whenReady();
      } catch {
        return;
      }
      if (signal.cancelled) return;

      if (!file) {
        getSceneManager()?.clearModel();
        try {
          engine.clearMesh();
          engine.resetFlow();
        } catch {
          // Engine torn down mid-flight — the next mount re-inits.
        }
        return;
      }

      let manager: SceneManager | null = null;
      try {
        manager = await waitForSceneManager(signal);
      } catch {
        return;
      }
      if (signal.cancelled || !manager) return;

      let parsed: ParsedModel | null = null;
      let normalized: NormalizedModel | null = null;
      try {
        const result = await parseModel(file);
        if (signal.cancelled) {
          result.geometry.dispose();
          return;
        }
        parsed = result;
        const mapped = normalizeToDomain(result.geometry);
        if (signal.cancelled) {
          mapped.geometry.dispose();
          return;
        }
        normalized = mapped;
        // Voxelize before displaying: a voxelization failure keeps the
        // previous model on screen (the scene is only swapped on success).
        engine.setMesh(mapped.geometry);
        if (signal.cancelled) return;
        manager.showModel(mapped.geometry);
        if (signal.cancelled) return;
        setMeta({ triangles: result.triangles, vertices: result.vertices });
        engine.resetFlow();
        engine.play();
        syncRunning();
      } catch (err) {
        if (signal.cancelled) return;
        const message = err instanceof Error ? err.message : "Failed to parse model";
        setParseError(message);
        pushToast(`Failed to parse ${file.name}.`, "error");
      } finally {
        // `normalizeToDomain` clones its input, so both copies are owned
        // here and both are released (the scene and the engine hold their
        // own clones/copies by now).
        normalized?.geometry.dispose();
        parsed?.geometry.dispose();
      }
    })();

    return () => {
      signal.cancelled = true;
    };
  }, [file, getEngine, setMeta, setParseError, pushToast, syncRunning]);
}
