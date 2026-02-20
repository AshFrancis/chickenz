#!/bin/bash
# Deploy to Hetzner server (178.156.244.26)
# Usage:
#   ./scripts/deploy.sh          # auto-detect what changed, deploy accordingly
#   ./scripts/deploy.sh client   # force client-only deploy
#   ./scripts/deploy.sh server   # force server-only deploy
#   ./scripts/deploy.sh both     # force full deploy

set -euo pipefail

SERVER="root@178.156.244.26"
REMOTE_DIR="/root/chickenz"
SSH_OPTS="-o ConnectTimeout=10 -o ServerAliveInterval=10"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[deploy]${NC} $1"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $1"; }
err() { echo -e "${RED}[deploy]${NC} $1" >&2; }

MODE="${1:-auto}"

if [ "$MODE" = "auto" ]; then
  CHANGED=$(git diff --name-only HEAD~1 HEAD 2>/dev/null || echo "")
  HAS_CLIENT=false
  HAS_SERVER=false

  echo "$CHANGED" | grep -q "^apps/client/" && HAS_CLIENT=true
  echo "$CHANGED" | grep -q "^packages/sim/" && HAS_CLIENT=true && HAS_SERVER=true
  echo "$CHANGED" | grep -q "^services/server/" && HAS_SERVER=true

  if $HAS_CLIENT && $HAS_SERVER; then
    MODE="both"
  elif $HAS_CLIENT; then
    MODE="client"
  elif $HAS_SERVER; then
    MODE="server"
  else
    MODE="both"
  fi
  log "Auto-detected: deploying ${MODE}"
fi

# Single SSH session: pull, build, restart — all in one command to avoid round-trips
log "Deploying (${MODE})..."

REMOTE_CMD="set -e; source ~/.bashrc; cd $REMOTE_DIR"
REMOTE_CMD="$REMOTE_CMD; echo '>>> git pull'; git pull origin main"

if [ "$MODE" = "client" ] || [ "$MODE" = "both" ]; then
  REMOTE_CMD="$REMOTE_CMD; echo '>>> building client'; bun run --filter @chickenz/client build 2>&1; cp -r apps/client/dist/* services/server/public/"
fi

# Always restart server (it serves the client too)
REMOTE_CMD="$REMOTE_CMD; echo '>>> restarting server'; ln -sfn $REMOTE_DIR/packages/sim node_modules/@chickenz/sim; systemctl restart chickenz; sleep 1; systemctl is-active chickenz && echo '>>> server is up' || (journalctl -u chickenz -n 10 --no-pager; exit 1)"

ssh $SSH_OPTS $SERVER "$REMOTE_CMD"

log "Deploy complete! http://178.156.244.26:3000"
