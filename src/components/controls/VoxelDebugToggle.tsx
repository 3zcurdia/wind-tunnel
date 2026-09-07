"use client";

import { useState } from "react";
import { getSceneManager } from "@/components/viewport/viewportBridge";

/** TEMPORARY checkbox (F006) — drives the debug voxel cloud. F020 owns toggles. */
export function VoxelDebugToggle() {
  const [on, setOn] = useState(false);

  function handleChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const next = event.target.checked;
    setOn(next);
    getSceneManager()?.setVoxelDebugVisible(next);
  }

  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-300">
      <input
        type="checkbox"
        checked={on}
        onChange={handleChange}
        className="h-3.5 w-3.5 accent-red-500"
      />
      Voxel debug view
    </label>
  );
}
