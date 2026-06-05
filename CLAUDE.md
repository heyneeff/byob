# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

BYOB is a mobile-first, no-infrastructure party platform. Attendees use their phones as Bluetooth speakers that sync to a DJ's live stream. The DJ draws a GPS geofence ("zone") — being inside it is the ticket. No build tools, no bundler, no npm. Edit HTML files directly and push to GitHub Pages.

## Development

There is no build step. Open files directly in a browser or use any local HTTP server:

```bash
python3 -m http.server 8080
# or
npx serve .
```

Deploy by pushing to `main` — GitHub Pages serves automatically via the `CNAME` record.

## File roles

| File | Role |
|------|------|
| `listener.html` | Listener app — GPS, audio playback, geofence entry, spatial pan, presence |
| `playmin.html` | DJ engine — zone creation, live stream, sync broadcast, crowd view, deck |
| `orchestra.js` | Shared `SpatialOrchestra` class — the radar canvas with sweep beam and listener dots |
| `dj.html` | **Legacy — do not edit.** Absorbed into `playmin.html`. |
| `index.html` | Meta-redirect to `listener.html` |
| `Roadmap` | Product vision, open bugs, queued features, session log |

## Architecture

### Backend: Supabase
Single Supabase project (`ohacvuwzvuifpyqckise.supabase.co`) used for auth, database, and realtime. Both `listener.html` and `playmin.html` hard-code the same `SUPABASE_URL` and `SUPABASE_ANON_KEY` at the top of their `<script>` blocks. Auth is shared — one login works everywhere.

### Realtime channel naming convention
- `presence_{zone_id}` — listener GPS presence (bearing, dist, status, slot)
- `sync_{zone_id}` — DJ → listener sync commands (`hard_sync`, `sweep_start`, `sweep_stop`, `scatter`, `zone_update`)
- `zone_{zone_id}` — zone metadata updates

### GPS / geofence flow (listener)
`watchPosition` runs a single loop (one instance only — duplicate loops were a prior bug). On each position fix, bearing and distance to the active zone center are computed. If inside the geofence, audio unlocks. The listener broadcasts its presence payload every 2s via the `presence_{zone_id}` channel. `syncZoneAudio()` must select `lat,lng,radius_m` from Supabase or bearing/dist return NaN (fixed bug — don't regress).

### Sync / audio timing (listener)
Playback offset is calculated from `playback_started_at` (stored on the zone). `hard_sync` events from the DJ reset the offset. Scatter mode staggers playback start times across listeners to create spatial audio effects. The `_panNode` / `_audioCtx` Web Audio nodes handle panning; `applySweepEvent` (queued feature, not yet built) will hook into these.

### SpatialOrchestra (`orchestra.js`)
A canvas-based radar drawn in `playmin.html`'s Spatial panel. Reads `window.liveListeners` and `window.activeZone` to position listener dots by bearing and distance. The sweep beam is driven by drag velocity or `startSweep(rpm, dir)`. Snap (center tap) broadcasts `hard_sync` to all listeners via `window._djSyncChannel`.

### Zone slots (C, 1–4)
The DJ assigns tracks to zone slots (Center + 4 spatial clusters). Listener slot assignment determines pan position. Slot routing on the listener side (select which slot to hear) is a queued feature not yet built.

## Open bugs (do not regress)
- `bearing: 0` (due north) must not be treated as falsy — use `if (l.dist == null)` not `if (!l.bearing)`
- `setInterval(sendPresence)` must live outside the subscription callback — recreating it on reconnect stacks intervals
- `syncZoneAudio()` select query must include `lat,lng,radius_m`

## Design principle: listener simplicity
`listener.html` must stay minimal and frictionless. Never expose slot selection, zone routing, or spatial audio controls to the listener — those are DJ tools in `playmin.html`. Any spatial mechanic that requires listener-side code (e.g. sweep receive, auto-pan) runs silently with no UI.

## Queued features (build order from Roadmap)
1. Event delete from playmin UI
2. Signal Organism Visualizer (replace bar viz with canvas organism)
3. 3D sweep receive on listener side (silent background mechanic — no UI)
4. Profiles + follow system
5. Front page event discovery
6. Stripe Connect + ticketing (geofence = ticket validation)
7. The Circle (Carnival Society) on shared Supabase backend
