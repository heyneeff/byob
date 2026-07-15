#!/bin/bash
# BYOB Bridge launcher — double-click from Finder or run ./start.command
# Boots the watchdog (which owns the relay + Cloudflare tunnel and keeps
# both alive for the whole show — respawn on crash, tunnel rotation +
# relay.json republish on silent tunnel death), then the Link bridge.
#
# The relay and tunnel are spawned DETACHED by the watchdog: closing this
# terminal or Ctrl-C'ing the bridge no longer kills the backend (the old
# trap/process-group coupling took the relay down with every bridge
# restart — observed live 2026-07-14).
cd "$(dirname "$0")"

# 1. Watchdog (idempotent: relay/tunnel checks are health-based, so a
#    second launch won't double-spawn anything healthy)
if ! pgrep -f "node watchdog.mjs" >/dev/null 2>&1; then
  nohup node watchdog.mjs >> watchdog.log 2>&1 &
  echo "watchdog: started (logs: bridge/watchdog.log, relay.log, tunnel.log)"
else
  echo "watchdog: already running"
fi

# 2. Wait for the relay, then report the published tunnel
for i in $(seq 1 40); do curl -sf http://localhost:3100/health >/dev/null 2>&1 && break; sleep 0.5; done
echo "relay: http://localhost:3100"
TUNNEL_URL=$(python3 -c "import json;print(json.load(open('../relay.json'))['relay'])" 2>/dev/null)
if [ -n "$TUNNEL_URL" ]; then
  echo "╔════════════════════════════════════════════════════════╗"
  echo "  RELAY TUNNEL: $TUNNEL_URL"
  echo "  (watchdog probes it end-to-end every 60s and rotates +"
  echo "   republishes relay.json if it dies — phones re-resolve)"
  echo "╚════════════════════════════════════════════════════════╝"
else
  echo "tunnel: pending — watchdog is allocating one (see bridge/watchdog.log)"
fi

# 3. Bridge UI + Ableton Link (bridge shows the phone join link + QR)
open "http://localhost:3000" 2>/dev/null || true
BYOB_TUNNEL_URL="${TUNNEL_URL:-}" exec node bridge.mjs
