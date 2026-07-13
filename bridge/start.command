#!/bin/bash
# BYOB Bridge launcher — double-click from Finder or run ./start.command
# Boots the self-hosted relay (backend: rows + realtime + clock + audio),
# a Cloudflare quick tunnel so phones can reach it, then the Link bridge.
cd "$(dirname "$0")"

# 1. Relay (skip if already running)
if ! curl -sf http://localhost:3100/health >/dev/null 2>&1; then
  node relay.mjs &
  RELAY_PID=$!
  trap 'kill $RELAY_PID 2>/dev/null' EXIT
  for i in $(seq 1 20); do curl -sf http://localhost:3100/health >/dev/null 2>&1 && break; sleep 0.25; done
fi
echo "relay: http://localhost:3100"

# 2. Tunnel for phones (optional — needs cloudflared: brew install cloudflared)
if command -v cloudflared >/dev/null 2>&1; then
  TUNNEL_LOG=$(mktemp)
  cloudflared tunnel --url http://localhost:3100 >"$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  trap 'kill $RELAY_PID $TUNNEL_PID 2>/dev/null' EXIT
  for i in $(seq 1 40); do
    TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1)
    [ -n "$TUNNEL_URL" ] && break; sleep 0.5
  done
  if [ -n "$TUNNEL_URL" ]; then
    # Publish the tunnel URL to GitHub Pages: phones just open the site and
    # byob-shim.js reads /relay.json — no QR, no params, geofence does the rest.
    printf '{"relay":"%s","ts":"%s"}\n' "$TUNNEL_URL" "$(date -u +%FT%TZ)" > ../relay.json
    if [ -n "$(git -C .. status --porcelain relay.json)" ]; then
      git -C .. add relay.json \
        && git -C .. commit -q -m "relay: publish tunnel URL" \
        && git -C .. push -q origin main \
        && PUBLISHED="yes" || PUBLISHED="push failed"
    else
      PUBLISHED="unchanged"
    fi
    echo "╔════════════════════════════════════════════════════════╗"
    echo "  RELAY TUNNEL: $TUNNEL_URL"
    echo "  Published to boombox.productions/relay.json: $PUBLISHED"
    echo "  (Pages deploys in ~1 min — then phones just open the site)"
    echo "╚════════════════════════════════════════════════════════╝"
  else
    echo "WARNING: tunnel did not come up — phones limited to LAN. Log: $TUNNEL_LOG"
  fi
else
  echo "NOTE: cloudflared not installed — phones can't reach the relay from"
  echo "      cellular. Install once with: brew install cloudflared"
fi

# 3. Bridge UI + Ableton Link (bridge shows the phone join link + QR)
open "http://localhost:3000" 2>/dev/null || true
BYOB_TUNNEL_URL="${TUNNEL_URL:-}" exec node bridge.mjs
