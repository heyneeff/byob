# How BYOB keeps phones in sync

Every listener's phone is an independent speaker with its own clock, its own
Bluetooth latency, and its own network lag. The sync engine's job is to make
dozens of these phones play the *same instant* of the *same track* at the
*same time*, continuously, without anyone noticing it's happening.

## The core idea: a shared reference point, not a shared signal

There's no audio stream being pushed to listeners (except in WebRTC live mode).
Instead, every phone downloads the same track file and the DJ broadcasts a
single timestamp: **`playback_started_at`** — "this track began playing at
this exact moment." Every phone then independently computes where the audio
file should be right now, and holds it there.

## Step 1: agreeing on what time it is — `syncedNow()`

Phones' clocks are not in sync with each other or the server. `measureClockOffset()`
asks the server "what time is it?" several times via `db.rpc('server_now')`,
measures round-trip time, and keeps the median offset from samples with RTT < 400ms.
That offset (`_clockOffset`) gets added to the phone's own clock:

```
syncedNow() = Date.now() + _clockOffset
```

**Nothing in the sync engine is allowed to use raw `Date.now()`** — only
`syncedNow()`. Re-measured every 30s to track clock drift over a long party.

## Step 2: the seek formula

This one expression is the heart of the whole system:

```
expected = ((elapsed + SEEK_STAB_S - _deviceLatencyMs/1000 - _scatterOffsetMs/1000)
            % duration + duration) % duration
```

- **`elapsed`** — seconds since the track officially started, per the shared clock
- **`SEEK_STAB_S`** (0.19s) — fixed compensation for the time an `<audio>` seek
  takes to actually settle
- **`_deviceLatencyMs`** — how long *this specific phone* takes to emit sound
  after the browser requests it. Bluetooth speakers add 150–400ms of invisible
  acoustic delay. See Step 6 for how this gets set.
- **`_scatterOffsetMs`** — a deliberate per-listener delay the DJ dials in for
  spatial effects (sweep, scatter). Not a correction — an intentional offset
  baked into the same formula.

## Step 3: two independent loops keep it locked in

**`fastDriftCorrect()`** — runs on the `timeupdate` event, gated to at most
once per `DRIFT_CHECK_MS` (2500ms). Pure memory — no network call. Computes
`lagMs = currentTime - expected` via `computeLagMs()`, then acts:

- **|lag| ≥ 150ms** (and < 2000ms sanity ceiling) → hard snap:
  `cancelDriftCorrection()` then `seekPreservingBT(expected)` — mute, jump,
  ~180ms volume ramp. Audible as a brief dip, but rare: only when real drift
  has accumulated past the threshold.
- **|lag| 15–150ms** → hand off to the ternary engine via `requestCorrection(lagMs)`.
  The engine warms the playback rate to close the gap inaudibly.
- **|lag| < 15ms** → nothing. Micro-correction (inside the engine) holds position.

**`syncZoneAudio()`** — runs every 60s, does a real database fetch. Not
fine-tuning — a safety net for structural changes the memory loop can't see:
zone ended, track changed, missed broadcast.

These stay deliberately separate. Merging them would either slow the correction
loop (DB latency on every tick) or lose the structural safety net.

The 2000ms sanity ceiling (`TH_SEEK_SANITY`) guards against `wrapLag` artifacts
at track loop boundaries — a computed lag of e.g. −169000ms is a wrap artifact,
not real drift, and must not trigger a seek.

## Step 4: the ternary engine — three zones, not two

`sync/ternary-engine.js` is the production sync engine. It replaces a binary
"fix or don't" approach with three zones defined by how far off the audio is:

| State | Range | Action |
|-------|-------|--------|
| **P** | < 10ms | Converged. Apply micro-correction only. |
| **Z** | 10–50ms | Slipping. Warp rate at 2%. |
| **N** | 50–250ms | Lost. Warp rate at 5%. |
| seek | > 250ms | Beyond warp reach. Seek directly. |

**Warp rate composition** — three ternary inputs multiply together:

```
warpPct = BASE_RATE[trit] × VEL_MOD[velocity] × CONSENSUS_MOD[consensus]  (cap 6%)
```

