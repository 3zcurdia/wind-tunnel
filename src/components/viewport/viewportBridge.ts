import type { SceneManager } from "./SceneManager";

/**
 * Module-level accessor for the live SceneManager instance (F005).
 * Viewport registers on mount and unregisters on unmount; the model
 * pipeline reads it (or null before mount). No React state involved.
 */
let live: SceneManager | null = null;

export function setSceneManager(manager: SceneManager | null): void {
  live = manager;
}

export function getSceneManager(): SceneManager | null {
  return live;
}
