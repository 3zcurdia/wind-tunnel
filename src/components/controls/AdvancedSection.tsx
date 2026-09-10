"use client";

import { useState, type ReactNode } from "react";
import {
  viscosityPasToCoef,
  type FlowConditions,
} from "@/lib/sim/conditions";

/**
 * Collapsed disclosure for the expert controls (F026 §5).
 *
 * The body is **always mounted** (CSS `hidden`, never conditional render), so
 * slider state, derived readouts, and future sublabels keep updating while
 * collapsed and toggling never re-runs the simulation. While closed, a live
 * summary line repeats the current operating point; when the last committed
 * point needed the τ clamp it appends an amber "stability assist on" marker
 * so that warning is never fully hidden.
 *
 * `conditions`/`conditionsUnstable` extend the spec's displayed signature
 * (which only lists `children`/`defaultOpen`): the spec's prose asks for
 * `conditions` to be passed for the summary, and §6 needs the unstable flag
 * for the amber marker.
 */
export function AdvancedSection({
  children,
  defaultOpen = false,
  conditions,
  conditionsUnstable = false,
}: {
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
  readonly conditions: FlowConditions;
  readonly conditionsUnstable?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const summary = `${conditions.uMps.toFixed(1)} m/s · ${conditions.pressureKpa.toFixed(1)} kPa · ${viscosityPasToCoef(conditions.viscosityPas).toFixed(2)} ×10⁻⁵ Pa·s`;

  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
        className="flex w-full items-center justify-between rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800"
      >
        <span>Advanced controls</span>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {!open ? (
        <p className="mt-1 text-[11px] text-neutral-500">
          {summary}
          {conditionsUnstable ? (
            <>
              {" · "}
              <span className="inline-flex items-center gap-1 text-amber-400">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-amber-400"
                />
                stability assist on
              </span>
            </>
          ) : null}
        </p>
      ) : null}
      <div className={open ? "mt-3 space-y-5" : "hidden"}>{children}</div>
    </section>
  );
}
