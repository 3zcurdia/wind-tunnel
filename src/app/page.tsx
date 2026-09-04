import { Panel } from "@/components/ui/Panel";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
        <h1 className="text-sm font-semibold tracking-wide">Wind Tunnel</h1>
        <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
          ※ demo placeholder
        </span>
      </header>
      <main className="flex flex-1 gap-4 p-4">
        <Panel title="Controls" className="w-80 shrink-0">
          <p className="text-xs text-neutral-500">
            Upload + tuning controls wire in F004 / F018.
          </p>
        </Panel>
        <Panel
          title="Viewport"
          className="flex min-h-[60vh] flex-1 items-center justify-center"
        >
          <p className="text-xs text-neutral-500">
            3D scene mounts here in F002.
          </p>
        </Panel>
      </main>
      <footer className="h-28 shrink-0 border-t border-neutral-800 p-4">
        <Panel title="Stats" className="h-full">
          <p className="text-xs text-neutral-500">
            Live stats wire in F017.
          </p>
        </Panel>
      </footer>
    </div>
  );
}
