use serde::{Deserialize, Serialize};

// ── Primitives ──────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

pub type PlayerId = i32;
pub type Tick = u32;
pub type Seed = u32;

// ── Input ───────────────────────────────────────────────────

/// Button bitmask constants.
pub mod button {
    pub const LEFT: u8 = 1;
    pub const RIGHT: u8 = 2;
    pub const JUMP: u8 = 4;
    pub const SHOOT: u8 = 8;
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlayerInput {
    pub buttons: u8,
    pub aim_x: f64,
    pub aim_y: f64,
}

pub const NULL_INPUT: PlayerInput = PlayerInput {
    buttons: 0,
    aim_x: 0.0,
    aim_y: 0.0,
};

// ── Weapons ────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(i32)]
pub enum WeaponType {
    Pistol = 0,
    Shotgun = 1,
    Sniper = 2,
    Rocket = 3,
    SMG = 4,
}

impl WeaponType {
    pub fn from_i32(v: i32) -> Option<Self> {
        match v {
            0 => Some(Self::Pistol),
            1 => Some(Self::Shotgun),
            2 => Some(Self::Sniper),
            3 => Some(Self::Rocket),
            4 => Some(Self::SMG),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct WeaponStats {
    pub damage: i32,
    pub speed: f64,
    pub cooldown: i32,
    pub lifetime: i32,
    pub ammo: i32,
    pub pellets: i32,
    pub spread_deg: f64,
    pub splash_radius: f64,
    pub splash_damage: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct WeaponPickup {
    pub id: i32,
    pub x: f64,
    pub y: f64,
    pub weapon: WeaponType,
    pub respawn_timer: i32,
}

// ── Player ──────────────────────────────────────────────────

/// Facing direction: Right = 1, Left = -1.
pub mod facing {
    pub const RIGHT: i32 = 1;
    pub const LEFT: i32 = -1;
}

/// Player state flag bitmask.
pub mod player_state_flag {
    pub const ALIVE: u32 = 1;
    pub const INVINCIBLE: u32 = 2;
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlayerState {
    pub id: PlayerId,
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub facing: i32,
    pub health: i32,
    pub lives: i32,
    pub shoot_cooldown: i32,
    pub grounded: bool,
    pub state_flags: u32,
    pub respawn_timer: i32,
    pub weapon: Option<WeaponType>,
    pub ammo: i32,
}

// ── Projectile ──────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Projectile {
    pub id: i32,
    pub owner_id: PlayerId,
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub lifetime: i32,
    pub weapon: WeaponType,
}

// ── Map ─────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Platform {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GameMap {
    pub width: f64,
    pub height: f64,
    pub platforms: Vec<Platform>,
    pub spawn_points: Vec<Vec2>,
    pub weapon_spawn_points: Vec<Vec2>,
}

// ── Game State ──────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GameState {
    pub tick: Tick,
    pub players: Vec<PlayerState>,
    pub projectiles: Vec<Projectile>,
    pub weapon_pickups: Vec<WeaponPickup>,
    pub rng_state: u32,
    /// Kill count per player. Index = player id.
    pub score: [u32; 2],
    pub next_projectile_id: i32,
    pub arena_left: f64,
    pub arena_right: f64,
    pub match_over: bool,
    /// PlayerId of winner, or -1 for draw / no winner.
    pub winner: i32,
    /// Ticks remaining before match_over after final kill (death linger).
    pub death_linger_timer: i32,
}

// ── Config ──────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MatchConfig {
    pub seed: Seed,
    pub map: GameMap,
    pub player_count: u32,
    pub tick_rate: u32,
    pub initial_lives: i32,
    pub match_duration_ticks: u32,
    pub sudden_death_start_tick: u32,
}

// ── Prover I/O ──────────────────────────────────────────────

/// Input to the zkVM guest program.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProverInput {
    pub config: MatchConfig,
    /// One entry per tick. Each entry is [player0_input, player1_input].
    pub transcript: Vec<[PlayerInput; 2]>,
}

/// Public output written to the zkVM journal.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProverOutput {
    /// Winner player id, or -1 for draw.
    pub winner: i32,
    /// Final kill scores [player0, player1].
    pub scores: [u32; 2],
    /// SHA-256 hash of the full input transcript.
    pub transcript_hash: [u8; 32],
    /// SHA-256 hash of the seed (commitment).
    pub seed_commit: [u8; 32],
}

/// Journal layout: 19 u32 words = 76 bytes.
pub const PROVER_OUTPUT_WORDS: usize = 19;

impl ProverOutput {
    pub fn to_journal_words(&self) -> [u32; PROVER_OUTPUT_WORDS] {
        let mut w = [0u32; PROVER_OUTPUT_WORDS];
        w[0] = self.winner as u32;
        w[1] = self.scores[0];
        w[2] = self.scores[1];
        for i in 0..8 {
            let off = i * 4;
            w[3 + i] = u32::from_le_bytes([
                self.transcript_hash[off],
                self.transcript_hash[off + 1],
                self.transcript_hash[off + 2],
                self.transcript_hash[off + 3],
            ]);
        }
        for i in 0..8 {
            let off = i * 4;
            w[11 + i] = u32::from_le_bytes([
                self.seed_commit[off],
                self.seed_commit[off + 1],
                self.seed_commit[off + 2],
                self.seed_commit[off + 3],
            ]);
        }
        w
    }

    pub fn from_journal_bytes(b: &[u8]) -> Self {
        assert!(b.len() >= PROVER_OUTPUT_WORDS * 4);
        let u32_at = |off: usize| -> u32 {
            u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
        };
        let hash_at = |start: usize| -> [u8; 32] {
            let mut h = [0u8; 32];
            h.copy_from_slice(&b[start..start + 32]);
            h
        };
        ProverOutput {
            winner: u32_at(0) as i32,
            scores: [u32_at(4), u32_at(8)],
            transcript_hash: hash_at(12),
            seed_commit: hash_at(44),
        }
    }
}
