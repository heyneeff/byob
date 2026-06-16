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
| `listener.html` | Listener app — GPS, audio playback, geofence entry, spatial routing, fellowship/social. Wired to the extracted `sync/sync-engine.js` module and `spatial-routing.js`. As of Jun 12 2026 this is the renamed former `listener-engine.html`, now production (see "Jun 12 2026 rename" below) |
| `artist.html` | DJ/host engine — zone creation, live stream, sync broadcast, crowd view, deck, scenes. As of Jun 12 2026 this is the renamed former `playmin.html` |
| `orchestra.js` | Shared `SpatialOrchestra` class — radar canvas with sweep beam and listener dots |
| `spatial-routing.js` | Spatial/DJ-tool routing module for `listener.html` — slot assignment, BPM warp, sweep/scatter offsets, and the `spatial_config`/`sweep_*`/`scatter`/`cluster_assign` broadcast handlers. Kept separate from the sync-engine block per the invariant below; only moves playback via `cancelDriftCorrection()` + `seekPreservingBT()` |
| `debug.html` | Sync dashboard — subscribes to `byob_debug` broadcasts, one card per device: currentTime, expectedPos, driftMs, deviceLatencyMs, playbackRate, driftState. Aggregate readout counts only playing devices (`playing && !paused && currentTime > 0`) and shows two numbers: drift spread (max−min driftMs, approximates audible misalignment) and raw position delta projected to a common instant (includes intentional latency/scatter offsets) |
| `sync-sim.html` | Standalone sync-engine simulator — no audio, no Supabase. Runs old vs new corrector designs side by side with identical seeds. Validate corrector changes here before porting to `listener.html` |
| `SYNC_ENGINE.md` | Deep-dive doc on how sync works — the reasoning behind the corrector design. **Update it when changing sync behavior** |
| `index.html` | Public landing page — upcoming events list (free vs paid, location reveal), city filter, links to `listener.html` / `artist.html` |
| `capture.html` | Standalone audio-capture tool — tab/mic recording, waveform trim editor with drag-select, automatic key/BPM detection, silence-trim, fade on cut; uploads to `boombox/stems/{user_id}/...` and inserts into `tracks` (same convention as artist.html's stem uploads, BPM auto-parsed by `parseBpmFromName`). Linked from artist.html's boombox menu. Editor also has BPM-warp + loop-bar snapping (`edSnapBars`/`edWarpBpm`, applied via `src.playbackRate`/`detune` in `edCut`'s `OfflineAudioContext` render) — loops are built and tempo-matched here, *before* upload, so `artist.html`/the sync engine never need runtime quantization or time-stretching |
| `Roadmap` | Product vision, open bugs, queued features, session log |
| `legacy/` | **Do not edit.** Archived prior versions: `listener-classic.html` (pre-Jun-12-2026 production `listener.html`, older inline drift corrector), `dj.html` and `play.html` (earlier DJ engines, absorbed into `artist.html`), `organismvisualizer.html` (standalone prototype, never wired to the Supabase tables above) |
| `migration_*.sql` | One-off schema migrations — run manually in the Supabase SQL editor, not applied automatically |

### Jun 12 2026 rename
`listener-engine.html` (the dev/validation build, wired to `sync/sync-engine.js` +
`spatial-routing.js`, Phase 5u-validated) was renamed to `listener.html` and is
now production. The previous `listener.html` (older inline `_driftState` copy,
missing the Phase 3 BPM-warp fix) was archived as `legacy/listener-classic.html`.
`playmin.html` was renamed to `artist.html`. Historical references to
`listener-engine.html` / `playmin.html` / old `listener.html` elsewhere in this
repo (especially `sync/ROADMAP.md`'s session log) describe the state *at the
time they were written* — read them with this rename in mind, don't "fix" them.

## Architecture

### Backend: Supabase
Single Supabase project (`ohacvuwzvuifpyqckise.supabase.co`) for auth, database, realtime, and file storage. `SUPABASE_URL` and `SUPABASE_ANON_KEY` are hard-coded at the top of each file's `<script>` block. Auth is shared — one login works everywhere.

### Database tables
- **`zones`** — `id, name, host_id, lat, lng, radius_m, active, listeners, tip_url, current_track_url, track_name, playback_started_at, play_at, play_from_s, zone_tracks, last_message, last_message_at`
- **`tracks`** — `id, user_id, zone_id, title, file_path, public_url, created_at`
- **`events`** — `id, name, artists, description, event_start, location_reveal_at, lat, lng, radius_m, zone_id, created_by, city, ticket_price, image_url`. `location_reveal_at` in the past = "always reveal" (set by the artist.html "Always show location" checkbox, bypassing the countdown for free events)
- **`profiles`** — user profile data (display_name, emoji, vibe_tag, phone, instagram)

Storage bucket: **`boombox`** — track audio files uploaded as `boombox/{filename}`.

### Realtime channel naming convention
- `presence_{zone_id}` — listener GPS presence (bearing, dist, status, slot); DJ reads from here for crowd map
- `sync_{zone_id}` — DJ → listener commands: `hard_sync`, `sweep_start`, `sweep_stop`, `scatter`, `spatial_config`, `cluster_assign`, `rally`, `slot_volume`, `slot_fx`
- `zone_{zone_id}` — Postgres realtime on `zones` table UPDATE for the active zone
- `webrtc_{zone_id}` — WebRTC signaling for live mic streaming (offer/answer/ice)
- `chat_{zone_id}` — zone chat (currently unused in UI but channel wired in JS)
- `byob_debug` — global (not zone-scoped) debug channel, two event streams: `hud_data` (`broadcastHUD()`, real audio-sync snapshot every 3s while a listener's HUD panel is open) and `listener_health`; `debug.html` renders both

### GPS / geofence flow (listener)
`watchPosition` runs a single loop. On each fix, bearing and distance to active zone center are computed. Inside the geofence → audio unlocks, `unlockUI(z)` called. Listener broadcasts presence every 3s via `presence_{zone_id}`. `syncZoneAudio()` select must include `lat,lng,radius_m`.

### Server clock sync
All playback timing uses `syncedNow()` (listener) / `serverNow()` (DJ) — never raw `Date.now()`. `_clockOffset` computed via `measureClockOffset()` (calls `db.rpc('server_now')`): 8 samples when in a zone, 5 otherwise; median of RTT < 400ms samples. Re-measured every 30s. Awaited before first seek at zone entry.

### Sync engine (listener)
Full design rationale in `SYNC_ENGINE.md` — read it before touching sync code, update it after.

Two separate loops — do NOT collapse back into one:
- **`fastDriftCorrect()`** — memory only, runs every 5s. Uses `activeZone.playback_started_at` (cached). No DB fetch. Computes drift via `computeLagMs()`; >60ms calls `requestCorrection()`.
- **`syncZoneAudio()`** — DB fetch, runs every 60s. Checks `active` flag, detects missed track changes by comparing `playback_started_at`.

Seek formula (must stay consistent across all callers, including `debug.html`'s expectedPos):
```
expected = ((elapsed + SEEK_STAB_S - _deviceLatencyMs/1000 - _scatterOffsetMs/1000) % duration + duration) % duration
```
where `elapsed = (syncedNow() - new Date(playback_started_at).getTime()) / 1000`

`SEEK_STAB_S = 0.27` — audio seek stabilization latency constant.

### Drift corrector — single gate `_driftState`
One state variable `_driftState` (`'idle' | 'warping' | 'ducking'`), one entry point `requestCorrection(lagMs)`:
- **<15ms** → ignored
- **15–500ms** → `'warping'`: ±3% `audio.playbackRate` nudge (inaudible), snaps back when gap closes. A new request during `'warping'` recomputes immediately — never deferred (a deferred warp runs a stale rate in the wrong direction).
- **>500ms** → `'ducking'`: `seekWithDuck()` — fade down, seek, fade up (~2.5s, audible). A new request during `'ducking'` sets `_driftPendingRecheck`; `settleToIdle()` re-checks drift when the duck finishes — without this recheck, deferred drift accumulates silently.

**Coordinated snaps** (`hard_sync`, `scatter`, sweep beam, `resync_at`, track change) are NOT drift — they call `cancelDriftCorrection()` (resets state, clears pending recheck, kills in-flight warp timer, restores base rate) then seek directly via `seekPreservingBT()`. Scatter especially: it's a forced snap, never feed it into `requestCorrection()` (a multi-hundred-ms scatter offset triggers a duck and reads as "broken" for 2.5s).

Note: `_syncState` (`'idle' | 'locking' | 'locked' | 'verifying'`) is a **different** state machine — the mic-based auto-sync verifier. Don't confuse the two.

### Bluetooth latency calibration
`calibrateDeviceLatency()` plays a click, listens via mic, measures round-trip → `_deviceLatencyMs` (cached in localStorage `byob_device_latency`). Auto-runs once via `preSyncApproach()` during GPS approach; `activateZone` has a fallback that calibrates at zone entry if the localStorage key is missing (covers force-enter, which skips the approach phase). Manual re-run: HUD **📡 CALIBRATE** button (`hudCalibrateNow()`) — pauses, calibrates, re-seeks. An uncalibrated phone (`deviceLatencyMs: 0` on a BT speaker) sounds offset even with `driftMs ≈ 0`.

### Sync channel — `buildSyncChannel(zoneId)`
The sync channel is extracted into `buildSyncChannel(zoneId)` so it can be rebuilt on reconnect. It auto-retries on CHANNEL_ERROR/CLOSED after 3s. **Always call `buildSyncChannel` — never inline the channel chain again.**

Handles: `hard_sync`, `spatial_config`, `sweep_start`, `sweep_stop`, `scatter`, `cluster_assign`, `rally`, `slot_volume`, `slot_fx`.

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

### Spatial modes (DJ side, `artist.html`)
- **Single** — all listeners get Center (C) track
- **Cluster** — k-means by GPS proximity, assigns stem slots
- **Ring** — concentric rings by distance from zone center
- **Sweep** — circular sweep beam with staggered offset per bearing
- **Scatter** — staggers start times across voices
- **Movement** — auto-cycles stem assignments (wave/pulse/orbit/swing)

All modes broadcast `cluster_assign` via `sync_{zone_id}` with `{listenerId → slotKey}` + `zone_tracks`.

### Listener slot assignment
`getSpatialSlot(config)` — bearing-quadrant self-assignment. Needs `config.zone_lat`, `config.zone_lng`, `config.zone_radius_m`, `config.zone_tracks`, `config.voices`. `l.dist` in `liveGuests` is in **meters** — do NOT multiply by 1609.34.

### Master BPM + scene launcher (DJ, `artist.html`)
`_masterBPM` — DJ-set master tempo. `tapTempo()` — tap-to-set. `onMasterBpm()` — manual entry. Scenes fire beat-quantized via `slFireScene` → waits `beatMs - (serverNow() % beatMs)` then calls `_doFireScene`. `broadcastAllZones()` payload includes `master_bpm` and `track_bpms`. Listeners apply `applyBpmWarp(slot, url)` from `audio.playbackRate`. Drift correction uses `_getBpmWarpRate()` as base rate so BPM warp and drift correction don't fight.

### Per-slot volume + FX (DJ, `artist.html`)
`_slotVolumes` (knob panel anchored to the right of the scene launcher, `onSlotVolumeInput`) — per-slot gain, applied to the DJ's local monitor immediately and debounce-broadcast as `slot_volume`. `_slotFx` (🌊 toggle next to each volume knob, `toggleSlotPulse`) — per-slot tremolo, broadcast as `slot_fx`. Both also ride along in `spatial_config` (`slot_volumes`/`slot_fx` fields). Listener-side: `applySlotVolume(slot)` sets `audio.volume = _slotVolumes[slot]`; `startFxLoop()` (spatial-routing.js) runs a `requestAnimationFrame` loop that, when the listener's slot has `slot_fx.type === 'pulse'`, modulates `audio.volume` on top of the base volume using a `syncedNow()`-phase-locked cosine at `master_bpm` — so every listener's pulse lands on the same beat. Pure `audio.volume` math; never touches `currentTime`/`playbackRate`/`playback_started_at`, so it can't interact with the drift corrector.

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
- Every drift trigger funnels through `requestCorrection()` — nothing calls `seekPreservingBT()` directly except coordinated snaps, and those must call `cancelDriftCorrection()` first. Two uncoordinated correctors fighting over `audio.currentTime` is the "roving" bug
- One reference point per zone: `cluster_assign` broadcasts must carry the zone's existing `playback_started_at` via `currentStartedAt()` (artist.html) — never mint `new Date(serverNow())`. Spatial reassignment changes WHICH stem, not WHEN the set started. Sites that legitimately restart playback must call `noteStartedAt(startedAt)`
- Validate corrector design changes in `sync-sim.html` before porting to `listener.html`; keep `SYNC_ENGINE.md` and `debug.html`'s expectedPos formula in step with the code
- **`baseline-sync-jun16` tag (commit `d015bbc`)** is the current validated-stable sync engine — supersedes `baseline-sync-jun14` (commit `481988b`). Live-tested Jun 16 2026: Phase 5w playing re-anchor + micro-correction removal achieved 1ms drift immediately on first live session. Dead-simple engine: snap if |drift| >= 150ms, re-anchor on every `playing` event (stall recovery), nothing else. Any change to `sync/sync-engine.js` or `fastDriftCorrect`/the seek formula in `listener.html` must be diffed against this tag, validated in `sync-sim.html`, and live-tested before merging to `main`. If a change regresses drift/warping, `git revert` it rather than layering a fix on top
- Spatial/DJ-tool logic (cluster/ring/sweep/scatter/movement, BPM warp, scene launcher) must stay separate from the sync engine's reference/corrector code — never inline spatial assignment or BPM-warp math into `fastDriftCorrect`, `requestCorrection`, or the seek formula. The Jun 10 2026 spatial-era regression (reference fragmentation from `cluster_assign` broadcasts) happened because spatial code reached into the corrector's reference point; spatial code may only ever call the documented entry points (`noteStartedAt`, `currentStartedAt`, `cancelDriftCorrection` + `seekPreservingBT`)
- Zones are isolated per `host_id` — multiple DJs can run independent zones (own tracks, `zone_tracks`, realtime channels) at the same time without collision. Creating a new zone only deactivates the *creating user's own* zones (`eq('host_id', currentUser.id)`), never another host's

## Design principle: listener simplicity
`listener.html` must stay minimal and frictionless. Fellowship features (WHO'S HERE, signal, tip, rally) live below the map and are locked until in-zone. Spatial audio routing happens silently. No slot selection, no zone routing controls exposed to listeners.
