"use client";

import type { ToastMessage } from "@/lib/sim/SimulationContext";

export interface ToastsProps {
  readonly toasts: readonly ToastMessage[];
  onDismiss(id: number): void;
}

/**
 * Error surface (F019 §5): simple top-right toast list for wasm load
 * failures, parse failures, and instability auto-recoveries. Auto-dismiss
 * (4 s) is owned by the provider; each toast also carries a close button.
 * Pure props-driven — no timers here.
 */
export function Toasts({ toasts, onDismiss }: ToastsProps) {
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 top-14 z-50 flex w-80 flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.tone === "error" ? "alert" : "status"}
          className={[
            "pointer-events-auto flex items-start justify-between gap-2 rounded-md border px-3 py-2 text-xs shadow-lg",
            toast.tone === "error"
              ? "border-red-800 bg-red-950 text-red-200"
              : "border-neutral-700 bg-neutral-900 text-neutral-200",
          ].join(" ")}
        >
          <span>{toast.text}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => {
              onDismiss(toast.id);
            }}
            className="shrink-0 rounded px-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
