"use client";

import { useEffect, useRef } from "react";
import type { SceneManager } from "./SceneManager";

export default function Viewport() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const managerRef = useRef<SceneManager | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      const { SceneManager: SceneManagerCtor } = await import("./SceneManager");
      if (disposed) return;
      const manager = new SceneManagerCtor(canvas);
      managerRef.current = manager;
      manager.start();
      cleanup = () => {
        manager.stop();
        manager.dispose();
        if (managerRef.current === manager) managerRef.current = null;
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  return <canvas ref={canvasRef} className="block h-full w-full" />;
}