- `BASE_RATE`: P=0.4%, Z=2.0%, N=5.0%
- `tcmp()` **velocity** — is lag growing or shrinking? Growing (N) → ease off
  slightly (×0.90). Shrinking (P) → push a little harder (×1.20).
- `tcons()` **consensus** — are peers also struggling? If the group is in N-state,
  boost urgency (×1.10).

**Micro-correction (P-state)** — when converged, a tiny continuous rate offset
counteracts the audio clock running slightly slow:

```
rate = baseRate × (1 + clamp(lagMs × 0.0004, ±1.2%))
```

This is a proportional controller: a constant hardware-drift error cancels once
the trim's magnitude matches it. Steady-state |lag| converges to ~12.5ms at
worst-case ±0.5% hardware clock error.

**Engine state** — `_state` is `'idle' | 'warping' | 'seeking'`. Warp fires a
timer that restores the base rate when the gap should be closed (`settleToIdle`),
then re-checks and re-fires if drift remains. Seeks use a volume ramp to mask
the discontinuity.

## Step 5: deliberate "everyone snap together NOW" moments

Separate from continuous drift correction, the DJ (or a spatial effect) can
trigger a **coordinated snap** — "jump to this exact position right now."
Used for: starting a new track, `resync_at`, sweep beam reaching a listener,
manual `hard_sync`, and scatter (deliberate staggered offsets for spatial effect).

These always call `cancelDriftCorrection()` first — resets engine state to idle,
cancels any in-flight warp timer, restores playback rate to baseline — then seek
via `seekPreservingBT()`. Without this, a coordinated snap could collide with
an in-flight warp and leave the device worse off than before.

## Step 6: Bluetooth latency calibration

`_deviceLatencyMs` in the seek formula only compensates BT delay if it's
accurately set. Without mic access, three mechanisms set it:

**1. `outputLatency` seed** — on the first `fastDriftCorrect()` tick,
if `_deviceLatencyMs === 0`, the browser's `AudioContext.outputLatency`
(Chrome/Android only; Safari returns 0) is read and used as a bootstrap value.
One-time, no feedback loop.

**2. Ternary auto-calibration** — the engine watches for a *floor*: a persistent
residual lag that warp can never fully close, indicating that `_deviceLatencyMs`
is wrong by a fixed amount. Floor detection uses only samples collected while
the engine is in `idle` state AND at least 2s past the last warp completing —
preventing post-warp overshoots from contaminating the estimate.

When a stable floor is detected (low variance, 20–250ms magnitude), the engine
fires `onCalibrate(delta)` which adjusts `_deviceLatencyMs` and the floor
shrinks. How hard to push is governed by the **octonary trigram** (see Step 7).

**2b. Greenhorn fast-cal** (oracle 14.2→30, 2026-07-07) — a device with NO
stored latency at page load (`window._terLatencyWasStored === false`) is a
*greenhorn*: instead of waiting for the conservative auto-cal lane (10 calm
seconds, 50% steps, 60s settle gaps), it makes **one bold 100% correction**
from ~8 drift samples that each need only 2s of post-disturbance calm
(post-entry, non-burst). Median with an agreement guard (≥5 of 8 within
±60ms, else the window slides). Fires typically within ~20s of joining;
below 25ms it stands down without correcting. Because 2s calm gaps exist
even between snap-storm snaps, greenhorns cannot enter the snap↔cal
deadlock. After the bold shot the device drops into the conservative lane
(`_calCount = 1`). RESET CAL re-arms greenhorn mode
(`_terLayer.noteLatencyReset()`).

**2c. Crowd prior** — peer trit broadcasts on `byob_ternary` carry
`(model, latencyMs, calSettled)` where model is the UA platform segment.
A greenhorn seeing ≥2 settled same-model peers seeds `_deviceLatencyMs`
from their median latency immediately (one shot), then its own fast-cal may
still refine once. New arrivals of known hardware start correct — the
bigger the crowd, the faster it syncs. Offline validation:
`node sync/greenhorn-sim.mjs` (runs the real `ternary/layer.js` in a vm
sandbox, calibration loop included).

