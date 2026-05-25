/* tslint:disable */
/* eslint-disable */

export class WasmState {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Clone the state (for prediction snapshots).
     */
    clone_state(): WasmState;
    /**
     * Export full game state as JS object (fp → f64 for rendering/network).
     */
    export_state(): any;
    /**
     * Import game state from JS object (f64 → fp for reconciliation).
     */
    import_state(state: any): void;
    match_over(): boolean;
    /**
     * Create a new game state from seed and map JSON.
     * Map JSON: { width, height, platforms: [{x,y,width,height}], spawnPoints: [{x,y}], weaponSpawnPoints: [{x,y}] }
     */
    constructor(seed: number, map_json: string);
    /**
     * Create from the default arena map.
     */
    static new_arena(seed: number): WasmState;
    /**
     * Create a warmup state (99 lives, no sudden death, no match end).
     */
    static new_warmup(seed: number, map_json: string): WasmState;
    rng_state(): number;
    /**
     * Step the simulation by one tick.
     */
    step(p0_btn: number, p0_ax: number, p0_ay: number, p1_btn: number, p1_ax: number, p1_ay: number): void;
    tick(): number;
    winner(): number;
}

/**
 * Install panic hook so WASM panics show in browser console instead of silently freezing.
 */
export function init_panic_hook(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmstate_free: (a: number, b: number) => void;
    readonly wasmstate_clone_state: (a: number) => number;
    readonly wasmstate_export_state: (a: number) => any;
    readonly wasmstate_import_state: (a: number, b: any) => void;
    readonly wasmstate_match_over: (a: number) => number;
    readonly wasmstate_new: (a: number, b: number, c: number) => number;
    readonly wasmstate_new_arena: (a: number) => number;
    readonly wasmstate_new_warmup: (a: number, b: number, c: number) => number;
    readonly wasmstate_rng_state: (a: number) => number;
    readonly wasmstate_step: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly wasmstate_tick: (a: number) => number;
    readonly wasmstate_winner: (a: number) => number;
    readonly init_panic_hook: () => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
