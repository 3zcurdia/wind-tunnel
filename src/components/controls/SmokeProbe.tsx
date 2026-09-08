"use client";

import { useState } from "react";
import { runSmokeProbe } from "@/lib/sim/voxelBridge";

/** TEMPORARY probe button (F011) — exercises spawn/step/advect end-to-end. Deleted in F019. */
export function SmokeProbe() {
  const [label, setLabel] = useState("Run smoke probe");
  const [busy, setBusy] = useState(false);

  async function handleClick(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setLabel("Probing…");
    try {
      const result = await runSmokeProbe();
      setLabel(
        `Smoke: ${result.active} active · ū=${result.meanSpeed.toFixed(4)}`,
      );
    } catch {
      setLabel("Smoke probe failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={busy}
      className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-100 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
    </button>
  );
}
