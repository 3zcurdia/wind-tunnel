"use client";

import dynamic from "next/dynamic";

const Viewport = dynamic(() => import("./Viewport"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-xs text-neutral-500">
      Loading 3D viewport…
    </div>
  ),
});

export default function ViewportMount() {
  return (
    <div className="h-full w-full overflow-hidden">
      <Viewport />
    </div>
  );
}
