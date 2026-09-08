"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { FlowConditions } from "@/lib/sim/conditions";
import {
  hasStoredQuality,
  isQualityLevel,
  loadStoredQuality,
  probeQuality,
  QUALITY_PRESETS,
  storeQuality,
  type GridDims,
  type QualityLevel,
} from "@/lib/sim/quality";
import {
  SMOKE_HALF_WIDTH_MAX,
  SMOKE_HALF_WIDTH_MIN,
  SMOKE_HISTORY_DEFAULT,
  SMOKE_HISTORY_MAX,
  SMOKE_HISTORY_MIN,
  SMOKE_RAKE_DEFAULT,
  SMOKE_RAKE_Y_MIN,
  PARTICLE_COUNT_DEFAULT,
  getSimEngine,
  type SimEngine,
  type SmokeRakeState,
} from "@/lib/sim/SimEngine";
import { useModel } from "@/lib/sim/ModelContext";
import { DOMAIN, type SimReadout } from "@/lib/sim/types";

export type ToastTone = "info" | "error";

export interface ToastMessage {
  readonly id: number;
  readonly text: string;
  readonly tone: ToastTone;
}

/**
 * Run/pause/reset controls (same shape as F018's `ControlPanel`
 * `TransportApi` — structural typing keeps the panel unchanged; the type
 * lives here so `lib` never imports from `components`).
 */
export interface SimulationTransport {
  readonly running: boolean;
  toggleRun(): void;
  resetFlow(): void;
  resetAll(): void;
}

export interface SimulationContextValue {
  /** True once the wasm engine finished `init()` (gates the viewport). */
  readonly ready: boolean;
  /** Last backend failure, if any (cleared on the next success). */
  readonly error: string | null;
  /** Top-right toast list (auto-dismissed after 4 s by the provider). */
  readonly toasts: readonly ToastMessage[];
  pushToast(text: string, tone?: ToastTone): void;
  dismissToast(id: number): void;
  /** Live readout polled at 4 Hz (null until the first successful poll). */
  readonly readout: SimReadout | null;
  /** Controlled slider state (mirrors the last committed point). */
  readonly conditions: FlowConditions;
  /** Commit a new operating point (debounced 150 ms trailing). */
  setConditions(next: FlowConditions): void;
  /** True when the last committed point needed τ clamping (ARCH §6). */
  readonly conditionsUnstable: boolean;
  readonly transport: SimulationTransport;
  /**
   * Active quality tier (F021). Drives grid dims, the particle target, and
   * the smoke rake size; persisted to localStorage.
   */
  readonly quality: QualityLevel;
  /**
   * Switch tier (F021 §3): engine re-init (`init_sim` → re-voxelize →
   * `reset_flow` → `spawn_particles`) with no page reload. Shows the inline
   * confirm in the panel first — this call is the Apply path. Resolves when
   * the re-init commits; surfaces failures as the context error state.
   * No-op when the tier is already active.
   */
  setQuality(level: QualityLevel): Promise<void>;
  /**
   * True when the first-visit auto-probe picked Low for this device (F021
   * §4 — the provider toasts "Quality set to Low for this device" once;
   * repeat visits read the stored value and never re-toast).
   */
  readonly autoProbed: boolean;
  /** Particle target count (5k–100k slider echoes this). */
  readonly particleCount: number;
  setParticleCount(count: number): void;
  readonly smokeEnabled: boolean;
  setSmokeEnabled(on: boolean): void;
  readonly smokeRake: SmokeRakeState;
  setSmokeRake(
    yCenter: number,
    zCenter: number,
    halfWidth: number,
  ): SmokeRakeState;
  readonly smokeHistoryLen: number;
  setSmokeHistoryLen(n: number): number;
  readonly heatmapEnabled: boolean;
  setHeatmapEnabled(on: boolean): void;
  /**
   * Layer visibility state (F020 contract: lives here so F021 presets can
   * drive it later). SceneManager stays stateless about *why* — the panel
   * applies these via `getSceneManager()`; smoke/heatmap are applied by the
   * F019 frame loop instead.
   */
  readonly particlesVisible: boolean;
  setParticlesVisible(on: boolean): void;
  /** Voxel debug cloud (inert in v1 — no occupancy feed, DECISIONS §F020.2). */
  readonly voxelDebugVisible: boolean;
  setVoxelDebugVisible(on: boolean): void;
  /** Domain box + ground grid + inlet marker. */
  readonly domainBoxVisible: boolean;
  setDomainBoxVisible(on: boolean): void;
  /** Engine access for the frame loop (`useSimulation`, F019). Stable. */
  getEngine(): SimEngine;
  /**
   * Loop→state sync after an instability auto-recovery: pulls the halved
   * conditions + paused state from the engine and toasts. Stable.
   */
  notifyRecovery(): void;
  /**
   * Pull the engine's run/pause flag into React state (used after the model
   * pipeline's auto-`play()`). Stable.
   */
  syncRunning(): void;
}

