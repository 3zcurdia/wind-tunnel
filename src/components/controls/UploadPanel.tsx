"use client";

import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { Panel } from "@/components/ui/Panel";
import { useModel } from "@/lib/sim/ModelContext";

function formatSize(sizeBytes: number): string {
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function UploadPanel() {
  const { file, status, error, meta, reading, setFile, clear } = useModel();
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function openPicker() {
    if (!reading) inputRef.current?.click();
  }

  function handleInputChange(e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (picked && !reading) setFile(picked);
  }

  function handleDragOver(e: DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    if (!reading) setDragging(true);
  }

  function handleDragLeave(e: DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    setDragging(false);
  }

  function handleDrop(e: DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    setDragging(false);
    if (reading) return;
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) setFile(dropped);
  }

  const showError = status === "invalid" && error !== undefined;
  const showSuccess = status === "valid" && file !== null;

  return (
    <Panel title="Model">
      {showError ? (
        <p role="alert" className="mb-2 text-xs text-red-500">
          {error}
        </p>
      ) : null}
      {showSuccess && file !== null ? (
        <div className="mb-2 rounded-md border border-neutral-800 bg-neutral-950 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-xs font-medium text-neutral-100">
              {file.name}
            </p>
            <span className="shrink-0 rounded-full border border-neutral-700 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-300">
              {file.format}
            </span>
          </div>
          <p className="mt-1 text-xs text-neutral-400">
            {formatSize(file.sizeBytes)}
          </p>
          <p className="mt-1 text-xs text-neutral-400">
            Triangles: {meta?.triangles ?? "—"} · Vertices{" "}
            {meta?.vertices ?? "—"}
          </p>
          <button
            type="button"
            onClick={clear}
            className="mt-2 rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
          >
            Remove
          </button>
        </div>
      ) : null}
      <button
        type="button"
        aria-label="Upload 3D model file"
        onClick={openPicker}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        disabled={reading}
        className={[
          "flex min-h-32 w-full flex-col items-center justify-center gap-1 rounded-md border-dashed p-4 text-center transition-colors",
          "border border-dashed",
          dragging
            ? "border-blue-500/60 bg-blue-500/10"
            : "border-neutral-700 bg-transparent",
          reading ? "cursor-wait opacity-70" : "cursor-pointer",
        ].join(" ")}
      >
        {reading ? (
          <span className="flex items-center gap-2 text-xs text-neutral-300">
            <span
              aria-hidden="true"
              className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-500 border-t-transparent"
            />
            Reading file…
          </span>
        ) : (
          <>
            <span className="text-xs text-neutral-200">
              Drop an OBJ or PLY file here
            </span>
            <span className="text-xs text-neutral-500">
              or click to browse
            </span>
          </>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".obj,.ply"
        className="hidden"
        onChange={handleInputChange}
        disabled={reading}
        tabIndex={-1}
      />
    </Panel>
  );
}