**3. Remote debug nudge** — `debug.html` can send a `latency_cmd` broadcast on
the `byob_debug` channel with `{ deviceId, deltaMs }`. The listener receives it,
applies the delta in-memory, and persists to `localStorage`. Each press is ±50ms.
Use this when a device's drift floor is visible in the debug chart but the
ternary auto-cal hasn't converged yet. The stored value survives reloads.

`_deviceLatencyMs` is capped at 1000ms. Values above 1000ms stored from a
previous bad run are nuked on page load.

## Step 7: the octonary trigram calibration

The auto-calibration doesn't apply a fixed correction — it reads a *history* of
outcomes to decide how hard to push.

Each time the engine enters N-state (large correction needed), it checks for a
floor and records the outcome as a trit:

- **N** — floor detected, calibration error persists
- **P** — no floor, device is stable

`_calSeq` holds the last 3 outcomes: `[oldest, middle, newest]`. Three binary
values, eight possible patterns, mapped to the eight I Ching lower trigrams:

| Sequence | Trigram | Strength | Reading |
|----------|---------|----------|---------|
| NNN | ☰ | 0.70 | Three consecutive floors — push hard |
| NNP | ☱ | 0.55 | Floor twice then gone — something shifted |
| NPN | ☲ | 0.50 | Alternating — oscillating, standard |
| NPP | ☳ | 0.35 | One floor, then held — nearly stable |
| PNN | ☴ | 0.60 | Was stable, floor returned — regression |
| PNP | ☵ | 0.40 | Bouncing — mixed signal |
| PPN | ☶ | 0.25 | Almost there — cautious nudge |
| PPP | ☷ | 0.00 | Locked — stop touching it |

```
correction = floor_mean × trigram_strength
```

This delta is applied to `_deviceLatencyMs`. At NPN (0.50), an 80ms floor
produces a 40ms correction. Next time, 40ms floor → 20ms correction. Converges
geometrically. At PPP (0.00), the engine stops touching the calibration
entirely — it's locked.

**Cross-track persistence** — on track change, `resetCalibration()` clears
`_floorHistory` (fresh floor samples for the new track) but leaves `_calSeq`
untouched. A device that reached PPP stays protected across tracks. The trigram
represents the device's hardware, not the track.

## Scheduled synced entry (2026-07-06) — and the retirement of burst snapping

Clips now **enter aligned** instead of converging in public. Every launch path
(bridge `play`, artist.html `playNext`/scene fire) anchors
`playback_started_at = play_at` — one shared future instant with a ≥2.5s lead
(bar-quantized from Ableton Link in the bridge). Listeners receiving a future
`play_at` call `_armScheduledStart()` (listener.html): preload muted, pre-seek
to the start position, then un-mute at `play_at + own _deviceLatencyMs` so the
*sound* lands together across devices. `_trackLoading` stays true during the
hold so the corrector can't fight it. Late joiners use the immediate path.

`computeSeekTime`'s `play_at` branch must apply the same
`deviceLatencyMs`/`scatterOffsetMs` compensation as the `startedAt` branch —
omitting it planted devices at exactly +their-own-latency on every
wake/reconnect re-anchor (the 2026-07-06 roving regression; pinned by tests).

**🚫 BURST-MODE SNAPPING IS RETIRED — do not re-add.** (Oracle 34.5→43,
2026-07-06.) With entry alignment handled before audio is audible, burst's
1s/20ms snap loop had no job left, and each snap was an audible mute+ramp cut
(up to 33 per launch measured live). Burst mode survives only as a fast
measurement window (1s ticks feeding auto-cal and the launch report).
Likewise **calibration state persists across track changes** — the per-track
reset re-ran fresh corrections every clip, ratcheting `_deviceLatencyMs`
toward the 1200ms cap over a session until corrections were swallowed. The
correction budget refills one slot per track change instead.

Verification: `sync/live-monitor.mjs` prints a per-launch report (spread at
`play_at`, time-to-converged, snap count, PASS/FAIL at <50ms within 3s);
`sync/launch-cycler.mjs` fires launches on an interval against a test zone.

