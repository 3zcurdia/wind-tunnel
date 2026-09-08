"use client";

interface PressureLegendProps {
  readonly pMinPa: number;
  readonly pMaxPa: number;
  readonly qRefPa: number;
}

/** Format Pascals as kPa with 2 decimals (spec §2); non-finite → em dash. */
function formatKPa(pa: number): string {
  if (!Number.isFinite(pa)) return "—";
  return `${(pa / 1000).toFixed(2)}`;
}

/**
 * Surface-pressure legend (F015 §2): vertical gradient bar (blue = low at
 * the bottom, red = high at the top) with p_max / ambient / p_min labels and
 * a q_ref caption. Pure props-driven — no wasm imports (F019's stats feed
 * replaces the temporary bridge driver without touching this component).
 */
export function PressureLegend({
  pMinPa,
  pMaxPa,
  qRefPa,
}: PressureLegendProps) {
  return (
    <div
      role="img"
      aria-label={`Surface pressure legend: max ${formatKPa(pMaxPa)} kilopascals, min ${formatKPa(pMinPa)} kilopascals, reference ${formatKPa(qRefPa)} kilopascals`}
    >
      <div className="flex gap-2">
        <div
          aria-hidden="true"
          className="h-40 w-4 shrink-0 rounded-sm"
          style={{
            background:
              "linear-gradient(to top, #2563eb, #f3f4f6, #dc2626)",
          }}
        />
        <div className="flex h-40 flex-col justify-between text-[11px] text-neutral-400">
          <span>{formatKPa(pMaxPa)} kPa</span>
          <span>ambient</span>
          <span>{formatKPa(pMinPa)} kPa</span>
        </div>
      </div>
      <p className="mt-1 text-[11px] text-neutral-500">
        q_ref ≈ {formatKPa(qRefPa)} kPa
      </p>
    </div>
  );
}
