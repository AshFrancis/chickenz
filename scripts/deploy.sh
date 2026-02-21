#!/bin/bash
# Deploy to Hetzner server (178.156.244.26)
#
# Flow: build client locally → git push → git pull on server → scp client dist → restart
# Server has bun but not pnpm/npx, so client must be built locally.
#
# Usage:
#   ./scripts/deploy.sh          # full deploy (client + server + wasm)
#   ./scripts/deploy.sh client   # client-only (build + upload dist)
#   ./scripts/deploy.sh server   # server-only (git pull + restart)

set -euo pipefail

SERVER="root@178.156.244.26"
REMOTE_DIR="/root/chickenz"
SSH_OPTS="-o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[deploy]${NC} $1"; }
err() { echo -e "${RED}[deploy]${NC} $1" >&2; }

MODE="${1:-both}"

# --- Build client locally (server can't — no pnpm/npx) ---

if [ "$MODE" = "client" ] || [ "$MODE" = "both" ]; then
  log "Building client locally..."
  npx vite build "$PROJECT_ROOT/apps/client" 2>&1 | tail -3
fi

# --- Git pull on server to update server source + wasm ---

if [ "$MODE" = "server" ] || [ "$MODE" = "both" ]; then
  log "Git pull on server..."
  ssh $SSH_OPTS "$SERVER" "cd $REMOTE_DIR && git pull origin main 2>&1 | tail -3"
fi

# --- Upload pre-built client dist ---

if [ "$MODE" = "client" ] || [ "$MODE" = "both" ]; then
  log "Uploading client dist..."
  scp $SSH_OPTS -r "$PROJECT_ROOT/apps/client/dist/"* "$SERVER:$REMOTE_DIR/services/server/public/"
fi

# --- Upload WASM binary (built locally by wasm-pack) ---

if [ "$MODE" = "server" ] || [ "$MODE" = "both" ]; then
  log "Uploading WASM binary..."
  scp $SSH_OPTS "$PROJECT_ROOT/services/server/chickenz_wasm_bg.wasm" "$SERVER:$REMOTE_DIR/services/server/"
fi

# --- Restart server ---

log "Restarting server..."
ssh $SSH_OPTS "$SERVER" "kill \$(lsof -ti:3000) 2>/dev/null || true; sleep 0.5; cd $REMOTE_DIR && set -a && source .env && set +a && nohup bun run services/server/src/index.ts > /tmp/chickenz-server.log 2>&1 & sleep 2; if lsof -ti:3000 > /dev/null 2>&1; then echo 'SERVER UP'; else echo 'FAILED'; cat /tmp/chickenz-server.log; exit 1; fi"

log "Deploy complete! http://178.156.244.26:3000"