/** Trailing debounce for wasm condition commits (≤ ~7 calls/s). */
const CONDITIONS_DEBOUNCE_MS = 150;

/** Toast auto-dismiss delay (F019 error-surface contract). */
const TOAST_DISMISS_MS = 4000;

/** Cap on simultaneous toasts (oldest beyond the cap is dropped). */
const TOAST_MAX = 5;

function clampSmokeRake(
  yCenter: number,
  zCenter: number,
  halfWidth: number,
  dims?: GridDims,
): SmokeRakeState {
  const ny = dims?.ny ?? DOMAIN.ny;
  const nz = dims?.nz ?? DOMAIN.nz;
  const yMax = ny - SMOKE_RAKE_Y_MIN;
  const y = Number.isFinite(yCenter)
    ? Math.min(yMax, Math.max(SMOKE_RAKE_Y_MIN, yCenter))
    : ny / 2;
  const z = Number.isFinite(zCenter)
    ? Math.min(nz - 1, Math.max(1, zCenter))
    : nz / 2;
  const hw = Number.isFinite(halfWidth)
    ? Math.min(
        SMOKE_HALF_WIDTH_MAX,
        Math.max(SMOKE_HALF_WIDTH_MIN, halfWidth),
      )
    : SMOKE_RAKE_DEFAULT.halfWidth;
  return { yCenter: y, zCenter: z, halfWidth: hw };
}

function clampHistoryLen(n: number): number {
  if (!Number.isFinite(n)) return SMOKE_HISTORY_DEFAULT;
  return Math.min(
    SMOKE_HISTORY_MAX,
    Math.max(SMOKE_HISTORY_MIN, Math.floor(n)),
  );
}

const SimulationContext = createContext<SimulationContextValue | null>(null);

