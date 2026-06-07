# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

BYOB is a mobile-first, no-infrastructure party platform. Attendees use their phones as Bluetooth speakers that sync to a DJ's live stream. The DJ draws a GPS geofence ("zone") — being inside it is the ticket. No build tools, no bundler, no npm. Edit HTML files directly and push to GitHub Pages.

## Development

No build step. Serve locally with:

```bash
python3 -m http.server 8080
```

Deploy: push to `main` — GitHub Pages serves automatically via the `CNAME` record.

## File roles

| File | Role |
|------|------|
| `listener.html` | Listener app — GPS, audio playback, geofence entry, spatial routing, fellowship/social |
| `playmin.html` | DJ engine — zone creation, live stream, sync broadcast, crowd view, deck, scenes |
| `orchestra.js` | Shared `SpatialOrchestra` class — radar canvas with sweep beam and listener dots |
| `debug.html` | Sync dashboard — subscribes to `hud_data` broadcasts, shows GPS/sync health per listener |
| `dj.html` | **Legacy — do not edit.** Absorbed into `playmin.html`. |
| `play.html` | **Legacy — do not edit.** Earlier version of the DJ engine. |
| `index.html` | Meta-redirect to `listener.html` |
| `Roadmap` | Product vision, open bugs, queued features, session log |
| `byob-capture.html`, `organismvisualizer.html` | Standalone prototypes — not linked from the main app, not wired to Supabase tables above |
| `migration_*.sql` | One-off schema migrations — run manually in the Supabase SQL editor, not applied automatically |

## Architecture

### Backend: Supabase
Single Supabase project (`ohacvuwzvuifpyqckise.supabase.co`) for auth, database, realtime, and file storage. `SUPABASE_URL` and `SUPABASE_ANON_KEY` are hard-coded at the top of each file's `<script>` block. Auth is shared — one login works everywhere.

### Database tables
- **`zones`** — `id, name, host_id, lat, lng, radius_m, active, listeners, tip_url, current_track_url, track_name, playback_started_at, play_at, play_from_s, zone_tracks, last_message, last_message_at`
- **`tracks`** — `id, user_id, zone_id, title, file_path, public_url, created_at`
- **`events`** — `id, name, artists, description, event_start, location_reveal_at, lat, lng, radius_m, zone_id, created_by`
- **`profiles`** — user profile data (display_name, emoji, vibe_tag, phone, instagram)

Storage bucket: **`boombox`** — track audio files uploaded as `boombox/{filename}`.

### Realtime channel naming convention
- `presence_{zone_id}` — listener GPS presence (bearing, dist, status, slot); DJ reads from here for crowd map
- `sync_{zone_id}` — DJ → listener commands: `hard_sync`, `sweep_start`, `sweep_stop`, `scatter`, `spatial_config`, `cluster_assign`, `rally`
- `zone_{zone_id}` — Postgres realtime on `zones` table UPDATE for the active zone
- `webrtc_{zone_id}` — WebRTC signaling for live mic streaming (offer/answer/ice)
- `chat_{zone_id}` — zone chat (currently unused in UI but channel wired in JS)

### GPS / geofence flow (listener)
`watchPosition` runs a single loop. On each fix, bearing and distance to active zone center are computed. Inside the geofence → audio unlocks, `unlockUI(z)` called. Listener broadcasts presence every 3s via `presence_{zone_id}`. `syncZoneAudio()` select must include `lat,lng,radius_m`.

### Server clock sync
All playback timing uses `syncedNow()` (listener) / `serverNow()` (DJ) — never raw `Date.now()`. `_clockOffset` computed via `measureClockOffset()` (calls `db.rpc('server_now')`): 8 samples when in a zone, 5 otherwise; median of RTT < 400ms samples. Re-measured every 30s. Awaited before first seek at zone entry.

### Sync engine (listener)
Two separate loops — do NOT collapse back into one:
- **`fastDriftCorrect()`** — memory only, runs every 5s. Uses `activeZone.playback_started_at` (cached). No DB fetch. Applies ±3% rate correction for <500ms drift, seek for >500ms.
- **`syncZoneAudio()`** — DB fetch, runs every 60s. Checks `active` flag, detects missed track changes by comparing `playback_started_at`.

