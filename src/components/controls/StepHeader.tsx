export function StepHeader({
  step,
  label,
  active,
}: {
  readonly step: 1 | 2;
  readonly label: string;
  readonly active: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold ${
          active ? "bg-blue-600 text-white" : "bg-neutral-800 text-neutral-500"
        }`}
      >
        {step}
      </span>
      <span
        className={`text-xs font-semibold uppercase tracking-wider ${
          active ? "text-neutral-200" : "text-neutral-500"
        }`}
      >
        {label}
      </span>
    </div>
  );
}
