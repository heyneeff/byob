# Entry & Orchestra — the road to launching clips

> Written 2026-07-16 (early), from the 2026-07-15 evidence day (see
> `sync/TUNING_LOG.md` from "warp-gate shipped" through "session close").
> Companion to the bulletproof roadmap (Phases 3/4/6) and `SYNC_ENGINE.md`.
> Protocol unchanged: every engine/corrector/launch-path change casts the
> oracle first; one change at a time; docs/sims/harnesses exempt.

## North star, and why entry comes first

The goal is **Ableton as the orchestra brain**: fire a scene, and specific
devices play specific clips, entering together tight enough for jungle/DnB
(a 16th at 172 BPM is ~87ms; drops read as "one system" under ~30ms).

Clips make entry the whole game. A clip launch IS an entry — and clips fire
at high cadence. July 15 proved the engine's steady state is already solid
(rooms flatline at 33–83ms for as long as a track runs) and that **every
observed mess lives in the launch path**: propagation, load, and identity
churn. Scenes built before entry is tight would simply inherit the churn-era
behavior (multi-minute room splits, 10–46s staggers). So: entry first, then
scenes, then orchestra composition.

**The one clean launch on record is the target feel:** 2026-07-15 14:06,
LAN, 3 phones — 0.3s stagger, room came out tighter than it went in
(75→43ms). That has to become every launch.

## Where entry stands (evidence, 2026-07-15)

| Fact | Evidence |
|---|---|
| Propagation is bimodal: 0.0–0.1s to awake phones, +18–46.7s to throttled/backgrounded tabs | 7/9 launch clusters instant; c0tzzz +26.7/+29s; churn-era staggers to 46.7s |
| Launch fetch-bursts strain the tunnel: stall waves + splits appear only under cadence | stable-room windows: zero stalls; churn windows: 50-stall waves, 986ms stalls |
| Rooms SPLIT when a device misses/fails a load: it keeps playing the old track for minutes | refSpread wraps of 56s/106s/162.7s, healing only at the next launch |
| A wedged element (>2s off, seeks no-op) has NO automated owner | cascade wrap-guard is 2s; snap no-ops; cal is floor-scale. Cure today: different-URL relaunch (confirmed live: 4.4s → 101ms) |
| Track changes refill cal budgets and can TIGHTEN the room | 14:06 (75→43ms) and 16:35 (67ms touch) |
| Entry math itself is fine for phones that hear the launch | steady medians unchanged through all eras; scheduled entry pre-seeks muted in the ≥2.5s lead |
| Fresh identities enter worst (per-origin localStorage = greenhorn cal) | LAN-origin phones re-learned from zero; late joiners never settled in churn |

## The bar

- **M2 (from the roadmap):** 20 consecutive launches, ALL devices <50ms of
  reference within 3s of `play_at` — then tighten the bar to 25ms.
- **Clip bar (stricter, new):** propagation of the launch signal itself
  <1s to every *awake* device; zero room splits (no device left on the old
  audio >10s); wedges self-cure within one launch cycle.
- Measured by `sync/launch-cycler.mjs` + `sync/live-monitor.mjs` launch
  reports, in a controlled window — offline sim first where applicable.

## Workstream 1 — Propagation (make the launch signal arrive)

1. **Throttle probe (measurement, no code):** screen-off one phone across a
   track change; confirm the +20–30s lag reproduces. Feeds everything below.
2. **Wake lock + keep-screen-on UX** (`listener.html`, not engine code):
   request a screen wake lock while in-zone and playing; visible "keep your
   screen on" nudge when the API is unavailable (iOS Safari). Telemetry
   already exports `visibilityState` — add a throttled-device flag to the
   overlay/monitor so stragglers are visible BEFORE they miss a launch.
3. **Launch-state re-broadcast from the bridge** — late wakers currently
   depend on catching one `hard_sync` or a 60s row poll; the bridge should
   re-emit current launch state (`playback_started_at`/`play_at`/track) at
   a short cadence for ~30s after each launch so a waking tab re-arms in
   seconds. **Touches the launch path — CAST FIRST.**
4. **Defection guard** (`byob-shim.js`, plumbing): an explicitly-set
   `?server=` must never be silently replaced by `/relay.json` re-resolve
   (provenance flag). Stops LAN phones from becoming tunnel phones mid-set
   and keeps rooms single-path during shows and tests.

## Workstream 2 — Load (make the audio present before play_at)

