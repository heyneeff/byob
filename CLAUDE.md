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
| `debug.html` | Sync Dashboard — dev tool that subscribes to `hud_data` broadcasts and displays GPS/sync health per listener |
| `organismvisualizer.html` | Standalone Signal Organism prototype (canvas visualizer, not yet integrated) |
| `dj.html` | **Legacy — do not edit.** Absorbed into `playmin.html`. |
| `play.html` | **Legacy — do not edit.** Earlier version of the DJ engine. |
| `index.html` | Meta-redirect to `listener.html` |
| `Roadmap` | Product vision, open bugs, queued features, session log |

## Architecture

### Backend: Supabase
Single Supabase project (`ohacvuwzvuifpyqckise.supabase.co`) used for auth, database, realtime, and file storage. Both `listener.html` and `playmin.html` hard-code the same `SUPABASE_URL` and `SUPABASE_ANON_KEY` at the top of their `<script>` blocks. Auth is shared — one login works everywhere.

### Database tables
- **`zones`** — `id, name, host_id, lat, lng, radius_m, active, listeners, tip_url, current_track_url, track_name, playback_started_at, play_at, play_from_s, zone_tracks, last_message, last_message_at`
- **`tracks`** — `id, user_id, zone_id, title, file_path, public_url, created_at`
- **`events`** — `id, name, artists, description, event_start, location_reveal_at, lat, lng, radius_m, zone_id, created_by`
- **`profiles`** — user profile data (extended for Carnival Society membership)

Storage bucket: **`boombox`** — track audio files uploaded as `boombox/{filename}`.

### Realtime channel naming convention
- `presence_{zone_id}` — listener GPS presence (bearing, dist, status, slot)
- `sync_{zone_id}` — DJ → listener sync commands (`hard_sync`, `sweep_start`, `sweep_stop`, `scatter`, `zone_update`)
- `zone_{zone_id}` — zone metadata updates
- `webrtc_{zone_id}` — WebRTC signaling for live mic streaming (offer/answer/ice)

### GPS / geofence flow (listener)
`watchPosition` runs a single loop (one instance only — duplicate loops were a prior bug). On each position fix, bearing and distance to the active zone center are computed. If inside the geofence, audio unlocks. The listener broadcasts its presence payload every 2s via the `presence_{zone_id}` channel. `syncZoneAudio()` must select `lat,lng,radius_m` from Supabase or bearing/dist return NaN (fixed bug — don't regress).

### Server clock sync
All playback timing uses `syncedNow()` (not `Date.now()`). At startup, `_clockOffset` is computed by comparing local time to a Supabase server timestamp: `_clockOffset = serverMs - (t0 + (t1-t0)/2)`. Then `syncedNow() = Date.now() + _clockOffset`. Never use raw `Date.now()` for computing playback position.

### Sync / audio timing (listener)
The zone stores three fields for timing: `playback_started_at` (ISO wall-clock when playback began), `play_at` (epoch ms for scheduled future play), and `play_from_s` (seek offset in seconds). Listener seek position is computed as:

```
seekTo = elapsed + _calOffset - (_deviceLatencyMs / 1000) + SEEK_STAB_S - (_scatterOffsetMs / 1000)
```

Per-device calibration offset (`_calOffset`) is persisted in `localStorage('byob_cal_offset')`. `hard_sync` events from the DJ reset playback position. Scatter mode (`scatter` event) staggers listener start times across voices to create spatial audio effects. The `_panNode` / `_audioCtx` Web Audio nodes handle panning.

### WebRTC live streaming
When the DJ taps "Go Live," `current_track_url` is set to `'webrtc-live'` on the zone. Listeners detect this value and call `joinWebRTCStream()` instead of loading a file. ICE servers are fetched from `boombox.metered.live` with STUN fallback (`stun:stun.l.google.com:19302`). Signaling flows through the `webrtc_{zone_id}` Supabase realtime channel.

### SpatialOrchestra (`orchestra.js`)
A canvas-based radar drawn in `playmin.html`'s Spatial panel. Reads `window.liveListeners` and `window.activeZone` to position listener dots by bearing and distance. The sweep beam is driven by drag velocity or `startSweep(rpm, dir)`. Snap (center tap) broadcasts `hard_sync` to all listeners via `window._djSyncChannel`.

### Zone slots (C, 1–4)
The DJ assigns tracks to zone slots (Center + 4 spatial clusters). Listener slot assignment determines pan position. Slot routing on the listener side (select which slot to hear) is a queued feature not yet built. `zone_tracks` is a JSON column on the `zones` table storing the slot→track-url mapping.

## Invariants — do not regress
- `bearing: 0` (due north) must not be treated as falsy — use `if (l.dist == null)` not `if (!l.bearing)`
- `setInterval(sendPresence)` must live outside the subscription callback — recreating it on reconnect stacks intervals
- `syncZoneAudio()` select query must include `lat,lng,radius_m`
- All playback position math must use `syncedNow()` (listener) / `serverNow()` (DJ), never raw `Date.now()`. Local relative timers (presence prune, animation, file path naming) stay on `Date.now()`.
- DJ dot bearing is hardcoded to 0 in `startDJPresenceBroadcast` — open bug, DJ always appears due north

## Design principle: listener simplicity
`listener.html` must stay minimal and frictionless. Never expose slot selection, zone routing, or spatial audio controls to the listener — those are DJ tools in `playmin.html`. Any spatial mechanic that requires listener-side code (e.g. sweep receive, auto-pan) runs silently with no UI.

## Queued features (build order from Roadmap)
1. Event delete from playmin UI
2. Slot Routing 1/2/3/4 (listener side) + Signal Organism Visualizer
3. 3D sweep receive on listener side (silent background mechanic — no UI)
4. Profiles + follow system
5. Front page event discovery
6. Stripe Connect + ticketing (geofence = ticket validation)
7. The Circle (Carnival Society) on shared Supabase backend
8. Push notifications
