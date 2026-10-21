#!/usr/bin/env bash
# Deploy plaid-actual-sync and updated configs to the WSL server
set -euo pipefail

SSH_HOST="wsl"
REMOTE_NODE_DOMAIN="desktop-llug1se.tail74237a.ts.net"

echo "==> 1. Checking git status..."
if [[ -n "$(git status --porcelain)" ]]; then
  echo "You have uncommitted or unpushed changes locally."
  read -rp "Commit and push to origin/main now? [Y/n] " response
  response=${response:-Y}
  if [[ "$response" =~ ^[Yy]$ ]]; then
    git add .
    git commit -m "Deploy: sync configs, caddy, and plaid-actual-sync"
    git push origin main
  else
    echo "Aborting. Please push your changes before pulling on WSL."
    exit 1
  fi
else
  # Ensure remote is up to date
  git push origin main 2>/dev/null || true
fi

echo "==> 2. Finding homelab directory on WSL ($SSH_HOST)..."
REMOTE_DIR=$(ssh "$SSH_HOST" '
  if [ -d "$HOME/eho-homelab-server" ]; then
    echo "$HOME/eho-homelab-server"
  elif [ -d "$HOME/dev/eho-homelab-server" ]; then
    echo "$HOME/dev/eho-homelab-server"
  else
    echo "$HOME/eho-homelab-server"
  fi
')
echo "    Remote path: $REMOTE_DIR"

echo "==> 3. Preparing remote directories and copying secrets (.env)..."
ssh "$SSH_HOST" "mkdir -p '$REMOTE_DIR/apps/plaid-actual-sync' '$REMOTE_DIR/plaid-sync/data'"

# Copy .env
scp apps/plaid-actual-sync/.env "$SSH_HOST:$REMOTE_DIR/apps/plaid-actual-sync/.env"

# Adjust PUBLIC_URL on WSL if it still points to the macbook
ssh "$SSH_HOST" "sed -i 's|erics-macbook-air\.tail74237a\.ts\.net|${REMOTE_NODE_DOMAIN}|g' '$REMOTE_DIR/apps/plaid-actual-sync/.env'"

echo "==> 4. Pulling latest code and building containers on WSL..."
ssh -t "$SSH_HOST" "bash -l -c '
  cd \"$REMOTE_DIR\"
  git pull
  docker compose up -d --build plaid-sync caddy
  if [ -x ./scripts/apply-serve.sh ]; then
    ./scripts/apply-serve.sh || true
  fi
'"

echo
echo "==> Deployment complete!"
echo "Dashboard is available at: https://${REMOTE_NODE_DOMAIN}:9444"
