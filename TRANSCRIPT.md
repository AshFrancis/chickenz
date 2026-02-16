# TRANSCRIPT.md

# Transcript Model

The transcript is the complete record of player inputs for a match. It is the private witness for the ZK proof.

---

# Structure

For each tick T (0 to N-1):
- player1_input: { buttons, aimX, aimY }
- player2_input: { buttons, aimX, aimY }

Plus match metadata:
- match_id
- seed
- player addresses
- tick count

---

# Hashing

transcript_hash = hash(all inputs in tick order)

This hash is a public input to the ZK circuit. The circuit re-hashes the private witness inputs and asserts they match.

seed_commit = hash(seed)

The seed is revealed at settlement. The circuit verifies seed matches seed_commit.

---

# Integrity Guarantees

**Hackathon (local):**
- Client records transcript during gameplay
- Transcript is input to Noir circuit
- ZK proof guarantees transcript produces the claimed outcome

**Future (networked):**
- Players sign input batches
- Server verifies signatures
- Transcript is append-only
- Commitment chain: C0 = H(match_id || seed_commit), C_{k+1} = H(C_k || batch_hash || signatures)
- Final transcript_root = C_last

---

# Data Availability

Settlement requires:
- transcript_hash (public, on-chain)
- seed_commit (public, on-chain)
- ZK proof (submitted to contract)
- seed_reveal (submitted at settlement, verified against seed_commit)
