#!/usr/bin/env bash
# Apply this node's Tailscale Serve configuration.
#
# `tailscale serve` state lives on the host, not in this repo, and it is lost
# on tailnet re-auth or on a fresh machine. This script makes it reproducible:
# it reads the node's own MagicDNS name and installs the four listeners that
# map the tailnet's HTTPS ports onto Caddy's loopback ports.
#
# Idempotent: it resets the serve config and reapplies it from scratch, so it
# is safe to run repeatedly and is the repair step when a cert or route breaks.
#
# Usage:
#   scripts/apply-serve.sh          # apply
#   scripts/apply-serve.sh --status # print current config and exit
#
# Requires: tailscale CLI on PATH, logged in, and the caddy container running.

set -euo pipefail

# Tailnet HTTPS port : Caddy loopback port.
# Keep in sync with the `caddy` service ports in docker-compose.yml.
ROUTES=(
  "443:8080"   # homepage
  "444:8081"   # actual-server
  "8444:8082"  # audiobookshelf
  "9444:8083"  # plaid-sync
)

if ! command -v tailscale >/dev/null 2>&1; then
  echo "error: tailscale CLI not found on PATH" >&2
  exit 1
fi

# Confirm the CLI is actually authenticated; a logged-out CLI fails later with
# a much less obvious error.
if ! tailscale status --json >/dev/null 2>&1; then
  echo "error: not logged in to a tailnet (run 'tailscale up')" >&2
  exit 1
fi

if [[ "${1:-}" == "--status" ]]; then
  tailscale serve status
  exit 0
fi

echo "Applying Tailscale Serve config for this node."

# Reset first so a removed route cannot survive as orphaned host state.
tailscale serve reset >/dev/null 2>&1 || true

for route in "${ROUTES[@]}"; do
  https_port="${route%%:*}"
  caddy_port="${route##*:}"

  echo "  :${https_port} -> http://127.0.0.1:${caddy_port}"
  if ! tailscale serve --bg "--https=${https_port}" "http://127.0.0.1:${caddy_port}" >/dev/null 2>&1; then
    echo "error: failed to bind :${https_port}" >&2
    echo "       is another process already listening on that port?" >&2
    exit 1
  fi
done

dns_name="$(tailscale status --json | sed -n 's/.*"DNSName":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 | sed 's/\.$//')"

echo
echo "Done. Tailnet URLs for this node (${dns_name:-unknown}):"
for route in "${ROUTES[@]}"; do
  https_port="${route%%:*}"
  printf '  https://%s:%s\n' "${dns_name:-<node>}" "${https_port}"
done
printf '  https://%s            (homepage, default port)\n' "${dns_name:-<node>}"

cat <<'EOF'

Verify with:
  scripts/apply-serve.sh --status
  curl -sS -o /dev/null -w '%{http_code}\n' https://<node>.ts.net

If a request still returns the old self-signed certificate, Docker is still
publishing a port on 0.0.0.0 that Serve needs to bind. Check with:
  docker compose ps caddy
EOF