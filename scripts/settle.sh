#!/usr/bin/env bash
set -euo pipefail

# Chickenz On-Chain Settlement
# Usage: ./scripts/settle.sh <session_id> <proof_artifacts.json>
#
# Reads proof_artifacts.json and calls settle_match() on the Chickenz contract.

CHICKENZ_CONTRACT="CDSSYXMYCB6SPU5TWUU4WEISYGOY2BMIP6RMVHLQ3HMMYHVSOO4IUYAM"
NETWORK="testnet"
SOURCE="${STELLAR_SOURCE:-default}"

if [ $# -lt 2 ]; then
    echo "Usage: $0 <session_id> <proof_artifacts.json>"
    echo ""
    echo "Environment:"
    echo "  STELLAR_SOURCE    Stellar key name (default: 'default')"
    exit 1
fi

SESSION_ID="$1"
ARTIFACTS_FILE="$2"

if [ ! -f "$ARTIFACTS_FILE" ]; then
    echo "Error: Artifacts file not found: $ARTIFACTS_FILE"
    exit 1
fi

# Extract seal and journal from artifacts
SEAL=$(python3 -c "import json; d=json.load(open('$ARTIFACTS_FILE')); print(d['seal'])")
JOURNAL=$(python3 -c "import json; d=json.load(open('$ARTIFACTS_FILE')); print(d['journal'])")

if [ -z "$SEAL" ]; then
    echo "Error: Empty seal in artifacts. Did you generate a Groth16 proof?"
    echo "  Dev mode and --local mode don't produce Groth16 seals."
    exit 1
fi

echo "=== Chickenz On-Chain Settlement ==="
echo "Session ID: $SESSION_ID"
echo "Contract:   $CHICKENZ_CONTRACT"
echo "Seal size:  $((${#SEAL} / 2)) bytes"
echo "Journal:    $((${#JOURNAL} / 2)) bytes"
echo ""

echo "Calling settle_match()..."
stellar contract invoke \
    --id "$CHICKENZ_CONTRACT" \
    --source "$SOURCE" \
    --network "$NETWORK" \
    -- settle_match \
    --session_id "$SESSION_ID" \
    --seal "$SEAL" \
    --journal "$JOURNAL"

echo ""
echo "Match settled on-chain!"
