"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useModel, type ModelOrientation } from "@/lib/sim/ModelContext";
import { getSceneManager } from "./viewportBridge";

/**
 * Pointer-drag degrees per pixel (F024 §5 — normative 0.5).
 */
export const ROTATE_DEG_PER_PIXEL = 0.5;

/** Arrow-key / chip-button step in degrees (F024 §5; Shift = fine step). */
export const STEP_DEG = 5;
export const FINE_STEP_DEG = 1;

/**
 * Idle window before a key/button step commits (F024 §5). Long enough to
 * absorb a burst of taps into one re-voxelize + soft restart, short enough
 * that the flow answers while the user is still looking.
 */
export const STEP_COMMIT_DEBOUNCE_MS = 400;

export interface RotateControllerProps {
  /** Viewport container holding the WebGL canvas (toolbar clicks excluded). */
  readonly containerRef: RefObject<HTMLDivElement | null>;
  /** Exit rotate mode (toolbar toggle / ESC with no drag in flight). */
  readonly onExit: () => void;
}

function formatAngle(value: number): string {
  return `${Math.round(value)}°`;
}

interface DragState {
  readonly pointerId: number;
  lastX: number;
  lastY: number;
  current: ModelOrientation;
}

const STEP_BUTTON_CLASS =
  "rounded border border-neutral-600 px-1.5 py-0.5 text-[11px] leading-none text-neutral-200 hover:bg-neutral-700";

/**
 * Rotate-mode driver (F024 §5). Null-render except a bottom-center readout
 * chip. All gestures are **camera-relative**: horizontal input spins the
 * model about the camera's up axis, vertical input about the camera's right
 * axis — "left/right/up/down as seen from the current view" — mapped to
 * yaw/pitch/roll by `SceneManager.rotateOrientationInView` (three.js stays
 * behind the SceneManager boundary; this module must not import it — it is
 * statically imported by page.tsx). While mounted:
 *
 * - orbit-rotate is disabled on the live SceneManager (pan/zoom stay live),
 *   restored on unmount;
 * - `pointerdown` on the viewport canvas starts a captured drag (the canvas
 *   is found via the container's `querySelector("canvas")`, so toolbar
 *   clicks never start a drag); `pointermove` rotates in view space
 *   (Shift held → horizontal movement spins about the view axis instead)
 *   and previews via `previewModelOrientation(draft, committed)` — the
 *   *relative* form: the committed orientation is already baked into the
 *   display geometry, so an absolute preview would double-rotate and snap
 *   back on release (the F024 rev-2 flakiness fix). Preview only, no engine
 *   calls during drag;
 * - `pointerup` commits once via `setOrientation(final)`;
 * - arrow keys and the chip's step buttons rotate by 5° (Shift: 1°) per
 *   press in the same view-relative axes, preview immediately, and commit
 *   after a 400 ms idle debounce (a burst of taps = one restart);
 * - ESC mid-gesture cancels (preview reverts to the committed orientation,
 *   nothing commits); ESC otherwise exits rotate mode.
 */
