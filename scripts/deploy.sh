#!/bin/bash
# Deploy to multi-region servers
#
# Usage:
#   ./scripts/deploy.sh                  # full deploy to all regions
#   ./scripts/deploy.sh client           # client-only to all
#   ./scripts/deploy.sh server           # server-only to all regions
#   ./scripts/deploy.sh server eu        # server-only to EU
#   ./scripts/deploy.sh server us        # server-only to US
#   ./scripts/deploy.sh server asia      # server-only to Asia
#   ./scripts/deploy.sh prover <region>  # prover-only rebuild

set -euo pipefail

# ── Server definitions ─────────────────────────────────────────
US_SERVER="root@178.156.244.26"
EU_SERVER="root@89.167.92.60"
ASIA_SERVER="root@5.223.61.107"

declare -A SERVERS=(
  [us]="$US_SERVER"
  [eu]="$EU_SERVER"
  [asia]="$ASIA_SERVER"
)

REMOTE_DIR="/root/chickenz"
SSH_OPTS="-o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[deploy]${NC} $1"; }
err() { echo -e "${RED}[deploy]${NC} $1" >&2; }
warn() { echo -e "${YELLOW}[deploy]${NC} $1"; }

MODE="${1:-both}"
REGION="${2:-all}"

# Resolve which servers to target
get_targets() {
  if [ "$REGION" = "all" ]; then
    echo "us eu asia"
  else
    if [ -z "${SERVERS[$REGION]+x}" ]; then
      err "Unknown region: $REGION (valid: us, eu, asia)"
      exit 1
    fi
    echo "$REGION"
  fi
}

deploy_to_server() {
  local region="$1"
  local server="${SERVERS[$region]}"
  log "[$region] Deploying to $server..."

  if [ "$MODE" = "server" ] || [ "$MODE" = "both" ]; then
    log "[$region] Git pull..."
    ssh $SSH_OPTS "$server" "cd $REMOTE_DIR && git pull origin main 2>&1 | tail -3 && bun install 2>&1 | tail -3"
  fi

  if [ "$MODE" = "client" ] || [ "$MODE" = "both" ]; then
    log "[$region] Uploading client dist..."
    ssh $SSH_OPTS "$server" "mkdir -p $REMOTE_DIR/services/server/public"
    scp $SSH_OPTS -r "$PROJECT_ROOT/apps/client/dist/"* "$server:$REMOTE_DIR/services/server/public/"
  fi

  if [ "$MODE" = "server" ] || [ "$MODE" = "both" ]; then
    log "[$region] Uploading WASM pkg..."
    ssh $SSH_OPTS "$server" "mkdir -p $REMOTE_DIR/services/prover/wasm/pkg"
    scp $SSH_OPTS "$PROJECT_ROOT/services/prover/wasm/pkg/chickenz_wasm_bg.wasm" "$server:$REMOTE_DIR/services/prover/wasm/pkg/"
    scp $SSH_OPTS "$PROJECT_ROOT/services/prover/wasm/pkg/chickenz_wasm.js" "$server:$REMOTE_DIR/services/prover/wasm/pkg/"
    scp $SSH_OPTS "$PROJECT_ROOT/services/prover/wasm/pkg/chickenz_wasm.d.ts" "$server:$REMOTE_DIR/services/prover/wasm/pkg/"
  fi

  if [ "$MODE" = "server" ] || [ "$MODE" = "both" ] || [ "$MODE" = "prover" ]; then
    log "[$region] Building prover binary..."
    ssh $SSH_OPTS "$server" "source ~/.cargo/env && cd $REMOTE_DIR/services/prover && cargo build -p chickenz-host --release --features boundless 2>&1 | tail -5"
  fi

  if [ "$MODE" = "server" ] || [ "$MODE" = "both" ]; then
    log "[$region] Restarting server..."
    ssh $SSH_OPTS "$server" "kill \$(lsof -ti:3000) 2>/dev/null || true; sleep 0.5; cd $REMOTE_DIR && set -a && source .env && set +a && nohup bun run services/server/src/index.ts > /tmp/chickenz-server.log 2>&1 & sleep 2; if lsof -ti:3000 > /dev/null 2>&1; then echo 'SERVER UP'; else echo 'FAILED'; cat /tmp/chickenz-server.log; exit 1; fi"
  fi

  log "[$region] Done."
}

# --- Build client locally (servers can't — no pnpm/npx) ---

if [ "$MODE" = "client" ] || [ "$MODE" = "both" ]; then
  log "Building client locally..."
  "$PROJECT_ROOT/apps/client/node_modules/.bin/vite" build "$PROJECT_ROOT/apps/client" 2>&1 | tail -3
fi

# --- Deploy to target servers ---

TARGETS=$(get_targets)
for target in $TARGETS; do
  deploy_to_server "$target"
done

log "Deploy complete! Regions: $TARGETS"
