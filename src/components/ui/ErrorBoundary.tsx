"use client";

import { Component, type ReactNode } from "react";
import { toAppError } from "@/lib/sim/errors";

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** Called after the error state clears (remount live trees here). */
  readonly onReset?: () => void;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

/**
 * Viewport resilience boundary (F022 §6).
 *
 * Catches render-time failures in the 3D subtree and renders the error kind
 * plus a Reset button (unmount/remount the viewport) instead of a white
 * screen. Technical detail goes to `console.error`; the UI shows only the
 * short `AppError` message.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    // Technical detail for debugging; the UI below never shows stacks.
    console.error("[viewport]", error);
  }

  private readonly handleReset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const appError = toAppError(error);
    return (
      <div
        role="alert"
        className="flex h-full w-full flex-col items-center justify-center gap-2 bg-neutral-900 p-6 text-center"
      >
        <p className="text-xs font-semibold uppercase tracking-wider text-red-400">
          {appError.kind}
        </p>
        <p className="max-w-sm text-xs text-neutral-300">
          {appError.userMessage}
        </p>
        <button
          type="button"
          onClick={this.handleReset}
          className="mt-1 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-700"
        >
          Reset viewport
        </button>
      </div>
    );
  }
}
