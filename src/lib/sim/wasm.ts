/**
 * WASM loader singleton (F003).
 *
 * Owns instantiation of the generated wasm-bindgen module (`src/wasm/`,
 * produced by `npm run wasm:build` — gitignored, so a fresh clone must run
 * that script first). Until `SimEngine` exists (F019), this module is the
 * single owner of the raw ABI; components go through it, never import the
 * generated module directly.
 */

/** Raw exports of the generated `windtunnel` module, grown per feature. */
export type WasmApi = {
  ping(): string;
};

export class WasmLoadError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "WasmLoadError";
  }
}

let loadPromise: Promise<WasmApi> | null = null;

export function loadWasm(): Promise<WasmApi> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const mod = await import("@/wasm/windtunnel");
      await mod.default();
      return { ...mod, ping: mod.ping };
    } catch (cause) {
      // Never cache a rejected promise: the next call retries fresh.
      loadPromise = null;
      throw new WasmLoadError(
        "Simulation engine failed to load — run `npm run wasm:build`",
        { cause },
      );
    }
  })();
  return loadPromise;
}
