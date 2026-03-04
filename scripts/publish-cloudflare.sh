#!/usr/bin/env bash
set -euo pipefail

# Publish Coldbones behind a named Cloudflare Tunnel and bind a DNS hostname.
#
# Usage:
#   ./scripts/publish-cloudflare.sh <hostname> [service-url] [tunnel-name]
#
# Example:
#   ./scripts/publish-cloudflare.sh app.example.com http://localhost:5173 coldbones

HOSTNAME="${1:-}"
SERVICE_URL="${2:-http://localhost:5173}"
TUNNEL_NAME="${3:-coldbones}"

if [[ -z "$HOSTNAME" ]]; then
  echo "Usage: $0 <hostname> [service-url] [tunnel-name]"
  exit 1
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Error: required command not found: $1"
    exit 1
  }
}

require_cmd cloudflared

if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
  echo "You are not authenticated with Cloudflare yet."
  echo "Run: cloudflared tunnel login"
  exit 1
fi

if ! cloudflared tunnel list | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
  echo "Creating tunnel: $TUNNEL_NAME"
  cloudflared tunnel create "$TUNNEL_NAME"
else
  echo "Using existing tunnel: $TUNNEL_NAME"
fi

TUNNEL_ID="$(cloudflared tunnel list | awk -v name="$TUNNEL_NAME" '$2==name {print $1; exit}')"
if [[ -z "$TUNNEL_ID" ]]; then
  echo "Error: failed to resolve tunnel ID for $TUNNEL_NAME"
  exit 1
fi

echo "Routing DNS: $HOSTNAME -> tunnel $TUNNEL_NAME"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME"

mkdir -p "$HOME/.cloudflared"
CONFIG_PATH="$HOME/.cloudflared/config-$TUNNEL_NAME.yml"

cat > "$CONFIG_PATH" <<EOF
tunnel: $TUNNEL_NAME
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: $HOSTNAME
    service: $SERVICE_URL
  - service: http_status:404
EOF

echo
echo "Cloudflare Tunnel configured."
echo "Config: $CONFIG_PATH"
echo "Start it with:"
echo "  cloudflared tunnel --config $CONFIG_PATH run"
