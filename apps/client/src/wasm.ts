// Client WASM loader — initializes the chickenz-wasm module asynchronously at app startup.
import init, { WasmState, init_panic_hook } from "../../../services/prover/wasm/pkg/chickenz_wasm.js";

let initialized = false;

export async function initChickenzWasm() {
  if (initialized) return;
  await init();
  init_panic_hook();
  initialized = true;
}

export { WasmState };
