# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

BYOB is a mobile-first, no-infrastructure party platform. Attendees use their phones as Bluetooth speakers that sync to a DJ's live stream. The DJ draws a GPS geofence ("zone") — being inside it is the ticket. No build tools, no bundler, no npm. Edit HTML files directly and push to GitHub Pages.

## Development

No build step. Open files directly in a browser or serve locally:

```bash
python3 -m http.server 8080
```

Deploy: push to `main` — GitHub Pages serves automatically via the `CNAME` record.

## File roles

| File | Role |
|------|------|
| `listener.html` | Listener app — GPS, audio playback, geofence entry, spatial pan, presence |
| `playmin.html` | DJ engine — zone creation, live stream, sync broadcast, crowd view, deck |
| `orchestra.js` | Shared `SpatialOrchestra` class — radar canvas with sweep beam and listener dots |
| `debug.html` | Sync dashboard — subscribes to `hud_data` broadcasts, shows GPS/sync health per listener |
| `organismvisualizer.html` | Standalone Signal Organism prototype (canvas visualizer, not yet integrated) |
| `dj.html` | **Legacy — do not edit.** Absorbed into `playmin.html`. |
| `play.html` | **Legacy — do not edit.** Earlier version of the DJ engine. |
| `index.html` | Meta-redirect to `listener.html` |
| `Roadmap` | Product vision, open bugs, queued features, session log |

## Architecture

### Backend: Supabase
Single Supabase project (`ohacvuwzvuifpyqckise.supabase.co`) for auth, database, realtime, and file storage. `SUPABASE_URL` and `SUPABASE_ANON_KEY` are hard-coded at the top of each file's `<script>` block. Auth is shared — one login works everywhere.

### Database tables
- **`zones`** — `id, name, host_id, lat, lng, radius_m, active, listeners, tip_url, current_track_url, track_name, playback_started_at, play_at, play_from_s, zone_tracks, last_message, last_message_at`
- **`tracks`** — `id, user_id, zone_id, title, file_path, public_url, created_at`
- **`events`** — `id, name, artists, description, event_start, location_reveal_at, lat, lng, radius_m, zone_id, created_by`
- **`profiles`** — user profile data (extended for Carnival Society membership)

Storage bucket: **`boombox`** — track audio files uploaded as `boombox/{filename}`.

### Realtime channel naming convention
- `presence_{zone_id}` — listener GPS presence (bearing, dist, status, slot); DJ also broadcasts here via a separate channel subscription
- `sync_{zone_id}` — DJ → listener sync commands (`hard_sync`, `sweep_start`, `sweep_stop`, `scatter`, `zone_update`, `cluster_assign`, `spatial_config`)
- `zone_{zone_id}` — zone metadata updates
- `webrtc_{zone_id}` — WebRTC signaling for live mic streaming (offer/answer/ice)

### GPS / geofence flow (listener)
`watchPosition` runs a single loop (one instance only — duplicate loops were a prior bug). On each position fix, bearing and distance to the active zone center are computed. If inside the geofence, audio unlocks. The listener broadcasts its presence payload every 2s via the `presence_{zone_id}` channel. `syncZoneAudio()` must select `lat,lng,radius_m` from Supabase or bearing/dist return NaN.

### Server clock sync
All playback timing uses `syncedNow()` (listener) / `serverNow()` (DJ) — never raw `Date.now()`. `_clockOffset` is computed via `measureClockOffset()` by calling `db.rpc('now')` and comparing round-trip timestamps. Called at boot, every 60s, and fresh at zone entry. Local relative timers (presence prune, animation loops, file path naming) stay on `Date.now()`.

### Sync / audio timing (listener)
The zone stores: `playback_started_at` (ISO wall-clock), `play_at` (epoch ms for scheduled play), `play_from_s` (seek offset). Seek position:
```
seekTo = elapsed + _calOffset - (_deviceLatencyMs / 1000) + SEEK_STAB_S - (_scatterOffsetMs / 1000)
```
`_calOffset` is persisted in `localStorage('byob_cal_offset')`. `hard_sync` events reset playback. Scatter mode staggers listener start times for spatial effect.