1. **Clean LAN-churn measurement cell** (no code): one origin, one join
   wave, 10min settle, then 10min auto-advance churn on LAN. Decides how
   much of the load lane is bandwidth vs. logic. (The venue answer is
   already shaped: Phase 4's LAN-first mode — Mac hotspot → travel router.)
2. **Next-track prefetch:** the deck knows the queue; listeners can warm
   the next track (fetch into HTTP cache, or a second muted `<audio>`)
   during the current one, so a launch never triggers a room-wide
   simultaneous cold fetch. Design sketch first; **cast before touching
   listener launch/load code.** For scenes, prefetch = "arm the scene":
   push the {slot→track} map ahead of the fire so devices preload BEFORE
   `play_at` exists.
3. **Same-URL relaunch wedge fix** (long-standing Phase 3 item): the audio
   element must actually reload on an identical URL relaunch. **Cast.**
4. **Wedge owner (>2s):** today nothing may act on a device stuck beyond
   the cascade's 2s wrap-guard. Options (cast decides): persistent
   beyond-sanity same-sign refMs readings as a wedge signal → one bounded
   different-URL-style recovery (element reload), or simply fixing (3) and
   accepting relaunch as the cure. Do NOT widen the wrap-guard — that
   re-opens the door the guard exists to close.

## Workstream 3 — Entry math & state machine (mostly held — document + verify)

1. Document the entry state machine in `SYNC_ENGINE.md`
   (idle → armed (`_armScheduledStart`) → preroll (muted, pre-seeked) →
   unmute at `play_at + deviceLatency` → locked), per the roadmap's Phase 3.
2. Verify unmute timing per device latency with launch reports (the math
   held in every window where the signal arrived and the file was loaded).
3. Every launch path — bridge PLAY, playNext, future `fire_scene`, legacy
   artist.html — flows through scheduled entry. One choke point, enforced.

## Telemetry upgrades (small, high leverage — do these early)

- **Track identity in every row:** hud_data/trit/CSV rows carry a short
  hash of `current_track_url` (+ slot key when spatial). July 15's room
  splits were only *inferable*; with a track column they're directly
  visible, and every cross-track refMs "spread" ghost (56–162s
  duration-scale artifacts) becomes filterable. This is also the first
  concrete piece of "orchestra differentiation."
- **Event kind column** in overlay `REC_COLS` (launch vs correction vs
  join is currently guesswork in exports).
- **Overlay wrapLag pass:** drift/refMs display lanes need the same wrap
  handling the engine has (duration-scale ghosts; frozen mirror-image
  ter/dev readouts). Display-only, observe-only — no engine reads.

## Part 2 — Scene launch (Ableton → assigned devices)

Gated on M2 holding. The chassis exists: the bridge speaks Ableton Link
(bar-quantized `play_at`), owns the clock, and `zone_tracks` +
`cluster_assign` already route tracks to devices. Build order:

1. **Scene map in the bridge** (`bridge/bridge.mjs` + bridge UI): a named
   scene = `{slotKey → trackUrl}` + assignment map + one launch. Fired from
   the bridge UI first (click/keyboard). A scene fire is just a scheduled
   launch plus an assignment — invariants already cover it (one reference
   per zone; assignments carry `currentStartedAt()`, never mint a new one).
   **Assignment must ride with (or strictly before) the launch broadcast**
   so no device races its slot. **Cast (launch path).**
2. **Arm-then-fire:** `arm_scene` pushes the map → devices preload their
   assigned clip muted → `fire_scene` sets the bar-quantized `play_at`.
   This splits load latency from entry timing — the load lane's fix,
   exploited on purpose.
3. **Ableton trigger:** Max-for-Live device (or MIDI→WS shim) sending
   `arm_scene`/`fire_scene` over the bridge WS. Scene indices map to
   Ableton scenes; Link supplies the bar grid. No engine code.
4. **Count-in UX:** `launch_in_ms` already rides in `link_state` — surface
   it in the bridge UI (existing open task) so fires land on musical time.
5. Clips are pre-tempo-matched at upload (`capture.html` loop/BPM tooling)
   — no runtime stretching, by design. Keep it that way.

## Part 3 — Orchestra differentiation (why it feels like a mess today)

"The orchestra doesn't differentiate between tracks" is true at three
layers, each with its own fix:

1. **Telemetry** (the mess you can see): monitors/overlay mix devices
   playing different audio into one spread number — cross-track refMs
   deltas are duration-scale nonsense. Fix = track identity column +
   overlay grouping by track/slot (gauges partition per track, room-level
   gauges only aggregate devices sharing a reference AND a track).
2. **Consensus scope:** by design, refMs compares fine across devices on
   different STEMS of one launch (same `playback_started_at` — one
   reference per zone), but must never compare across different
   *references* (transitions). The cascade already burst-gates launches;
   with track identity broadcast in the trit payload, add the explicit
   rule: **only sample refMs against a peer on the same reference+track
   epoch.** Small, load-bearing for spatial rooms. **Cast.**
3. **Console:** the radar (`orchestra.js`, bridge UI) colors devices by
   slot (`slotColor` exists) and shows per-slot track names — the DJ sees
   WHO plays WHAT, live. UI work, no engine code.

Spatial gain-field / composed per-speaker offsets stay **parked** per their
standing casts (48.2→39, 27.1→23) until M1–M4 hold. The orchestra earns
composition after it can hold a unison.

## Sequence (the actual roadmap)

| # | Step | Gate |
|---|---|---|
| 1 | Telemetry: track identity + event kinds + throttle flag | none (observe-only) |
| 2 | Defection guard (shim) | none (plumbing) |
| 3 | Throttle probe + clean LAN-churn cell | measurement |
| 4 | Wake lock + keep-screen-on | listener UX |
| 5 | Launch re-broadcast (bridge) | **cast** |
| 6 | Same-URL wedge fix / wedge owner | **cast** |
| 7 | Next-track / arm-scene prefetch | **cast** |
| 8 | Launch-cycler campaign → **M2: 20× <50ms, then 25ms** | controlled live |
| 9 | Scene map + arm/fire in bridge UI | **cast** (launch path) |
| 10 | Ableton M4L/MIDI trigger | no engine code |
| 11 | Orchestra console differentiation + same-epoch consensus rule | **cast** for (2) |
| 12 | Composed spatial work | unparks only after M1–M4 |

Steps 1–4 are a morning. Steps 5–8 are the entry campaign. 9–11 are the
orchestra. Venue LAN mode (Phase 4 ladder) runs parallel as ops whenever
hardware allows.