## Zone offset — the room's one timeline trim (2026-07-06)

`zone_offset_ms` (broadcast on `spatial_config`, tunable from the bridge UI)
shifts every listener's effective clock inside `syncedNow()` — the single
choke point all seeks, drift checks, and scheduled entries flow through.
Positive = the whole room plays later. Because the shift is inside the clock,
drift still reads 0 when aligned; nothing else in the engine knows it exists.
Use it to trim the room's common-mode offset against the broadcaster by ear.
Never fold zone offset into the seek formula's terms at call sites — the one
clean point is the clock (oracle 4.2.4→35: entangled folly brings humiliation).

Floor detection (`ternary/layer.js detectFloor`) samples only calm water:
never during burst, not within 10s of a >120ms tick-to-tick jump, and a floor
must hold across both halves of the sample window (same sign, means within
35ms). Launch transients decay; structural floors hold (oracle 56.2.5→9).

## The golden rule: one corrector, one entry point

**Every code path that wants to nudge a listener's playback position calls
`cancelDriftCorrection()` first**, then either `seekPreservingBT()` (instant
snap) or `requestCorrection(lagMs)` (ternary engine). Nothing goes directly to
`audio.currentTime` without clearing any in-flight correction first.

This exists because BYOB has many independent triggers — the 2.5s drift loop,
the 60s health check, wake from locked screen, network reconnect, scatter/sweep
spatial effects, slot reassignment. If two of these compete over `audio.currentTime`
without coordination, you get the *roving* bug: audio that dips and re-seeks
endlessly, each correction "fixing" drift the other one just introduced.
`cancelDriftCorrection()` gives whichever path calls it next a clean slate.

## The golden rule: one reference point per zone

`playback_started_at` is the anchor. Every `cluster_assign` broadcast (cluster,
ring, sweep, movement) must carry the zone's *existing* `playback_started_at`
via `currentStartedAt()` in `artist.html` — never a freshly minted timestamp.

Spatial reassignment changes **which** stem a phone plays, not **when** the set
started. The June 2026 regression happened because four `cluster_assign` sites
each stamped a new `new Date(serverNow())` — reassigned phones seeked to
position ~0 against that private reference while `fastDriftCorrect` yanked
them back seconds later against the real one. With movement mode rebroadcasting
every 2s, the result was continuous reference fragmentation.

Sites that *legitimately* restart playback (track change, scene fire, go-live)
register the new timestamp through `noteStartedAt()` so later broadcasts
inherit it rather than going stale.

## Live debugging: `debug.html`

`broadcastHUD()` sends a snapshot every 3s on `byob_debug` while a listener
has their HUD panel open. `debug.html` renders one card per device.

`expectedPos` in the card uses the **same formula** as `computeLagMs()` —
keep them in sync. A simplified copy here will make `driftMs` read wrong by a
constant offset even when the corrector is fine.

The `[−50ms BT]` / `[+50ms BT]` buttons on each sync card send a `latency_cmd`
broadcast to that specific device. Use them when a device's drift line is stable
but offset from zero — that's a calibration floor, not a sync failure.

## Where this design was validated: `sync-sim.html`

A standalone simulator (no audio, no Supabase) that runs the same randomized
party through engine designs side by side, with identical seeds and event
schedules. Validate corrector changes here before porting to `listener.html`.
The ternary panel (coral/pink) is `runSimTernary()`.

**Three reference commits — return here when lost:**

- `6f4f5b0` (May 2026) — the philosophical anchor: no `playbackRate` touching,
  just `if (drift > 0.3) seekPreservingBT(expected)` every 10s. Everything since
  is a refinement of this.
- `d015bbc` (`baseline-sync-jun16`) — Phase 5w: added `playing` re-anchor for
  stall recovery. Achieved 1ms drift live.
- `bf76374` (`baseline-sync-jun16b`) — validated ceiling: SEEK_STAB_S=0.19,
  triggerResync uses existing reference. Every improvement must beat all three
  on real CSV data. **More complexity is never the answer.**
