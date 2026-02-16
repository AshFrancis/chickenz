//! Generates test transcript JSON files for the prover host.
//!
//! Usage:
//!   cargo run -p chickenz-core --example gen-transcript -- [idle|combat] > transcript.json

use chickenz_core::*;

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "idle".to_string());

    let config = default_config(42);

    let transcript: Vec<[PlayerInput; 2]> = match mode.as_str() {
        "idle" => {
            // Both players idle for full match — should end in draw at time-up
            vec![[NULL_INPUT; 2]; config.match_duration_ticks as usize]
        }
        "combat" => {
            // P0 moves right and shoots at P1, P1 stands still
            let mut transcript = Vec::new();
            for tick in 0..config.match_duration_ticks {
                let p0_input = if tick < 200 {
                    // Move right toward P1 and shoot
                    PlayerInput {
                        buttons: button::RIGHT | button::SHOOT,
                        aim_x: 1.0,
                        aim_y: 0.0,
                    }
                } else {
                    // Stand and shoot
                    PlayerInput {
                        buttons: button::SHOOT,
                        aim_x: 1.0,
                        aim_y: 0.0,
                    }
                };
                transcript.push([p0_input, NULL_INPUT]);
            }
            transcript
        }
        "short" => {
            // Short 100-tick idle match for quick proof testing
            vec![[NULL_INPUT; 2]; 100]
        }
        _ => {
            eprintln!("Unknown mode: {}. Use 'idle', 'combat', or 'short'", mode);
            std::process::exit(1);
        }
    };

    // Verify by running the sim
    let mut state = create_initial_state(&config);
    let mut prev_inputs = [NULL_INPUT; 2];
    for tick_inputs in &transcript {
        state = step(&state, tick_inputs, &prev_inputs, &config);
        prev_inputs = *tick_inputs;
        if state.match_over {
            break;
        }
    }

    eprintln!("=== Sim result ({} mode) ===", mode);
    eprintln!("Final tick: {}", state.tick);
    eprintln!("Match over: {}", state.match_over);
    eprintln!("Winner: {}", state.winner);
    eprintln!("Scores: P0={}, P1={}", state.score[0], state.score[1]);
    eprintln!(
        "Lives: P0={}, P1={}",
        state.players[0].lives, state.players[1].lives
    );

    let input = ProverInput {
        config,
        transcript,
    };

    println!("{}", serde_json::to_string(&input).unwrap());
}
