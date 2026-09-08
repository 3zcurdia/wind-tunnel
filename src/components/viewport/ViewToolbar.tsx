"use client";

import { useEffect, useState, type RefObject } from "react";
import { useSimulationContext } from "@/lib/sim/SimulationContext";
import { getSceneManager } from "./viewportBridge";
import type { CameraPreset } from "./SceneManager";

const PRESETS: readonly { readonly id: CameraPreset; readonly label: string }[] = [
  { id: "front", label: "Front" },
  { id: "top", label: "Top" },
  { id: "iso", label: "Iso" },
];

const BUTTON_CLASS =
  "rounded-md border border-neutral-700 bg-neutral-800/80 px-2.5 py-1 text-xs font-medium text-neutral-100 backdrop-blur-sm hover:bg-neutral-700";

export interface ViewToolbarProps {
  /** Viewport container used as the fullscreen target (F020 §2). */
  readonly fullscreenTargetRef: RefObject<HTMLDivElement | null>;
}

/**
 * Floating viewport toolbar (F020 §2): camera presets, screenshot, and a
 * container-level fullscreen toggle. All actions reach the SceneManager
 * through `viewportBridge` (a no-op until the lazy viewport registers).
 * The `CameraPreset` import is type-only so this component never pulls the
 * three.js chunk into the page bundle (`Viewport` loads it `ssr: false`).
 */
export function ViewToolbar({ fullscreenTargetRef }: ViewToolbarProps) {
  const { pushToast } = useSimulationContext();
  const [isFullscreen, setIsFullscreen] = useState(false);

  // ESC-exit is browser-native; this just keeps the button label in sync.
  useEffect(() => {
    function onFullscreenChange(): void {
      setIsFullscreen(document.fullscreenElement !== null);
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, []);

  function applyPreset(preset: CameraPreset): void {
    getSceneManager()?.setCameraPreset(preset);
  }

  function captureScreenshot(): void {
    const manager = getSceneManager();
    if (!manager) return;
    try {
      const dataUrl = manager.screenshot();
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = "wind-tunnel.png";
      link.click();
    } catch (error) {
      // SceneManager throws ScreenshotError on a lost GL context; matched by
      // name so this file never value-imports from the three.js chunk.
      if (error instanceof Error && error.name === "ScreenshotError") {
        pushToast("Screenshot failed — WebGL context was lost.", "error");
        return;
      }
      throw error;
    }
  }

  function toggleFullscreen(): void {
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen();
      return;
    }
    const target = fullscreenTargetRef.current;
    if (target) {
      void target.requestFullscreen();
    }
  }

  return (
    <div className="absolute right-3 top-3 z-10 flex gap-1.5">
      {PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          onClick={() => {
            applyPreset(preset.id);
          }}
          className={BUTTON_CLASS}
        >
          {preset.label}
        </button>
      ))}
      <button
        type="button"
        onClick={captureScreenshot}
        aria-label="Save screenshot (PNG)"
        title="Save screenshot (PNG)"
        className={BUTTON_CLASS}
      >
        📷
      </button>
      <button
        type="button"
        onClick={toggleFullscreen}
        aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        className={BUTTON_CLASS}
      >
        ⛶
      </button>
    </div>
  );
}
