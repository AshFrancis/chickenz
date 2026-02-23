#!/usr/bin/env bash
# Chickenz proof worker — polls the server for proof jobs and generates Groth16 proofs locally.
# Run this on your gaming PC with the chickenz-host binary built.
#
# Usage:
#   ./scripts/worker.sh                    # uses built-in defaults
#   SERVER_URL=http://localhost:3000 ./scripts/worker.sh   # override server
#
# Optional env overrides:
#   SERVER_URL    — server to poll (default: https://chickenz.io)
#   WORKER_API_KEY — auth key (default: built-in)
#   PROVER_BINARY — path to chickenz-host (default: services/prover/target/release/chickenz-host)
#   POLL_INTERVAL — seconds between polls (default: 5)

set -euo pipefail

SERVER_URL="${SERVER_URL:-https://chickenz.io}"
WORKER_API_KEY="${WORKER_API_KEY:?Set WORKER_API_KEY}"
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
  STDERR_FILE=$(mktemp /tmp/chickenz-stderr-XXXXXX.log)
  echo "  Proving..."
  PROOF_START=$(date +%s)

  if (cd "$(dirname "$ARTIFACTS_FILE")" && "$PROVER_BINARY" "$TMPFILE" 2>"$STDERR_FILE"); then
    PROOF_END=$(date +%s)
    echo "  Proof generated in $((PROOF_END - PROOF_START))s"
    tail -5 "$STDERR_FILE"

    # Read artifacts from proof_artifacts.json (host writes to cwd)
    ARTIFACTS_PATH="$(dirname "$ARTIFACTS_FILE")/proof_artifacts.json"
    if [[ -f "$ARTIFACTS_PATH" ]]; then
      # Extract seal, journal, imageId
      SEAL=$(python3 -c "import json; d=json.load(open('$ARTIFACTS_PATH')); print(d['seal'])")
      JOURNAL=$(python3 -c "import json; d=json.load(open('$ARTIFACTS_PATH')); print(d['journal'])")
      IMAGE_ID=$(python3 -c "import json; d=json.load(open('$ARTIFACTS_PATH')); print(d['image_id'])")

      # Extract Boundless request ID and tx hash from stderr if present
      BOUNDLESS_ID=$(grep -oP 'Request ID:\s*\K[0-9a-fA-Fx]+' "$STDERR_FILE" 2>/dev/null || echo "")
      BOUNDLESS_TX=$(grep -oP 'Broadcasting tx\s*\K0x[0-9a-fA-F]{64}' "$STDERR_FILE" 2>/dev/null || echo "")
      EXTRA=""
      if [[ -n "$BOUNDLESS_ID" ]]; then
        EXTRA=",\"boundlessRequestId\":\"$BOUNDLESS_ID\""
        echo "  Boundless request: $BOUNDLESS_ID"
      fi
      if [[ -n "$BOUNDLESS_TX" ]]; then
        EXTRA="$EXTRA,\"boundlessTxHash\":\"$BOUNDLESS_TX\""
        echo "  Boundless tx: $BOUNDLESS_TX"
      else
        echo "  (no Boundless tx hash found in stderr)"
        grep -i 'broadcast\|tx\|hash' "$STDERR_FILE" 2>/dev/null | head -3 || true
      fi

      RESULT=$(curl_auth -X POST "$SERVER_URL/api/worker/result/$MATCH_ID" \
        -H "Content-Type: application/json" \
        -d "{\"seal\":\"$SEAL\",\"journal\":\"$JOURNAL\",\"imageId\":\"$IMAGE_ID\"$EXTRA}" 2>/dev/null || echo "error")

      echo "  Submitted: $RESULT"
      rm -f "$ARTIFACTS_PATH"
    else
      echo "  ERROR: proof_artifacts.json not found"
    fi
  else
    echo "  Proof generation failed"
    tail -10 "$STDERR_FILE"
  fi

  rm -f "$STDERR_FILE"

  rm -f "$TMPFILE" "$ARTIFACTS_FILE"
done
