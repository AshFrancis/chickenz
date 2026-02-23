#!/usr/bin/env bash
set -euo pipefail

# Chickenz ZK Prover
# Usage: ./scripts/prove.sh <transcript.json> [--local] [--boundless]
#
# Modes:
#   --local       Generate local STARK proof (no Groth16, can't settle on-chain)
#   --boundless   Generate Groth16 proof via Boundless marketplace
#   (default)     Generate Groth16 proof locally (requires RISC Zero Groth16 toolchain)
#
# Dev mode (for testing):
#   RISC0_DEV_MODE=1 ./scripts/prove.sh transcript.json --local

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PROVER_DIR="$ROOT_DIR/services/prover"
HOST_BIN="$PROVER_DIR/target/release/chickenz-host"

if [ $# -lt 1 ]; then
    echo "Usage: $0 <transcript.json> [--local] [--boundless]"
    echo ""
    echo "Options:"
    echo "  --local       Local STARK proof (no Groth16)"
    echo "  --boundless   Groth16 via Boundless marketplace"
    echo ""
    echo "Environment:"
    echo "  RISC0_DEV_MODE=1    Skip real proving (testing only)"
    echo "  RPC_URL              Required for Boundless proving"
    echo "  PRIVATE_KEY          Required for Boundless proving"
    echo "  PINATA_JWT           Required for Boundless proving"
    exit 1
fi

TRANSCRIPT="$1"
shift

# Check transcript exists
if [ ! -f "$TRANSCRIPT" ]; then
    echo "Error: Transcript file not found: $TRANSCRIPT"
    exit 1
fi

# Build if needed
if [ ! -f "$HOST_BIN" ]; then
    echo "Building prover host (release)..."
    (cd "$PROVER_DIR" && cargo build --release -p chickenz-host)
fi

echo "=== Chickenz ZK Prover ==="
echo "Transcript: $TRANSCRIPT"
echo "Args: $@"
echo ""

"$HOST_BIN" "$TRANSCRIPT" "$@"

echo ""
if [ -f "$PROVER_DIR/proof_artifacts.json" ]; then
    echo "Proof artifacts: $PROVER_DIR/proof_artifacts.json"
fi
