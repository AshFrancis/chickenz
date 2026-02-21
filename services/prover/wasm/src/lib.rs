use wasm_bindgen::prelude::*;
use chickenz_core::fp::{
    self, State, Map, Platform, SpawnPoint, FpInput, Player, Projectile, WeaponPickup,
    NUM_PLATFORMS, NUM_SPAWNS, NUM_WEAPON_SPAWNS,
    MAX_PROJECTILES, MAX_WEAPON_PICKUPS,
    EMPTY_PROJECTILE, EMPTY_PICKUP,
    fp as to_fp, ONE,
};
use serde::{Serialize, Deserialize};

/// Install panic hook so WASM panics show in browser console instead of silently freezing.
#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

/// Fixed-point to f64 conversion
#[inline(always)]
fn fp_to_f64(v: i32) -> f64 {
    v as f64 / ONE as f64
}

/// f64 to fixed-point conversion (lossless for values that originated as fp)
#[inline(always)]
fn f64_to_fp(v: f64) -> i32 {
    (v * ONE as f64).round() as i32
}

/// JSON-serializable player state (f64 values for JS)
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsPlayer {
    id: i32,
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
    facing: i32,
    health: i32,
    lives: i32,
    shoot_cooldown: i32,
    grounded: bool,
    state_flags: u32,
    respawn_timer: i32,
    weapon: i8,
    ammo: i32,
    jumps_left: i32,
    wall_sliding: bool,
    wall_dir: i32,
    stomped_by: i32,
    stomping_on: i32,
    stomp_shake_progress: i32,
    stomp_cooldown: i32,
}

/// JSON-serializable projectile (f64 values for JS)
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsProjectile {
    id: i32,
    owner_id: i32,
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
    lifetime: i32,
    weapon: i8,
}

/// JSON-serializable weapon pickup (f64 values for JS)
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsWeaponPickup {
    id: i32,
    x: f64,
    y: f64,
    weapon: i8,
    respawn_timer: i32,
}

/// JSON-serializable full game state for JS
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsState {
    tick: i32,
    players: Vec<JsPlayer>,
    projectiles: Vec<JsProjectile>,
    weapon_pickups: Vec<JsWeaponPickup>,
    scores: [u32; 2],
    arena_left: f64,
    arena_right: f64,
    match_over: bool,
    winner: i32,
    death_linger_timer: i32,
    rng_state: u32,
    next_projectile_id: i32,
    // prev_buttons for edge-triggered jump detection during reconciliation replay
    #[serde(default)]
    last_buttons: [u8; 2],
    // Per-match config (optional on import — defaults to standard values)
    #[serde(default = "default_initial_lives")]
    cfg_initial_lives: i32,
    #[serde(default = "default_match_duration")]
    cfg_match_duration: i32,
    #[serde(default = "default_sudden_death")]
    cfg_sudden_death: i32,
}

fn default_initial_lives() -> i32 { fp::INITIAL_LIVES }
fn default_match_duration() -> i32 { fp::MATCH_DURATION_TICKS }
fn default_sudden_death() -> i32 { fp::SUDDEN_DEATH_START_TICK }

fn player_to_js(p: &Player) -> JsPlayer {
    JsPlayer {
        id: p.id,
        x: fp_to_f64(p.x),
        y: fp_to_f64(p.y),
        vx: fp_to_f64(p.vx),
        vy: fp_to_f64(p.vy),
        facing: p.facing,
        health: p.health,
        lives: p.lives,
        shoot_cooldown: p.shoot_cooldown,
        grounded: p.grounded,
        state_flags: p.state_flags,
        respawn_timer: p.respawn_timer,
        weapon: p.weapon,
        ammo: p.ammo,
        jumps_left: p.jumps_left,
        wall_sliding: p.wall_sliding,
        wall_dir: p.wall_dir,
        stomped_by: p.stomped_by,
        stomping_on: p.stomping_on,
        stomp_shake_progress: p.stomp_shake_progress,
        stomp_cooldown: p.stomp_cooldown,
    }
}

fn player_from_js(p: &JsPlayer) -> Player {
    Player {
        id: p.id,
        x: f64_to_fp(p.x),
        y: f64_to_fp(p.y),
        vx: f64_to_fp(p.vx),
        vy: f64_to_fp(p.vy),
        facing: p.facing,
        health: p.health,
        lives: p.lives,
        shoot_cooldown: p.shoot_cooldown,
        grounded: p.grounded,
        state_flags: p.state_flags,
        respawn_timer: p.respawn_timer,
        weapon: p.weapon,
        ammo: p.ammo,
        jumps_left: p.jumps_left,
        wall_sliding: p.wall_sliding,
        wall_dir: p.wall_dir,
        stomped_by: p.stomped_by,
        stomping_on: p.stomping_on,
        stomp_shake_progress: p.stomp_shake_progress,
        stomp_last_shake_dir: 0,
        stomp_auto_run_dir: 0,
        stomp_auto_run_timer: 0,
        stomp_cooldown: p.stomp_cooldown,
    }
}

