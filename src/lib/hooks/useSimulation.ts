"use client";

import { useEffect, useRef } from "react";
import { BufferAttribute, BufferGeometry } from "three";
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
} from "@/lib/sim/SimEngine";
import { QUALITY_PRESETS } from "@/lib/sim/quality";
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
    ready,
    quality,
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
  // Live SceneManager (set by the loop effect; read by the quality effect).
  const managerRef = useRef<SceneManager | null>(null);

  // ── frame loop + viz lifecycle (mount once) ───────────────────────────
  useEffect(() => {
    // The engine boots behind the context's `ready` flag (first-visit probe
    // + final re-init included) — constructing viz earlier would seat it on
    // the provisional Low grid. Re-runs once when `ready` flips true.
    if (!ready) return;
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
      managerRef.current = live;
      // Seat the rendered domain on the engine's live grid before building
      // viz (F021 — boot may have probed into Low/Medium, not High).
      const bootDims = engine.getDims();
      live.setDomainDims(bootDims);
      const bootQuality =
        QUALITY_PRESETS[engine.getQuality()] ?? QUALITY_PRESETS.medium;
      particles = new ParticleSystem(
        live.getLayer("particles"),
        PARTICLE_CAPACITY,
        bootDims,
      );
      overlay = new HeatmapOverlay();
      tracers = new SmokeTracers(live.getLayer("smoke"), {
        tracerCount: bootQuality.smokeTracers,
        historyLen: settings.smokeHistoryLen,
        seedLine: { ...settings.smokeRake },
        domainDims: bootDims,
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
          // F022: the stability flag freezes viz on diverged frames (the
          // paused early-return below already skips viz while paused; the
          // flag is defense-in-depth for the detecting frame itself).
          const views = engine.getParticleViews();
          vizParticles.update(
            views.positions,
            views.speeds,
            views.active,
            "speed",
            engine.getSpeedNorm(),
            result.stable,
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
              vizOverlay.attach(geometry, engine.getDims());
              live.setModelVertexColors(true);
            }
            const pressure =
              engine.getSolidCount() > 0
                ? engine.getPressureView()
                : EMPTY_PRESSURE;
            vizOverlay.update(pressure, engine.getAnchors(), result.stable);
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
          vizTracers.update(
            SMOKE_DT_LATTICE,
            (points, out) => {
              engine.sampleVelocity(points, out);
            },
            result.stable,
          );
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
      managerRef.current = null;
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
  }, [getEngine, notifyRecovery, ready]);

  // ── quality switch (F021 §3 display half) ──────────────────────────────
  // The engine re-init (new grid + rescaled re-voxelization) already ran in
  // `context.setQuality`; this seats the display on it: rebuild the domain
  // box, rebuild the smoke rake at the tier's tracer count, and re-show the
  // model from the engine's rescaled soup (same vertex order, so the
  // heatmap index map rebuilds itself in the loop via the geometry swap).
  // Skipped before the loop mounts (construction already uses live dims).
  useEffect(() => {
    const manager = managerRef.current;
    const viz = vizRef.current;
    if (!manager || !viz.particles || !viz.overlay || !viz.tracers) return;
    const engine = getEngine();
    const dims = engine.getDims();
    manager.setDomainDims(dims);
    const spec = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.medium;
    const smokeLayer = manager.getLayer("smoke");
    viz.tracers.dispose();
    const tracers = new SmokeTracers(smokeLayer, {
      tracerCount: spec.smokeTracers,
      historyLen: settingsRef.current.smokeHistoryLen,
      seedLine: { ...settingsRef.current.smokeRake },
      domainDims: dims,
    });
    smokeLayer.visible = settingsRef.current.smokeEnabled;
    viz.tracers = tracers;
    vizRef.current = { ...viz, tracers };
    const soup = engine.getMeshSoup();
    if (soup) {
      const rebuilt = new BufferGeometry();
      rebuilt.setAttribute("position", new BufferAttribute(soup.soup, 3));
      manager.showModel(rebuilt);
      rebuilt.dispose();
    } else {
      if (viz.overlay.attachedGeometry) {
        viz.overlay.clear();
        manager.setModelVertexColors(false);
      }
      manager.clearModel();
    }
  }, [quality, getEngine]);

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
        const mapped = normalizeToDomain(result.geometry, engine.getDims());
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
