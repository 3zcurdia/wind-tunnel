"use client";

import { useEffect, useRef } from "react";
import { useModel } from "@/lib/sim/ModelContext";
import { useSimulationContext } from "@/lib/sim/SimulationContext";

/**
 * F028 — Live first paint: once the engine reports ready and no model has
 * been chosen yet, auto-load the Teardrop sample so a first-time visitor
 * sees flow developing around a body within seconds.
 *
 * Guarded effect — fires at most once per mount, only after `ready`, and
 * never overrides an existing model choice (user intent always wins).
 */
export function AutoSampleBoot() {
  const { ready } = useSimulationContext();
  const { file, sample, loadSample } = useModel();
  const firedRef = useRef(false);
  useEffect(() => {
    if (!ready || firedRef.current) return;
    if (file !== null || sample !== null) {
      // User beat us to it (fast click or preserved state) — never override.
      firedRef.current = true;
      return;
    }
    firedRef.current = true;
    loadSample("teardrop");
  }, [ready, file, sample, loadSample]);
  return null;
}
