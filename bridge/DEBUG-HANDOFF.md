# Bridge UI debug handoff — 2026-07-06 evening

## Symptom
Bridge UI at http://localhost:3000 shows "— pick zone —", BPM "—", no beat
ticking, 0 phones — in Safari (regular AND private window, hard-refreshed).

## Verified facts (do not re-derive)
- The bridge PROCESS is fully healthy. A direct Node WS client to
  ws://localhost:3001 receives `state` (with zoneId), `zones` (with the zone),
  and `beat_tick` at 10Hz. HTTP :3000 serves 200 with the current UI file.
- The UI file served IS current (screenshot shows the new Zone Offset section).
- BPM stuck at "—" means the browser receives ZERO WS messages — beat_tick
  alone would update it 10×/s. So Safari's WebSocket to :3001 is not
  delivering. Everything downstream (zone picker, phones) starves from that.
- The zone exists and is ACTIVE (re-activated 2026-07-06 ~17:20); the bridge
  terminal logs `[zones] auto-connected → "Unnamed Zone"`.

## Hypothesis (test first)
Safari restriction on insecure ws:// to localhost on a nonstandard port
(and/or Local Network privacy). **Test: open http://localhost:3000 in
Chrome.** If Chrome works, either document "use Chrome" or serve the WS on
the same port as HTTP (single-port upgrade via the existing `ws` package —
`new WebSocketServer({ server: http })` and `const WS = ws://${location.host}`)
which removes the cross-port issue entirely. That single-port change is the
proper fix regardless.

## Recent bridge changes (all pushed, commits eb1e4bd..cf770e4 range)
- Bar-quantized scheduled launches (`computeLaunchAt`, min 2.5s lead)
- Never re-anchor from Link's absolute beat (oracle 3.2→60)
- Auto-connect to the single active zone (startup + every 10s)
- Zones listed even when inactive; selecting one activates it
- Zone Offset knob (zone_offset_ms → syncedNow() choke point on listeners)
- start.command double-click launcher
- Stale-process gotcha: EADDRINUSE on :3001 means an old bridge is squatting —
  `pkill -f "node bridge.mjs"` first. Consider adding self-kill on startup.

## Session context
Full day's record: sync/TUNING_LOG.md "2026-07-06 session", SYNC_ENGINE.md,
Obsidian note "BYOB Synced Entry". Oracle protocol per repo CLAUDE.md (cast
via `iching` before engine changes).
