#!/usr/bin/env bash
# Chickenz proof worker — polls the server for proof jobs and generates Groth16 proofs locally.
# Run this on your gaming PC with the chickenz-host binary built.
#
# Usage:
#   WORKER_API_KEY=secret SERVER_URL=https://chickenz.example.com ./scripts/worker.sh
#
# Optional env:
#   PROVER_BINARY — path to chickenz-host (default: services/prover/target/release/chickenz-host)
#   POLL_INTERVAL — seconds between polls (default: 5)

set -euo pipefail

SERVER_URL="${SERVER_URL:?Set SERVER_URL (e.g. https://chickenz.example.com)}"
WORKER_API_KEY="${WORKER_API_KEY:-}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROVER_BINARY="${PROVER_BINARY:-$SCRIPT_DIR/../services/prover/target/release/chickenz-host}"

if [[ ! -x "$PROVER_BINARY" ]]; then
  echo "ERROR: Prover binary not found at $PROVER_BINARY"
  echo "Build it with: cd services/prover && cargo build -p chickenz-host --release"
  exit 1
fi

AUTH_HEADER=""
if [[ -n "$WORKER_API_KEY" ]]; then
  AUTH_HEADER="Authorization: Bearer $WORKER_API_KEY"
fi

curl_auth() {
  if [[ -n "$AUTH_HEADER" ]]; then
    curl -sf -H "$AUTH_HEADER" "$@"
  else
    curl -sf "$@"
  fi
}

echo "Chickenz proof worker starting"
echo "  Server: $SERVER_URL"
echo "  Binary: $PROVER_BINARY"
echo "  Poll interval: ${POLL_INTERVAL}s"
echo ""

while true; do
  # Poll for next job
  RESPONSE=$(curl_auth "$SERVER_URL/api/worker/poll" 2>/dev/null || echo '{"matchId":null}')
  MATCH_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('matchId') or '')" 2>/dev/null || echo "")

  if [[ -z "$MATCH_ID" ]]; then
    sleep "$POLL_INTERVAL"
    continue
  fi

  echo "[$(date +%H:%M:%S)] Job: $MATCH_ID"

  # Download transcript
  TMPFILE=$(mktemp /tmp/chickenz-worker-XXXXXX.json)
  if ! curl_auth -o "$TMPFILE" "$SERVER_URL/api/worker/input/$MATCH_ID"; then
    echo "  Failed to download transcript"
    rm -f "$TMPFILE"
    sleep "$POLL_INTERVAL"
    continue
  fi

  # Run proof (Groth16 by default — no --local flag)
  ARTIFACTS_FILE=$(mktemp /tmp/chickenz-artifacts-XXXXXX.json)
  echo "  Proving..."
  PROOF_START=$(date +%s)

  if (cd "$(dirname "$ARTIFACTS_FILE")" && "$PROVER_BINARY" "$TMPFILE" 2>&1 | tail -5); then
    PROOF_END=$(date +%s)
    echo "  Proof generated in $((PROOF_END - PROOF_START))s"

    # Read artifacts from proof_artifacts.json (host writes to cwd)
    ARTIFACTS_PATH="$(dirname "$ARTIFACTS_FILE")/proof_artifacts.json"
    if [[ -f "$ARTIFACTS_PATH" ]]; then
      # Extract seal, journal, imageId and submit
      SEAL=$(python3 -c "import json; d=json.load(open('$ARTIFACTS_PATH')); print(d['seal'])")
      JOURNAL=$(python3 -c "import json; d=json.load(open('$ARTIFACTS_PATH')); print(d['journal'])")
      IMAGE_ID=$(python3 -c "import json; d=json.load(open('$ARTIFACTS_PATH')); print(d['image_id'])")

      RESULT=$(curl_auth -X POST "$SERVER_URL/api/worker/result/$MATCH_ID" \
        -H "Content-Type: application/json" \
        -d "{\"seal\":\"$SEAL\",\"journal\":\"$JOURNAL\",\"imageId\":\"$IMAGE_ID\"}" 2>/dev/null || echo "error")

      echo "  Submitted: $RESULT"
      rm -f "$ARTIFACTS_PATH"
    else
      echo "  ERROR: proof_artifacts.json not found"
    fi
  else
    echo "  Proof generation failed"
  fi

  rm -f "$TMPFILE" "$ARTIFACTS_FILE"
done