export function RotateController({
  containerRef,
  onExit,
}: RotateControllerProps) {
  const { orientation, setOrientation, resetOrientation } = useModel();
  // Live draft for the readout chip (null when nothing is in flight).
  const [draft, setDraft] = useState<ModelOrientation | null>(null);
  const dragRef = useRef<DragState | null>(null);
  // Key/button steps waiting on the commit debounce.
  const pendingRef = useRef<ModelOrientation | null>(null);
  const commitTimerRef = useRef<number | null>(null);
  // Latest committed orientation for gesture starts / ESC-cancel reverts. A
  // ref mirror (synced every render) keeps the listeners fresh without
  // re-subscribing mid-drag.
  const committedRef = useRef(orientation);
  useEffect(() => {
    committedRef.current = orientation;
  });
  const onExitRef = useRef(onExit);
  useEffect(() => {
    onExitRef.current = onExit;
  });
  const setOrientationRef = useRef(setOrientation);
  useEffect(() => {
    setOrientationRef.current = setOrientation;
  });

  // Stable across renders (touches only refs + the stable setState): step
  // from the current in-flight value (pending steps, else committed),
  // preview relative to committed, and arm the debounced commit. Shared by
  // the arrow keys and the chip buttons.
  const stepInView = useCallback(
    (delta: {
      horizDeg?: number;
      vertDeg?: number;
      spinDeg?: number;
    }): void => {
      if (dragRef.current !== null) return; // drag owns the gesture
      const manager = getSceneManager();
      if (!manager) return;
      const base = pendingRef.current ?? committedRef.current;
      const next = manager.rotateOrientationInView(base, delta);
      pendingRef.current = next;
      setDraft(next);
      manager.previewModelOrientation(next, committedRef.current);
      if (commitTimerRef.current !== null) {
        window.clearTimeout(commitTimerRef.current);
      }
      commitTimerRef.current = window.setTimeout(() => {
        commitTimerRef.current = null;
        const final = pendingRef.current;
        pendingRef.current = null;
        setDraft(null);
        if (final) setOrientationRef.current(final);
      }, STEP_COMMIT_DEBOUNCE_MS);
    },
    [],
  );

  useEffect(() => {
    getSceneManager()?.setOrbitRotateEnabled(false);
    const canvas =
      containerRef.current?.querySelector("canvas") ?? null;

    function cancelPendingSteps(): void {
      if (commitTimerRef.current !== null) {
        window.clearTimeout(commitTimerRef.current);
        commitTimerRef.current = null;
      }
      pendingRef.current = null;
    }

    function onPointerDown(event: PointerEvent): void {
      if (dragRef.current !== null) return;
      // Left-drag only — pan (right/middle) and zoom stay with the camera.
      if (event.button !== 0) return;
      // Any un-committed key/button steps fold into the drag (the drag's
      // pointerup commits the whole gesture).
      const base = pendingRef.current ?? committedRef.current;
      cancelPendingSteps();
      dragRef.current = {
        pointerId: event.pointerId,
        lastX: event.clientX,
        lastY: event.clientY,
        current: { ...base },
      };
      setDraft({ ...base });
      // Capture so pointerup always lands here — releasing outside the
      // window used to strand the drag (part of the rev-2 flakiness fix).
      try {
        canvas?.setPointerCapture(event.pointerId);
      } catch {
        // Capture is best-effort; window listeners still track the drag.
      }
      event.preventDefault();
    }

    function onPointerMove(event: PointerEvent): void {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const manager = getSceneManager();
      if (!manager) return;
      const dx = event.clientX - drag.lastX;
      const dy = event.clientY - drag.lastY;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      drag.current = manager.rotateOrientationInView(
        drag.current,
        event.shiftKey
          ? {
              spinDeg: dx * ROTATE_DEG_PER_PIXEL,
              vertDeg: dy * ROTATE_DEG_PER_PIXEL,
            }
          : {
              horizDeg: dx * ROTATE_DEG_PER_PIXEL,
              vertDeg: dy * ROTATE_DEG_PER_PIXEL,
            },
      );
      setDraft({ ...drag.current });
      manager.previewModelOrientation(drag.current, committedRef.current);
    }

    function commitDrag(event: PointerEvent): void {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const final = { ...drag.current };
      dragRef.current = null;
      setDraft(null);
      // Single context write = single engine commit downstream.
      setOrientationRef.current(final);
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" || event.key === "Esc") {
        if (dragRef.current !== null || pendingRef.current !== null) {
          // Cancel the in-flight gesture: revert the preview, commit nothing.
          dragRef.current = null;
          cancelPendingSteps();
          setDraft(null);
          getSceneManager()?.previewModelOrientation(
            committedRef.current,
            committedRef.current,
          );
        } else {
          onExitRef.current();
        }
        return;
      }
      // Arrow steps — skip when a form control owns the keys (range sliders
      // use arrows natively).
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }
      const step = event.shiftKey ? FINE_STEP_DEG : STEP_DEG;
      switch (event.key) {
        case "ArrowLeft":
          stepInView({ horizDeg: -step });
          break;
        case "ArrowRight":
          stepInView({ horizDeg: step });
          break;
        case "ArrowUp":
          stepInView({ vertDeg: -step });
          break;
        case "ArrowDown":
          stepInView({ vertDeg: step });
          break;
        default:
          return;
      }
      event.preventDefault();
    }

    canvas?.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", commitDrag);
    window.addEventListener("pointercancel", commitDrag);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      canvas?.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", commitDrag);
      window.removeEventListener("pointercancel", commitDrag);
      window.removeEventListener("keydown", onKeyDown);
      // Exiting mid-drag without a commit: revert the preview so the mesh
      // keeps showing the committed orientation.
      if (dragRef.current !== null) {
        dragRef.current = null;
        getSceneManager()?.previewModelOrientation(
          committedRef.current,
          committedRef.current,
        );
      }
      // Debounced key/button steps flush on exit — the user made them on
      // purpose; dropping them silently would read as another flake.
      if (commitTimerRef.current !== null) {
        window.clearTimeout(commitTimerRef.current);
        commitTimerRef.current = null;
      }
      const pendingFinal = pendingRef.current;
      pendingRef.current = null;
      if (pendingFinal) setOrientationRef.current(pendingFinal);
      getSceneManager()?.setOrbitRotateEnabled(true);
    };
  }, [containerRef, stepInView]);

  const shown = draft ?? orientation;

  return (
    <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-md border border-neutral-700 bg-neutral-800/90 px-3 py-1.5 text-xs text-neutral-100 backdrop-blur-sm">
      <span aria-live="polite">
        Yaw {formatAngle(shown.yawDeg)} · Pitch {formatAngle(shown.pitchDeg)} ·
        Roll {formatAngle(shown.rollDeg)}
      </span>
      <span className="flex items-center gap-1" role="group" aria-label="Rotate in steps">
        <button
          type="button"
          title="Rotate left (←, Shift for 1°)"
          aria-label="Rotate left"
          className={STEP_BUTTON_CLASS}
          onClick={(e) =>
            stepInView({
              horizDeg: -(e.shiftKey ? FINE_STEP_DEG : STEP_DEG),
            })
          }
        >
          ◀
        </button>
        <button
          type="button"
          title="Rotate up (↑, Shift for 1°)"
          aria-label="Rotate up"
          className={STEP_BUTTON_CLASS}
          onClick={(e) =>
            stepInView({
              vertDeg: -(e.shiftKey ? FINE_STEP_DEG : STEP_DEG),
            })
          }
        >
          ▲
        </button>
        <button
          type="button"
          title="Rotate down (↓, Shift for 1°)"
          aria-label="Rotate down"
          className={STEP_BUTTON_CLASS}
          onClick={(e) =>
            stepInView({
              vertDeg: e.shiftKey ? FINE_STEP_DEG : STEP_DEG,
            })
          }
        >
          ▼
        </button>
        <button
          type="button"
          title="Rotate right (→, Shift for 1°)"
          aria-label="Rotate right"
          className={STEP_BUTTON_CLASS}
          onClick={(e) =>
            stepInView({
              horizDeg: e.shiftKey ? FINE_STEP_DEG : STEP_DEG,
            })
          }
        >
          ▶
        </button>
        <button
          type="button"
          title="Spin counter-clockwise (Shift for 1°)"
          aria-label="Spin counter-clockwise"
          className={STEP_BUTTON_CLASS}
          onClick={(e) =>
            stepInView({
              spinDeg: -(e.shiftKey ? FINE_STEP_DEG : STEP_DEG),
            })
          }
        >
          ⟲
        </button>
        <button
          type="button"
          title="Spin clockwise (Shift for 1°)"
          aria-label="Spin clockwise"
          className={STEP_BUTTON_CLASS}
          onClick={(e) =>
            stepInView({
              spinDeg: e.shiftKey ? FINE_STEP_DEG : STEP_DEG,
            })
          }
        >
          ⟳
        </button>
      </span>
      <button
        type="button"
        onClick={() => {
          // Drop any in-flight draft first — if the committed orientation is
          // already default, resetOrientation() no-ops and a live preview
          // would otherwise stick.
          if (commitTimerRef.current !== null) {
            window.clearTimeout(commitTimerRef.current);
            commitTimerRef.current = null;
          }
          pendingRef.current = null;
          dragRef.current = null;
          setDraft(null);
          getSceneManager()?.previewModelOrientation(
            committedRef.current,
            committedRef.current,
          );
          resetOrientation();
        }}
        className="rounded border border-neutral-600 px-2 py-0.5 text-[11px] text-neutral-200 hover:bg-neutral-700"
      >
        Reset
      </button>
    </div>
  );
}
