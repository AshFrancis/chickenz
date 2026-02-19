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

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[deploy]${NC} $1"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $1"; }
err() { echo -e "${RED}[deploy]${NC} $1" >&2; }

# Determine what to deploy
MODE="${1:-auto}"

if [ "$MODE" = "auto" ]; then
  # Check what files changed in the last commit
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
    # Default: deploy both if we can't tell
    MODE="both"
  fi
  log "Auto-detected: deploying ${MODE}"
fi

# Verify SSH connection
log "Connecting to server..."
ssh $SSH_OPTS $SERVER "echo ok" > /dev/null 2>&1 || {
  err "Cannot connect to $SERVER"
  exit 1
}

# Pull latest code
log "Pulling latest code..."
ssh $SSH_OPTS $SERVER "cd $REMOTE_DIR && git pull origin main" 2>&1

# Ensure bun is available
ssh $SSH_OPTS $SERVER "source ~/.bashrc && which bun > /dev/null 2>&1" || {
  warn "Bun not found, installing..."
  ssh $SSH_OPTS $SERVER "curl -fsSL https://bun.sh/install | bash" 2>&1
}

# Build client if needed
if [ "$MODE" = "client" ] || [ "$MODE" = "both" ]; then
  log "Building client..."
  ssh $SSH_OPTS $SERVER "source ~/.bashrc && cd $REMOTE_DIR && bun run --filter @chickenz/client build 2>&1 && cp -r apps/client/dist/* services/server/public/"
  log "Client built and copied to server/public/"
fi

# Restart server if needed
if [ "$MODE" = "server" ] || [ "$MODE" = "both" ] || [ "$MODE" = "client" ]; then
  # Always restart server — it serves the client too
  log "Restarting server..."
  ssh $SSH_OPTS $SERVER "source ~/.bashrc && cd $REMOTE_DIR && ln -sfn $REMOTE_DIR/packages/sim node_modules/@chickenz/sim && fuser -k 3000/tcp 2>/dev/null || true; sleep 1 && nohup bun run services/server/src/index.ts > /tmp/chickenz-server.log 2>&1 &"
  sleep 2
  # Verify it started
  RUNNING=$(ssh $SSH_OPTS $SERVER "cat /tmp/chickenz-server.log 2>/dev/null | tail -1")
  if echo "$RUNNING" | grep -q "running"; then
    log "Server is up!"
  else
    err "Server may have failed to start. Log:"
    ssh $SSH_OPTS $SERVER "cat /tmp/chickenz-server.log 2>/dev/null"
    exit 1
  fi
fi

log "Deploy complete (${MODE})! http://178.156.244.26:3000"
