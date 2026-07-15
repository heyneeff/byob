#!/bin/bash
# make-beta.sh — publish a branch (default: dev) as a parallel app at /beta.
#
# Why a subfolder and not a second domain: localStorage is per-ORIGIN, and
# calibration (byob_device_latency), identity (byob_local_user), and relay
# selection (byob_server) all live there. boombox.productions/beta/ shares all
# of that with the stable root app — phones keep their learned state when they
# switch builds. A separate domain would wipe it (the LAN-origin greenhorn
# problem, TUNING_LOG "per-origin calibration wipes").
#
# Root files are untouched: main's root = stable build, /beta = dev snapshot.
# The shim's /relay.json fetch is absolute-path, so beta pages discover the
# same relay; artist.html builds its listener QR link from its own path, so a
# beta DJ page invites phones into the beta listener automatically.
#
# Usage: ./make-beta.sh [branch]     then: git add beta && commit && push
set -euo pipefail
cd "$(dirname "$0")"
BRANCH="${1:-dev}"
SHA=$(git rev-parse --short "$BRANCH")

# The app's runtime closure (script srcs + module imports of the four pages).
FILES="listener.html artist.html debug.html byob-shim.js orchestra.js spatial-routing.js sync/ternary-engine.js sync/sync-engine.js ternary/layer.js ternary/arp.js ternary/orchid.js ternary/overlay.html"

rm -rf beta && mkdir -p beta
git archive "$BRANCH" -- $FILES | tar -x -C beta

# Stamp the build id so hud rows / overlay cards show which build a phone runs
# (honest A/B attribution — beta and stable phones share zones and telemetry).
sed -i '' "s/build: 'listener',/build: 'beta-$SHA',/" beta/listener.html
sed -i '' "s/'listener+ternary'/'beta-ternary-$SHA'/" beta/ternary/layer.js

echo "beta/ built from $BRANCH @ $SHA"
