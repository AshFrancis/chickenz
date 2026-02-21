// WASM sim loader for server — initializes the chickenz-wasm module synchronously at import time.
import initWasm, { WasmState, initSync } from "../../prover/wasm/pkg/chickenz_wasm.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const wasmPath = resolve(import.meta.dir, "../../prover/wasm/pkg/chickenz_wasm_bg.wasm");
const wasmBytes = readFileSync(wasmPath);
initSync(wasmBytes);

export { WasmState };