fn state_to_js(s: &State) -> JsState {
    let mut projs = Vec::new();
    for i in 0..s.proj_count as usize {
        let p = &s.projectiles[i];
        projs.push(JsProjectile {
            id: p.id,
            owner_id: p.owner_id,
            x: fp_to_f64(p.x),
            y: fp_to_f64(p.y),
            vx: fp_to_f64(p.vx),
            vy: fp_to_f64(p.vy),
            lifetime: p.lifetime,
            weapon: p.weapon,
        });
    }
    let mut pickups = Vec::new();
    for i in 0..s.pickup_count as usize {
        let wp = &s.weapon_pickups[i];
        pickups.push(JsWeaponPickup {
            id: wp.id,
            x: fp_to_f64(wp.x),
            y: fp_to_f64(wp.y),
            weapon: wp.weapon,
            respawn_timer: wp.respawn_timer,
        });
    }
    JsState {
        tick: s.tick,
        players: s.players.iter().map(player_to_js).collect(),
        projectiles: projs,
        weapon_pickups: pickups,
        scores: s.score,
        arena_left: fp_to_f64(s.arena_left),
        arena_right: fp_to_f64(s.arena_right),
        match_over: s.match_over,
        winner: s.winner,
        death_linger_timer: s.death_linger_timer,
        rng_state: s.rng_state,
        next_projectile_id: s.next_proj_id,
        last_buttons: s.prev_buttons,
        cfg_initial_lives: s.cfg_initial_lives,
        cfg_match_duration: s.cfg_match_duration,
        cfg_sudden_death: s.cfg_sudden_death,
    }
}

/// JSON-serializable map definition from JS
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsMap {
    width: f64,
    height: f64,
    platforms: Vec<JsPlatform>,
    spawn_points: Vec<JsPoint>,
    weapon_spawn_points: Vec<JsPoint>,
}

#[derive(Deserialize)]
struct JsPlatform {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
struct JsPoint {
    x: f64,
    y: f64,
}

fn map_from_js(m: &JsMap) -> Map {
    let mut platforms = [Platform { x: 0, y: 0, width: 0, height: 0 }; NUM_PLATFORMS];
    for (i, p) in m.platforms.iter().enumerate().take(NUM_PLATFORMS) {
        platforms[i] = Platform {
            x: to_fp(p.x as i32),
            y: to_fp(p.y as i32),
            width: to_fp(p.width as i32),
            height: to_fp(p.height as i32),
        };
    }
    let mut spawns = [SpawnPoint { x: 0, y: 0 }; NUM_SPAWNS];
    for (i, s) in m.spawn_points.iter().enumerate().take(NUM_SPAWNS) {
        spawns[i] = SpawnPoint { x: to_fp(s.x as i32), y: to_fp(s.y as i32) };
    }
    let mut weapon_spawns = [SpawnPoint { x: 0, y: 0 }; NUM_WEAPON_SPAWNS];
    for (i, s) in m.weapon_spawn_points.iter().enumerate().take(NUM_WEAPON_SPAWNS) {
        weapon_spawns[i] = SpawnPoint { x: to_fp(s.x as i32), y: to_fp(s.y as i32) };
    }
    Map { width: to_fp(m.width as i32), height: to_fp(m.height as i32), platforms, spawns, weapon_spawns }
}

#[wasm_bindgen]
pub struct WasmState {
    inner: State,
    map: Map,
}

#[wasm_bindgen]
impl WasmState {
    /// Create a new game state from seed and map JSON.
    /// Map JSON: { width, height, platforms: [{x,y,width,height}], spawnPoints: [{x,y}], weaponSpawnPoints: [{x,y}] }
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32, map_json: &str) -> WasmState {
        let js_map: JsMap = serde_json::from_str(map_json).unwrap_or_else(|_| {
            // Fallback: use default arena map
            let m = fp::arena_map();
            return JsMap {
                width: fp_to_f64(m.width),
                height: fp_to_f64(m.height),
                platforms: m.platforms.iter().map(|p| JsPlatform {
                    x: fp_to_f64(p.x), y: fp_to_f64(p.y),
                    width: fp_to_f64(p.width), height: fp_to_f64(p.height),
                }).collect(),
                spawn_points: m.spawns.iter().map(|s| JsPoint {
                    x: fp_to_f64(s.x), y: fp_to_f64(s.y),
                }).collect(),
                weapon_spawn_points: m.weapon_spawns.iter().map(|s| JsPoint {
                    x: fp_to_f64(s.x), y: fp_to_f64(s.y),
                }).collect(),
            };
        });
        let map = map_from_js(&js_map);
        let inner = fp::create_initial_state(seed, &map);
        WasmState { inner, map }
    }

    /// Create from the default arena map.
    pub fn new_arena(seed: u32) -> WasmState {
        let map = fp::arena_map();
        let inner = fp::create_initial_state(seed, &map);
        WasmState { inner, map }
    }

