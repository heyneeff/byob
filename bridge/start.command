#!/bin/bash
# BYOB Bridge launcher — double-click from Finder or run ./start.command
cd "$(dirname "$0")"
open "http://localhost:3000" 2>/dev/null || true
exec node bridge.mjs
