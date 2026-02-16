# ZK_SETTLEMENT.md

# Overview

The ZK proof is the core mechanic: it cryptographically proves that a game was played fairly and the claimed winner is correct, without revealing the full game transcript on-chain.

**Stack**: Noir (Aztec's ZK DSL) + Boundless (decentralized proving network on Stellar)

---

# What the Proof Verifies

1. Seed matches seed_commit (fair randomness)
2. Input transcript matches transcript_hash (inputs weren't tampered)
3. Deterministic sim replay with seed + inputs produces the claimed final state
4. Winner is correctly derived from final state (kill count)

---

# Public Inputs

- match_id
- player1, player2 (Stellar addresses)
- seed_commit (hash of seed)
- transcript_hash (hash of full input transcript)
- winner (player id)
- final_score_p1, final_score_p2

---

# Private Witness

- seed (preimage of seed_commit)
- full input transcript (per-tick inputs for both players)
- intermediate state hashes (for chunked verification)

---

# Noir Circuit Design

The Noir circuit must:
1. Hash the seed, assert it matches seed_commit
2. Hash the input transcript, assert it matches transcript_hash
3. Replay the sim: initialize state from seed, apply inputs tick by tick
4. After N ticks, extract scores and determine winner
5. Assert winner matches the public input

**Constraints for Noir:**
- All arithmetic in finite field (no floats — use fixed-point or integer math)
- Loops must be bounded (fixed tick count per match)
- Array sizes must be compile-time constants
- May need a simplified sim (fewer physics features) to keep circuit size manageable

**Pragmatic approach for hackathon:**
- Short matches (e.g. 300 ticks / 5 seconds)
- Simplified physics in the circuit (movement + basic collision + damage)
- Full sim runs in browser; circuit verifies a digest/replay

---

# Settlement Flow

1. Players connect wallets, contract calls `start_game()` on Game Hub
2. Match plays out in browser (deterministic sim)
3. Client records full input transcript
4. Noir circuit generates proof of correct outcome
5. Proof + public inputs submitted to Chickenz Soroban contract
6. Contract verifies proof
7. Contract calls `end_game()` on Game Hub with verified winner

---

# Soroban Contract Interface

```
start_match(match_id, player1, player2, seed_commit) → calls GameHub.start_game()
settle_match(match_id, proof, winner, transcript_hash, seed_reveal) → verifies proof, calls GameHub.end_game()
```

Game Hub contract: `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG`

---

# Boundless Integration

Boundless is a decentralized proving network that runs on Stellar. It allows:
- Offloading proof generation to the network
- Verification of proofs on-chain via Soroban
- Compatible with Noir circuits

The client submits the witness to Boundless, receives a proof back, then submits the proof to the Soroban contract.

---

# Trust Model

**Hackathon (MVP):**
- Both players in same browser (local 2-player)
- Client generates transcript and proof
- Contract trusts proof verification

**Future (production):**
- Server-authoritative sim
- Players sign input batches
- Anyone-can-settle with transcript + proof
- External proving network (Boundless) for trustless proof generation