### WebRTC live streaming
DJ taps "Go Live" → `current_track_url` set to `'webrtc-live'` on the zone. Listeners detect this and call `joinWebRTCStream()` instead of loading a file. ICE servers from `boombox.metered.live` with STUN fallback. Signaling via `webrtc_{zone_id}` channel.

### Zone slots (dynamic, C + 1–N)
DJ assigns tracks to zone slots. Slot count is dynamic: always has Center (C) plus numbered slots starting at 4, expandable via `+ STEM` / `−` buttons in the spatial panel. Key functions: `getSlotKeys()`, `slotColor(key)`, `addSlot()`, `removeSlot()`. `SLOT_PALETTE` holds 12 colors cycling by slot number. `zone_tracks` is a JSON column on `zones` storing slot→track-url mapping.

### Spatial modes (DJ side, `playmin.html`)
- **Single** — all listeners get Center (C) track
- **Cluster** — k-means by GPS proximity, assigns stem slots, recomputes every 30s
- **Ring** — concentric rings by distance from zone center, inner = C
- **Sweep** — circular sweep beam with staggered playback offset per bearing
- **Scatter** — staggers start times across voices for chorus effect
- **Movement** — auto-cycles stem assignments via wave/pulse/orbit/swing patterns

All modes broadcast `cluster_assign` via `sync_{zone_id}` with `{listenerId → slotKey}` map + `zone_tracks`.

### Listener slot assignment (`listener.html`)
`getSpatialSlot()` does bearing-quadrant self-assignment as fallback. DJ-broadcast `cluster_assign` events override this by directly mapping `payload.assignments[myId]` to a slot key.

### Spatial map (DJ side)
Leaflet map in the Spatial panel (`sp-spatial-map`). `renderSpatialDots()` runs every 2s. DJ dot rendered directly from `userLat/userLng` as a permanent `__dj__` marker — does NOT depend on presence echo. Listener dots read from `liveListeners` (keyed by listener ID). `isDJ` flag is preserved in `liveListeners` entries and filtered out of cluster/ring/movement slot assignments.

### SpatialOrchestra (`orchestra.js`)
Canvas-based radar in `playmin.html`'s Spatial panel. Reads `window.liveListeners` and `window.activeZone`. Sweep beam driven by drag velocity or `startSweep(rpm, dir)`. Center tap broadcasts `hard_sync` via `window._djSyncChannel`.

## Invariants — do not regress
- `bearing: 0` (due north) must not be treated as falsy — use `if (l.dist == null)` not `if (!l.bearing)`
- `setInterval(sendPresence)` must live outside the subscription callback — recreating it on reconnect stacks intervals
- `syncZoneAudio()` select query must include `lat,lng,radius_m`
- All playback position math uses `syncedNow()` (listener) / `serverNow()` (DJ), never raw `Date.now()`
- `measureClockOffset()` must be awaited before `seekToSync()` runs at zone entry
- DJ dot uses `window._spDotMarkers['__dj__']` and is never keyed through `liveListeners`
- Supabase does not echo broadcasts back to the sender — never rely on self-delivery for state

## Design principle: listener simplicity
`listener.html` must stay minimal and frictionless. Never expose slot selection, zone routing, or spatial audio controls to the listener — those are DJ tools in `playmin.html`. Any spatial mechanic (sweep receive, auto-pan, cluster assignment) runs silently with no listener UI.

## Queued features (build order from Roadmap)
1. Slot Routing 1/2/3/4 (listener side) + Signal Organism Visualizer
2. 3D sweep receive on listener side (silent — no UI)
3. Profiles + follow system
4. Front page event discovery
5. Stripe Connect + ticketing (geofence = ticket validation)
6. The Circle (Carnival Society) on shared Supabase backend
7. Push notifications
