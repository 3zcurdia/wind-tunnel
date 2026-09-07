"use client";

import { useState } from "react";
import { loadWasm, WasmLoadError } from "@/lib/sim/wasm";

type ProbeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; result: string }
  | { status: "error"; message: string };

/** TEMPORARY dev probe (F003) — proves the WASM pipeline end-to-end. Deleted in F019. */
export function WasmProbe() {
  const [state, setState] = useState<ProbeState>({ status: "idle" });

  async function testEngine() {
    setState({ status: "loading" });
    try {
      const api = await loadWasm();
      setState({ status: "ok", result: api.ping() });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof WasmLoadError ? err.message : String(err),
      });
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={testEngine}
        disabled={state.status === "loading"}
        className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-100 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {state.status === "loading" ? "Testing…" : "Test engine"}
      </button>
      {state.status === "ok" && (
        <p className="font-mono text-xs text-green-500">{state.result}</p>
      )}
      {state.status === "error" && (
        <p className="text-xs text-red-500">{state.message}</p>
      )}
    </div>
  );
}
