use sha2::{Digest, Sha256};

use crate::types::PlayerInput;

/// SHA-256 hash of the full input transcript.
pub fn hash_transcript(transcript: &[[PlayerInput; 2]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for tick_inputs in transcript {
        for input in tick_inputs {
            hasher.update(input.buttons.to_le_bytes());
            hasher.update(input.aim_x.to_le_bytes());
            hasher.update(input.aim_y.to_le_bytes());
        }
    }
    hasher.finalize().into()
}

/// SHA-256 commitment of the seed.
pub fn hash_seed(seed: u32) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(seed.to_le_bytes());
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::NULL_INPUT;

    #[test]
    fn transcript_hash_deterministic() {
        let transcript = vec![[NULL_INPUT; 2]; 100];
        let h1 = hash_transcript(&transcript);
        let h2 = hash_transcript(&transcript);
        assert_eq!(h1, h2);
    }

    #[test]
    fn different_transcripts_different_hash() {
        let t1 = vec![[NULL_INPUT; 2]; 100];
        let mut t2 = vec![[NULL_INPUT; 2]; 100];
        t2[50][0].buttons = 1;
        assert_ne!(hash_transcript(&t1), hash_transcript(&t2));
    }

    #[test]
    fn seed_hash_deterministic() {
        assert_eq!(hash_seed(42), hash_seed(42));
        assert_ne!(hash_seed(42), hash_seed(43));
    }
}
