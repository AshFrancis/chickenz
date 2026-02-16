#!/usr/bin/env bash
set -euo pipefail

# Chickenz ZK Prover
# Usage: ./scripts/prove.sh <transcript.json> [--local] [--chunked]
#
# Modes:
#   --local     Generate local STARK proof (no Groth16, can't settle on-chain)
#   --chunked   Use chunked composition (10 chunks + match composer)
#   (default)   Generate Groth16 proof via Bonsai (requires BONSAI_API_KEY)
#
# Dev mode (for testing):
#   RISC0_DEV_MODE=1 ./scripts/prove.sh transcript.json --chunked

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PROVER_DIR="$ROOT_DIR/services/prover"
HOST_BIN="$PROVER_DIR/target/release/chickenz-host"

if [ $# -lt 1 ]; then
    echo "Usage: $0 <transcript.json> [--local] [--chunked]"
    echo ""
    echo "Options:"
    echo "  --local     Local STARK proof (no Groth16)"
    echo "  --chunked   Chunked composition (recommended)"
    echo ""
    echo "Environment:"
    echo "  RISC0_DEV_MODE=1    Skip real proving (testing only)"
    echo "  BONSAI_API_KEY      Required for Groth16 proofs"
    echo "  BONSAI_API_URL      Bonsai API endpoint"
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

# Check for Groth16 requirements
HAS_LOCAL=false
for arg in "$@"; do
    if [ "$arg" = "--local" ]; then HAS_LOCAL=true; fi
done

if [ "$HAS_LOCAL" = false ] && [ -z "${RISC0_DEV_MODE:-}" ]; then
    if [ -z "${BONSAI_API_KEY:-}" ]; then
        echo "WARNING: No BONSAI_API_KEY set. Groth16 proving requires Bonsai."
        echo "  Set BONSAI_API_KEY and BONSAI_API_URL, or use --local for STARK."
        echo ""
    fi
fi

echo "=== Chickenz ZK Prover ==="
echo "Transcript: $TRANSCRIPT"
echo "Mode: ${RISC0_DEV_MODE:+dev }${HAS_LOCAL:+STARK}${HAS_LOCAL:-Groth16} $@"
echo ""

"$HOST_BIN" "$TRANSCRIPT" "$@"

echo ""
if [ -f "$PROVER_DIR/proof_artifacts.json" ]; then
    echo "Proof artifacts: $PROVER_DIR/proof_artifacts.json"
fi
