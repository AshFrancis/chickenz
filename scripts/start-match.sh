#!/usr/bin/env bash
set -euo pipefail

# Chickenz Start Match On-Chain
# Usage: ./scripts/start-match.sh <session_id> <seed>
#
# Registers a match on the Game Hub with the given seed commitment.

CHICKENZ_CONTRACT="CDYU5GFNDBIFYWLW54QV3LPDNQTER6ID3SK4QCCBVUY7NU76ESBP7LZP"
NETWORK="testnet"
SOURCE="${STELLAR_SOURCE:-default}"

if [ $# -lt 2 ]; then
    echo "Usage: $0 <session_id> <seed>"
    echo ""
    echo "Example: $0 42 42"
    echo ""
    echo "Environment:"
    echo "  STELLAR_SOURCE    Stellar key name (default: 'default')"
    exit 1
fi

SESSION_ID="$1"
SEED="$2"

# Compute seed_commit = SHA-256(seed as LE u32)
SEED_COMMIT=$(python3 -c "
import hashlib
seed = int('$SEED').to_bytes(4, 'little')
print(hashlib.sha256(seed).hexdigest())
")

PLAYER=$(stellar keys address "$SOURCE" 2>/dev/null)

echo "=== Chickenz Start Match ==="
echo "Session ID:  $SESSION_ID"
echo "Seed:        $SEED"
echo "Seed commit: $SEED_COMMIT"
echo "Player:      $PLAYER"
echo "Contract:    $CHICKENZ_CONTRACT"
echo ""

echo "Calling start_match()..."
stellar contract invoke \
    --id "$CHICKENZ_CONTRACT" \
    --source "$SOURCE" \
    --network "$NETWORK" \
    -- start_match \
    --session_id "$SESSION_ID" \
    --player1 "$PLAYER" \
    --player2 "$PLAYER" \
    --seed_commit "$SEED_COMMIT"

echo ""
echo "Match registered on Game Hub!"
