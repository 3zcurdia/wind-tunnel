import type { ReactNode } from "react";

type PanelProps = {
  title?: string;
  className?: string;
  children: ReactNode;
};

export function Panel({ title, className, children }: PanelProps) {
  const merged = ["rounded-lg border border-neutral-800 bg-neutral-900 p-4", className]
    .filter(Boolean)
    .join(" ");
  return (
    <section className={merged}>
      {title !== undefined ? (
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-400">
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  );
}
