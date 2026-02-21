// Client WASM loader — initializes the chickenz-wasm module asynchronously at app startup.
import init, { WasmState } from "../../../services/prover/wasm/pkg/chickenz_wasm.js";

let initialized = false;

export async function initChickenzWasm() {
  if (initialized) return;
  await init();
  initialized = true;
}

export { WasmState };