export function SimulationProvider({ children }: { children: ReactNode }) {
  // Process-lifetime singleton (same instance every render, no hook needed).
  const engine = getSimEngine();
  const { file, meta } = useModel();

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<readonly ToastMessage[]>([]);
  const [readout, setReadout] = useState<SimReadout | null>(null);
  const [conditions, setConditionsState] = useState<FlowConditions>(
    () => engine.getConditions(),
  );
  const [appliedUnstable, setAppliedUnstable] = useState(false);
  const [running, setRunning] = useState(engine.isRunning);
  const [particleCount, setParticleCountState] = useState(
    PARTICLE_COUNT_DEFAULT,
  );
  const [smokeEnabled, setSmokeEnabledState] = useState(true);
  const [smokeRake, setSmokeRakeState] =
    useState<SmokeRakeState>(SMOKE_RAKE_DEFAULT);
  const [smokeHistoryLen, setSmokeHistoryLenState] = useState(
    SMOKE_HISTORY_DEFAULT,
  );
  const [heatmapEnabled, setHeatmapEnabledState] = useState(true);
  const [quality, setQualityState] = useState<QualityLevel>(() =>
    loadStoredQuality(),
  );
  const [autoProbed, setAutoProbed] = useState(false);
  const [particlesVisible, setParticlesVisibleState] = useState(true);
  const [voxelDebugVisible, setVoxelDebugVisibleState] = useState(false);
  const [domainBoxVisible, setDomainBoxVisibleState] = useState(true);

  const pendingRef = useRef<FlowConditions | null>(null);
  const timerRef = useRef<number | null>(null);
  const toastIdRef = useRef(1);
  const toastTimersRef = useRef(new Set<number>());

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (text: string, tone: ToastTone = "info") => {
      const id = toastIdRef.current;
      toastIdRef.current += 1;
      setToasts((current) => [
        ...current.slice(Math.max(0, current.length - (TOAST_MAX - 1))),
        { id, text, tone },
      ]);
      const timer = window.setTimeout(() => {
        toastTimersRef.current.delete(timer);
        dismissToast(id);
      }, TOAST_DISMISS_MS);
      toastTimersRef.current.add(timer);
    },
    [dismissToast],
  );

  // Clear pending toast timers on unmount (provider lifetime is the app
  // lifetime in practice; this is StrictMode hygiene).
  useEffect(
    () => () => {
      for (const timer of toastTimersRef.current) {
        window.clearTimeout(timer);
      }
      toastTimersRef.current.clear();
    },
    [],
  );

  // ── engine lifecycle: init once on mount ──────────────────────────────
  // External-system synchronization (the sanctioned effect use): state sets
  // below run only after the async engine load resolves. First visit (no
  // stored tier) boots the Low grid, runs the hidden `step(8)` warm-up, and
  // probes Low vs Medium (F021 §1); repeat visits boot the stored tier
  // directly and never re-toast.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (hasStoredQuality()) {
          const stored = loadStoredQuality();
          await engine.init({ quality: stored });
          if (cancelled) return;
          setQualityState(stored);
          setParticleCountState(QUALITY_PRESETS[stored].particles);
        } else {
          await engine.init({ quality: "low" });
          if (cancelled) return;
          let picked: QualityLevel = "medium";
          try {
            picked = probeQuality(engine.warmupStepMs());
          } catch {
            picked = "medium";
          }
          if (picked !== "low") {
            engine.applyQuality(picked);
          }
          storeQuality(picked);
          if (cancelled) return;
          setQualityState(picked);
          setParticleCountState(QUALITY_PRESETS[picked].particles);
          if (picked === "low") {
            setAutoProbed(true);
            pushToast("Quality set to Low for this device.", "info");
          }
        }
        if (cancelled) return;
        setAppliedUnstable(engine.getApplied().unstable);
        setConditionsState(engine.getConditions());
        setParticleCountState(engine.getParticleTarget());
        setSmokeRakeState((prev) =>
          clampSmokeRake(
            prev.yCenter,
            prev.zCenter,
            prev.halfWidth,
            engine.getDims(),
          ),
        );
        setRunning(engine.isRunning);
        setError(null);
        setReady(true);
      } catch {
        if (cancelled) return;
        setError("Simulation engine failed to load — run `npm run wasm:build`.");
        pushToast("Simulation engine failed to load.", "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, pushToast]);

  const commitConditions = useCallback(
    (next: FlowConditions) => {
      try {
        const applied = engine.setConditions(next);
        setAppliedUnstable(applied.unstable);
        setError(null);
      } catch {
        setError("Engine update failed — retry shortly.");
      }
    },
    [engine],
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
          commitConditions(pending);
        }
      }, CONDITIONS_DEBOUNCE_MS);
    },
    [commitConditions],
  );

  // Flush a pending drag value (committed, not dropped) on unmount.
  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending !== null) {
        try {
          engine.setConditions(pending);
        } catch {
          // Unmounting — the error state is gone with the tree.
        }
      }
    },
    [engine],
  );

  // ── readout poll (4 Hz once ready) ─────────────────────────────────────
  // Model identity comes from ModelContext (the engine is React-free and
  // reports both as null). A file counts as "loaded" only once the parse
  // pipeline recorded its counts — a failed parse keeps stale sim numbers
  // out of the bar (same rule the deleted bridge poll used).
  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => {
      const next = engine.getReadout();
      if (next === null) return;
      const modelName =
        file !== null && meta !== undefined ? file.name : null;
      const modelTriangles =
        file !== null && meta !== undefined
          ? (meta.triangles ?? null)
          : null;
      setReadout({ ...next, modelName, modelTriangles });
    }, 250);
    return () => {
      window.clearInterval(id);
    };
  }, [ready, engine, file, meta]);

  const toggleRun = useCallback(() => {
    try {
      if (engine.isRunning) {
        engine.pause();
      } else {
        engine.play();
      }
      setRunning(engine.isRunning);
      setError(null);
    } catch {
      setError("Engine update failed — retry shortly.");
    }
  }, [engine]);

  const resetFlow = useCallback(() => {
    try {
      engine.resetFlow();
      setError(null);
    } catch {
      setError("Engine reset failed — retry shortly.");
    }
  }, [engine]);

  const resetAll = useCallback(() => {
    // Drop any debounced drag value: Reset all wins over a stale commit.
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    try {
      const applied = engine.resetAll();
      setConditionsState(engine.getConditions());
      setAppliedUnstable(applied.unstable);
      setError(null);
    } catch {
      setError("Engine reset failed — retry shortly.");
    }
  }, [engine]);

  const setParticleCount = useCallback(
    (count: number) => {
      try {
        const actual = engine.setParticleCount(count);
        setParticleCountState(actual);
      } catch {
        setError("Count change failed — engine unavailable, retry shortly.");
      }
    },
    [engine],
  );

  const setQuality = useCallback(
    async (level: QualityLevel): Promise<void> => {
      if (!isQualityLevel(level)) return;
      if (level === engine.getQuality()) {
        setQualityState(level);
        return;
      }
      try {
        const spec = engine.applyQuality(level);
        storeQuality(level);
        setQualityState(level);
        setParticleCountState(spec.particles);
        setSmokeRakeState((prev) =>
          clampSmokeRake(
            prev.yCenter,
            prev.zCenter,
            prev.halfWidth,
            engine.getDims(),
          ),
        );
        setError(null);
      } catch {
        setError("Quality change failed — retry shortly.");
        pushToast("Quality change failed — engine unavailable.", "error");
      }
    },
    [engine, pushToast],
  );

  const setSmokeEnabled = useCallback((on: boolean) => {
    setSmokeEnabledState(on);
  }, []);

  const setSmokeRake = useCallback(
    (yCenter: number, zCenter: number, halfWidth: number): SmokeRakeState => {
      const next = clampSmokeRake(yCenter, zCenter, halfWidth);
      setSmokeRakeState(next);
      return next;
    },
    [],
  );

  const setSmokeHistoryLen = useCallback((n: number): number => {
    const next = clampHistoryLen(n);
    setSmokeHistoryLenState(next);
    return next;
  }, []);

  const setHeatmapEnabled = useCallback((on: boolean) => {
    setHeatmapEnabledState(on);
  }, []);

  const setParticlesVisible = useCallback((on: boolean) => {
    setParticlesVisibleState(on);
  }, []);

  const setVoxelDebugVisible = useCallback((on: boolean) => {
    setVoxelDebugVisibleState(on);
  }, []);

  const setDomainBoxVisible = useCallback((on: boolean) => {
    setDomainBoxVisibleState(on);
  }, []);

  const getEngine = useCallback((): SimEngine => engine, [engine]);

  const syncRunning = useCallback(() => {
    setRunning(engine.isRunning);
  }, [engine]);

  const notifyRecovery = useCallback(() => {
    // A debounced drag value from before the recovery would clobber the
    // halved wind speed — drop it (the user can re-drag afterwards).
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    const recovered = engine.getConditions();
    setConditionsState(recovered);
    setAppliedUnstable(engine.getApplied().unstable);
    setRunning(engine.isRunning);
    pushToast(
      `Flow diverged — wind reduced to ${recovered.uMps.toFixed(1)} m/s and simulation paused.`,
      "info",
    );
  }, [engine, pushToast]);

  const transport = useMemo<SimulationTransport>(
    () => ({ running, toggleRun, resetFlow, resetAll }),
    [running, toggleRun, resetFlow, resetAll],
  );

  const value = useMemo<SimulationContextValue>(
    () => ({
      ready,
      error,
      toasts,
      pushToast,
      dismissToast,
      readout,
      conditions,
      setConditions,
      conditionsUnstable: appliedUnstable,
      transport,
      particleCount,
      setParticleCount,
      quality,
      setQuality,
      autoProbed,
      smokeEnabled,
      setSmokeEnabled,
      smokeRake,
      setSmokeRake,
      smokeHistoryLen,
      setSmokeHistoryLen,
      heatmapEnabled,
      setHeatmapEnabled,
      particlesVisible,
      setParticlesVisible,
      voxelDebugVisible,
      setVoxelDebugVisible,
      domainBoxVisible,
      setDomainBoxVisible,
      getEngine,
      notifyRecovery,
      syncRunning,
    }),
    [
      ready,
      error,
      toasts,
      pushToast,
      dismissToast,
      readout,
      conditions,
      setConditions,
      appliedUnstable,
      transport,
      particleCount,
      setParticleCount,
      quality,
      setQuality,
      autoProbed,
      smokeEnabled,
      setSmokeEnabled,
      smokeRake,
      setSmokeRake,
      smokeHistoryLen,
      setSmokeHistoryLen,
      heatmapEnabled,
      setHeatmapEnabled,
      particlesVisible,
      setParticlesVisible,
      voxelDebugVisible,
      setVoxelDebugVisible,
      domainBoxVisible,
      setDomainBoxVisible,
      getEngine,
      notifyRecovery,
      syncRunning,
    ],
  );

  return (
    <SimulationContext.Provider value={value}>
      {children}
    </SimulationContext.Provider>
  );
}

export function useSimulationContext(): SimulationContextValue {
  const ctx = useContext(SimulationContext);
  if (ctx === null) {
    throw new Error(
      "useSimulationContext must be used inside <SimulationProvider>",
    );
  }
  return ctx;
}