Seek formula (must stay consistent across all callers):
```
expected = ((elapsed + SEEK_STAB_S - _deviceLatencyMs/1000 - _scatterOffsetMs/1000) % duration + duration) % duration
```
where `elapsed = (syncedNow() - new Date(playback_started_at).getTime()) / 1000`

`SEEK_STAB_S = 0.27` — audio seek stabilization latency constant.

### Sync channel — `buildSyncChannel(zoneId)`
The sync channel is extracted into `buildSyncChannel(zoneId)` so it can be rebuilt on reconnect. It auto-retries on CHANNEL_ERROR/CLOSED after 3s. **Always call `buildSyncChannel` — never inline the channel chain again.**

Handles: `hard_sync`, `spatial_config`, `sweep_start`, `sweep_stop`, `scatter`, `cluster_assign`, `rally`.

### Reconnection (no refresh needed)
- `window.online` event: re-measures clock, calls `buildSyncChannel`, rebuilds guest channel, runs `fastDriftCorrect`
- `visibilitychange` to visible: instant memory-based seek, then `syncZoneAudio()` in background
- Audio stall/waiting/suspend: 2.5s watchdog auto-resumes if `_webAudioPlaying` is true
- Audio error: reloads src and re-seeks after 1.5s

### Zone entry flow (`activateZone`)
1. Set `activeZone`, call `unlockUI(z)`, init guest channel
2. `await measureClockOffset()`
3. `startSyncEngine()` — starts both drift and health intervals
4. Load track: webrtc-live → `joinWebRTCStream()` | spatial zone_tracks → `loadTrack(slotUrl)` | fallback → `loadTrack(current_track_url)`
5. **Then always** subscribe `_zoneChannel` (postgres changes) and call `buildSyncChannel(z.id)`

**CRITICAL: never `return` early inside the track-loading block — channels must always be subscribed regardless of which track path runs.**

### WebRTC live streaming
DJ taps "Go Live" → `current_track_url = 'webrtc-live'`. Listeners call `joinWebRTCStream()`. ICE from `boombox.metered.live` with STUN fallback. `ontrack` stores stream in `_pendingStream`; user tap assigns to `audio.srcObject` and plays.

### Zone slots (dynamic, C + 1–N)
DJ assigns tracks to zone slots. Dynamic count: Center (C) plus numbered slots. Key functions: `getSlotKeys()`, `slotColor(key)`, `addSlot()`, `removeSlot()`. `SLOT_PALETTE` holds 12 colors. `zone_tracks` is JSON on `zones`: `{slotKey → trackUrl}`.

### Spatial modes (DJ side, `playmin.html`)
- **Single** — all listeners get Center (C) track
- **Cluster** — k-means by GPS proximity, assigns stem slots
- **Ring** — concentric rings by distance from zone center
- **Sweep** — circular sweep beam with staggered offset per bearing
- **Scatter** — staggers start times across voices
- **Movement** — auto-cycles stem assignments (wave/pulse/orbit/swing)

All modes broadcast `cluster_assign` via `sync_{zone_id}` with `{listenerId → slotKey}` + `zone_tracks`.

### Listener slot assignment
`getSpatialSlot(config)` — bearing-quadrant self-assignment. Needs `config.zone_lat`, `config.zone_lng`, `config.zone_radius_m`, `config.zone_tracks`, `config.voices`. `l.dist` in `liveGuests` is in **meters** — do NOT multiply by 1609.34.

### Master BPM + scene launcher (DJ, `playmin.html`)
`_masterBPM` — DJ-set master tempo. `tapTempo()` — tap-to-set. `onMasterBpm()` — manual entry. Scenes fire beat-quantized via `slFireScene` → waits `beatMs - (serverNow() % beatMs)` then calls `_doFireScene`. `broadcastAllZones()` payload includes `master_bpm` and `track_bpms`. Listeners apply `applyBpmWarp(slot, url)` from `audio.playbackRate`. Drift correction uses `_getBpmWarpRate()` as base rate so BPM warp and drift correction don't fight.

