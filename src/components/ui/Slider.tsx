"use client";

import { useId } from "react";

export interface SliderProps {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly unit?: string;
  readonly format?: (value: number) => string;
  /** Grays the control (F018: sliders stay disabled until a model is loaded). */
  readonly disabled?: boolean;
  readonly id?: string;
}

/**
 * Shared slider atom (F018): label left, unit readout right-aligned,
 * full-width native range input below. Uncontrolled styling only — the parent
 * owns the value (controlled via `value`/`onChange`).
 *
 * `disabled`/`id` extend the spec's contract props additively: disabling is
 * required by F018 §1 ("sliders disabled until a model is loaded") but has no
 * expression in the listed props (see DECISIONS.md §F018.3).
 */
export function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  unit,
  format,
  disabled = false,
  id,
}: SliderProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const text = format !== undefined ? format(value) : String(value);

  function handleChange(event: React.ChangeEvent<HTMLInputElement>): void {
    onChange(Number(event.target.value));
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label
          htmlFor={inputId}
          className="text-xs font-medium text-neutral-300"
        >
          {label}
        </label>
        <span className="text-xs tabular-nums text-neutral-400">
          {text}
          {unit !== undefined ? ` ${unit}` : null}
        </span>
      </div>
      <input
        id={inputId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={handleChange}
        disabled={disabled}
        className="w-full accent-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
      />
    </div>
  );
}