    /// Create a warmup state (99 lives, no sudden death, no match end).
    pub fn new_warmup(seed: u32, map_json: &str) -> WasmState {
        let js_map: JsMap = serde_json::from_str(map_json).unwrap_or_else(|_| {
            let m = fp::arena_map();
            JsMap {
                width: fp_to_f64(m.width), height: fp_to_f64(m.height),
                platforms: m.platforms.iter().map(|p| JsPlatform {
                    x: fp_to_f64(p.x), y: fp_to_f64(p.y),
                    width: fp_to_f64(p.width), height: fp_to_f64(p.height),
                }).collect(),
                spawn_points: m.spawns.iter().map(|s| JsPoint { x: fp_to_f64(s.x), y: fp_to_f64(s.y) }).collect(),
                weapon_spawn_points: m.weapon_spawns.iter().map(|s| JsPoint { x: fp_to_f64(s.x), y: fp_to_f64(s.y) }).collect(),
            }
        });
        let map = map_from_js(&js_map);
        let inner = fp::create_initial_state_cfg(seed, &map, 99, 999999, 999999);
        WasmState { inner, map }
    }

    /// Step the simulation by one tick.
    pub fn step(&mut self, p0_btn: u8, p0_ax: i8, p0_ay: i8, p1_btn: u8, p1_ax: i8, p1_ay: i8) {
        let inputs = [
            FpInput { buttons: p0_btn, aim_x: p0_ax, aim_y: p0_ay },
            FpInput { buttons: p1_btn, aim_x: p1_ax, aim_y: p1_ay },
        ];
        fp::step_mut(&mut self.inner, &inputs, &self.map);
    }

    /// Export full game state as JS object (fp → f64 for rendering/network).
    pub fn export_state(&self) -> JsValue {
        let js = state_to_js(&self.inner);
        serde_wasm_bindgen::to_value(&js).unwrap()
    }

    /// Import game state from JS object (f64 → fp for reconciliation).
    pub fn import_state(&mut self, state: JsValue) {
        // Use JSON.stringify → serde_json for robust deserialization
        // (serde_wasm_bindgen::from_value has quirks with i8 types and nested structs)
        let json_str = match js_sys::JSON::stringify(&state) {
            Ok(s) => String::from(s),
            Err(_) => return,
        };
        let js: JsState = match serde_json::from_str(&json_str) {
            Ok(js) => js,
            Err(_) => return,
        };
        self.inner.tick = js.tick;
        for (i, jp) in js.players.iter().enumerate().take(2) {
            self.inner.players[i] = player_from_js(jp);
        }
        // Import projectiles
        self.inner.proj_count = js.projectiles.len().min(MAX_PROJECTILES) as u8;
        self.inner.projectiles = [EMPTY_PROJECTILE; MAX_PROJECTILES];
        for (i, jp) in js.projectiles.iter().enumerate().take(MAX_PROJECTILES) {
            self.inner.projectiles[i] = Projectile {
                id: jp.id,
                owner_id: jp.owner_id,
                x: f64_to_fp(jp.x),
                y: f64_to_fp(jp.y),
                vx: f64_to_fp(jp.vx),
                vy: f64_to_fp(jp.vy),
                lifetime: jp.lifetime,
                weapon: jp.weapon,
            };
        }
        // Import pickups
        self.inner.pickup_count = js.weapon_pickups.len().min(MAX_WEAPON_PICKUPS) as u8;
        self.inner.weapon_pickups = [EMPTY_PICKUP; MAX_WEAPON_PICKUPS];
        for (i, jp) in js.weapon_pickups.iter().enumerate().take(MAX_WEAPON_PICKUPS) {
            self.inner.weapon_pickups[i] = WeaponPickup {
                id: jp.id,
                x: f64_to_fp(jp.x),
                y: f64_to_fp(jp.y),
                weapon: jp.weapon,
                respawn_timer: jp.respawn_timer,
            };
        }
        self.inner.score = js.scores;
        self.inner.arena_left = f64_to_fp(js.arena_left);
        self.inner.arena_right = f64_to_fp(js.arena_right);
        self.inner.match_over = js.match_over;
        self.inner.winner = js.winner;
        self.inner.death_linger_timer = js.death_linger_timer;
        self.inner.rng_state = js.rng_state;
        self.inner.next_proj_id = js.next_projectile_id;
        self.inner.prev_buttons = js.last_buttons;
        self.inner.cfg_initial_lives = js.cfg_initial_lives;
        self.inner.cfg_match_duration = js.cfg_match_duration;
        self.inner.cfg_sudden_death = js.cfg_sudden_death;
    }

    /// Clone the state (for prediction snapshots).
    pub fn clone_state(&self) -> WasmState {
        WasmState {
            inner: self.inner.clone(),
            map: self.map.clone(),
        }
    }

    // Quick accessors
    pub fn tick(&self) -> i32 { self.inner.tick }
    pub fn match_over(&self) -> bool { self.inner.match_over }
    pub fn winner(&self) -> i32 { self.inner.winner }
    pub fn rng_state(&self) -> u32 { self.inner.rng_state }
}