### Rally point
DJ fires `broadcastRally()` from RALLY POINT section in spatial panel → sends `{lat, lng, label}` on `sync_{zone_id}` as event `rally`. Listener receives: stores `window._rallyPoint`, shows `#fsb-rally` button, Boomy announces, drops teal circle marker on map. `zoomToRally()` flies map to coordinates.

### Tip flow
Zone has `tip_url` and optional `suggested_donation`. Broadcast via `spatial_config` payload. `showPlayerTipBtn()` shows/hides `#fsb-tip` fellowship button. 3-minute `scheduleTipNudge()` fires Boomy with tip CTA. `openTip()` opens URL in new tab.

## Listener UI layout (as of Jun 2026)

```
app-header (sticky)          — logo, user/role badge, boombox menu
now-playing-bar (sticky)     — zone name (teal), track name, thin orange progress bar
                               IDs: #npb-zone, #npb-track, #npb-fill
                               shown/hidden via .active class
.screen:
  .map-frame (380px)         — Leaflet map, .map-zone-overlay (zone name pill, top-center)
  .btn-zone                  — "⚡ FIND NEAREST ZONE" → "✦ YOU ARE IN THE ZONE"
  .zone-nav                  — bearing arrow + distance (hidden until approaching)
  .fellowship-row#fellowship-lockable  — locked until in-zone
    #fsb-crowd  👥 WHO'S HERE
    #fsb-signal 📡 MY SIGNAL
    #fsb-tip    💸 TIP DJ     (hidden until zone has tip_url)
    #fsb-rally  🎯 RALLY      (hidden until DJ broadcasts rally)
  #boomy-bar                 — in-flow Boomy image + speech bubble (not sticky)
  #guest-list-section        — WHO'S HERE list (always visible, always rendered)
    #signal-picker           — emoji signal setter
    #guest-list-ul           — rendered guest rows

Hidden (display:none) for JS compat:
  #organism-canvas, #music-lockable, #visuals-lockable, #progress-bar,
  #progress-fill, #time-cur, #time-dur, #track-name, #sync-status,
  #btn-tip-player, #tip-amount-badge, #music-artist, #zone-list,
  #zone-chat-section, #chat-messages, #chat-input, #eye-img
```

`unlockUI(z)` removes `locked` class from `music-lockable`, `visuals-lockable`, `fellowship-lockable`. Leaving zone re-locks all three.

Boomy speech (`playBabble`) is currently muted — `playBabble()` returns immediately. Re-enable by removing the `return` at the top of that function.

## Invariants — do not regress
- `bearing: 0` (due north) must not be treated as falsy — use `if (l.dist == null)` not `if (!l.bearing)`
- `setInterval(sendPresence)` must live outside the subscription callback — recreating on reconnect stacks intervals
- `syncZoneAudio()` select must include `lat,lng,radius_m`
- All playback position math uses `syncedNow()` (listener) / `serverNow()` (DJ), never raw `Date.now()`
- `measureClockOffset()` must be awaited before `seekToSync()` runs at zone entry
- DJ dot uses `window._spDotMarkers['__dj__']` and is never keyed through `liveListeners`
- Supabase does not echo broadcasts back to the sender — never rely on self-delivery for state
- `activateZone` must ALWAYS reach the `_zoneChannel` + `buildSyncChannel` calls — no early return in the track-loading block
- `l.dist` in presence payloads is in **meters** — never multiply by 1609.34
- Seek formula must include all four terms: `elapsed + SEEK_STAB_S - _deviceLatencyMs/1000 - _scatterOffsetMs/1000`
- `fastDriftCorrect` and `syncZoneAudio` are separate loops — do not merge them back
- `buildSyncChannel(zoneId)` is the only way to set up the sync channel — never inline it

## Design principle: listener simplicity
`listener.html` must stay minimal and frictionless. Fellowship features (WHO'S HERE, signal, tip, rally) live below the map and are locked until in-zone. Spatial audio routing happens silently. No slot selection, no zone routing controls exposed to listeners.
