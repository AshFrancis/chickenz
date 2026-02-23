// WASM sim loader for server — initializes the chickenz-wasm module synchronously at import time.
import { WasmState, initSync } from "../../prover/wasm/pkg/chickenz_wasm.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const wasmPath = resolve(import.meta.dir, "../../prover/wasm/pkg/chickenz_wasm_bg.wasm");
let wasmBytes: Buffer;
try {
  wasmBytes = readFileSync(wasmPath);
} catch {
  console.error(
    `\n  ERROR: WASM file not found at ${wasmPath}\n  Run 'cd services/prover/wasm && wasm-pack build --target web' first.\n`,
  );
  process.exit(1);
}
initSync(wasmBytes);

export { WasmState };
