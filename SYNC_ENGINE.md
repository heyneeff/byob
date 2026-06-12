# How BYOB keeps phones in sync

Every listener's phone is an independent speaker with its own clock, its own
Bluetooth latency, and its own network lag. The sync engine's job is to make
dozens of these phones play the *same instant* of the *same track* at the
*same time*, continuously, without anyone noticing it's happening.

## The core idea: a shared reference point, not a shared signal

There's no audio stream being pushed to listeners (except in WebRTC live mode).
Instead, every phone downloads the same track file and the DJ broadcasts a
single timestamp: **`playback_started_at`** — "this track began playing at
this exact moment." Every phone then independently computes:

```
elapsed  = (serverNow() - playback_started_at) / 1000
expected = elapsed position within the track right now
```

...and makes sure its `audio.currentTime` matches `expected`. If every phone
agrees on what time it is and agrees on when the track started, they all land
on the same position — no streaming required.

## Step 1: agreeing on what time it is — `syncedNow()`

Phones' clocks are not in sync with each other or the server. `measureClockOffset()`
asks the server "what time is it?" several times via `db.rpc('server_now')`,
measures round-trip time, and keeps the offset from the fastest (most reliable)
samples. That offset (`_clockOffset`) gets added to the phone's own clock:

```
syncedNow() = Date.now() + _clockOffset
```

From this point on, **nothing in the sync engine is allowed to use raw
`Date.now()`** — only `syncedNow()`. This is re-measured every 30s to track
clock drift over the course of a party.

## Step 2: the seek formula

This one expression is the heart of the whole system, and it appears
everywhere a phone needs to know "where should I be right now":

```
expected = (elapsed + SEEK_STAB_S - _deviceLatencyMs/1000 - _scatterOffsetMs/1000) % duration
```

- **`elapsed`** — seconds since the track officially started (per the shared clock)
- **`SEEK_STAB_S`** (0.27s) — a fixed fudge factor; seeking an `<audio>` element
  isn't instant, this compensates for that settling time
- **`_deviceLatencyMs`** — how long it takes *this specific phone* to actually
  emit sound after the browser asks it to (Bluetooth speakers add real delay —
  measured once via a mic-and-click calibration routine and cached)
- **`_scatterOffsetMs`** — a *deliberate* per-listener delay the DJ can dial in
  for spatial effects (sweep beams, scattered voices) — this isn't an error to
  correct, it's an intentional offset baked into the same formula

## Step 3: two independent loops keep it locked in

- **`fastDriftCorrect()`** — runs every 5 seconds, purely from memory (no
  network call). Computes `expected` vs. `audio.currentTime` (via
  `computeLagMs()`), and if they've drifted apart by `DRIFT_SNAP_THRESHOLD_MS`
  (300ms) or more, snaps directly: `cancelDriftCorrection()` then
  `seekPreservingBT(expected)` (mute, jump, ~180ms ramp back up). Below
  300ms, it applies a tiny continuous `playbackRate` trim via
  `applyMicroCorrection()` (Phase 5r, capped at ±0.6%) — see Step 4a.
- **`syncZoneAudio()`** — runs every 60 seconds, does an actual database fetch.
  Its job isn't fine-tuning — it's a safety net that catches things memory
  can miss: "did the zone end?", "did the track change and I missed the
  broadcast?"

These stay deliberately separate: one is a tight feedback loop for staying
glued to the beat, the other is a slow heartbeat for catching structural
changes (zone ended, track changed, etc).

## Step 4: how a correction actually gets applied

**Phase 5p (2026-06-12): the periodic loop no longer warps `playbackRate` at
all.** Earlier designs (Phase 5h-5o) tiered the response — small drift got an
inaudible ±3% `playbackRate` nudge (`'warping'`), only large drift got a
seek+fade (`'ducking'`). In practice, real devices' drift sat continuously
inside the 15-500ms "warping" band, which meant `playbackRate` was pinned at
1.03 almost permanently — an audible, continuous pitch wobble ("a finger on
a record"), the opposite of "inaudible."

The May 13 2026 baseline (`6f4f5b0`) — which the manual HUD-sync workflow
worked great against — never touched `playbackRate` at all: a periodic
check, and if `|drift| > 300ms`, an instant `seekPreservingBT()` snap
(mute/seek/~180ms ramp). Otherwise, nothing. Phase 5p restores this for
`fastDriftCorrect()`:

- **Drift under 300ms** → ignored. Audio plays at exactly base rate
  (1.0, or the BPM-warp rate if one is set) — no modulation, ever, from this
  loop.
- **Drift 300ms or more** → `cancelDriftCorrection()` (clears any in-flight
  state from the mechanism below) then `seekPreservingBT(expected)` — an
  instant jump with a brief mute/ramp to mask the discontinuity. Audible as
  a very short (~180ms) dip, but rare: only when real drift has actually
  accumulated past 300ms, not every tick.

### Step 4a: closing the residual gap — `applyMicroCorrection()` (Phase 5r)

Snap-only held drift *bounded* (never past 300ms) but not *tight*: real
devices carry a small, constant hardware clock-rate error (their audio clock
runs a fixed fraction fast or slow relative to `syncedNow()`), which made
drift sawtooth from ~0 up to 300ms and back every couple of minutes — median
drift sat around -60 to -180ms across a 67-minute session, well above the
~50ms target.

`applyMicroCorrection(lagMs)` — called every `fastDriftCorrect()` tick
whenever `|lagMs| < DRIFT_SNAP_THRESHOLD_MS` — applies:

```
pct  = clamp(lagMs * MICRO_GAIN_PER_MS, ±MICRO_MAX_PCT)   // MICRO_GAIN_PER_MS = 0.0002, MICRO_MAX_PCT = 0.006
rate = baseRate * (1 + pct)
```

This is a proportional controller: a constant hardware-drift error is
cancelled once the trim's magnitude matches it, so drift converges to a
small constant offset (`|lag| ≈ hwDriftPct / MICRO_GAIN_PER_MS`) instead of
sawtoothing up to the snap threshold. At the worst-case ±0.5% hardware drift
modeled in `sync-sim.html`, steady-state `|lag|` converges to ~25ms — under
the cap (0.5% < 0.6%), so it's never saturated at equilibrium.

This is deliberately the *opposite* shape of the Phase 5h-5o tiered warp that
caused the "finger on a record" complaint: that was a large (±3%), frequently
*flipping* correction — audible as flutter. This trim is small (≤±0.6%,
~5x gentler) and settles to a *constant* offset — nothing to hear oscillate.
It's a no-op whenever `_driftState !== 'idle'` (the verifier's warp/duck is
active), so the two mechanisms never fight over `playbackRate`.

### The tiered `requestCorrection()` / `_driftState` machine still exists — for the BT-latency auto-sync verifier only

`sync/sync-engine.js` still exports the single-gated `_driftState`
(`'idle'` / `'warping'` / `'ducking'`) state machine and its entry point
`requestCorrection(lagMs)`, with the same `<15ms` / `15-500ms` (±3% warp,
`'warping'`) / `>500ms` (fade/seek/fade, `seekWithDuck()`, `'ducking'`)
tiers described in earlier revisions of this doc. **`fastDriftCorrect()`
no longer calls it.** It's still used by the mic-based BT-latency
auto-sync verifier (`_syncState` — a *different* state machine, see CLAUDE.md),
which occasionally calls `requestCorrection()` with a small lag measured via
cross-correlation. Because that's rare and short-lived, `_driftState` should
sit at `'idle'` / `playbackRate === 1.000` almost all the time in practice.

`settleToIdle()` (called when a warp/duck completes) still rechecks live
drift and re-fires `requestCorrection()` if still ≥15ms (Phase 5o) — this
remains correct for the verifier's occasional use, even though the periodic
loop no longer exercises it.

## Step 5: deliberate "everyone snap together NOW" moments

Separate from continuous drift correction, the DJ (or a spatial effect) can
also trigger a **coordinated snap** — "jump to this exact position right now."
Used for: starting a new track, a coordinated `resync_at`, a sweep beam
reaching a listener's bearing, a manual `hard_sync`, and **scatter** (the DJ
staggers each listener's start offset for a spatial effect). These don't go
through the gentle ±3% warp — they're supposed to snap immediately, because
the reference point itself just changed, not because the listener drifted.

Because these are forced, immediate seeks, they first call
`cancelDriftCorrection()` — which resets `_driftState` to `'idle'`, clears
`_driftPendingRecheck`, cancels any in-flight rate-warp timer, and resets the
playback rate to baseline. Without this, a coordinated snap could land
*during* an unrelated drift correction, get immediately "corrected" again by
that stale in-flight adjustment, and the listener would end up worse off than
before the snap.

Scatter used to be treated as ordinary drift (fed into `requestCorrection()`),
but the simulator showed that's wrong: a scatter offset can be hundreds of ms,
which lands in `'ducking'` territory — and a duck takes ~2.5s to ramp down,
seek, and ramp back up. For that whole window, the listener measures as
hundreds of ms "off" even though nothing is actually wrong, just stale. Treating
it as a forced snap (cancel + immediate seek, like `hard_sync`) fixed this.

## The other golden rule: one reference point per zone

The DJ side has an equivalent invariant: **spatial reassignment changes WHICH
stem a phone plays, never WHEN the set started.** Every `cluster_assign`
broadcast (cluster, ring, remix, movement ticks) must carry the zone's
*existing* `playback_started_at` — `currentStartedAt()` in `playmin.html` —
not a freshly minted "now".

This was the June 2026 spatial-era regression: the four `cluster_assign`
sites each stamped `playback_started_at: new Date(serverNow())` into the
broadcast (and never the DB). A reassigned phone reloaded its stem and seeked
against that private reference — landing at position ~0 — while
`fastDriftCorrect` still measured against the zone's real reference and
duck-yanked it back seconds later. With movement mode rebroadcasting every
2s, the crowd's shared reference fragmented continuously: that's what
"we lost the sync" sounded like. Simulated in `sync-sim.html` ("Cluster
reassigns" toggle): legacy behavior produced ~90,000ms max drift and ~180
audible dips per 20-minute party; the shared-reference fix holds worst-case
drift under ~70ms with zero time spent >100ms off.

Sites that *legitimately* restart playback (track change, scene fire,
go-live) register the new timestamp through `noteStartedAt()` so later
broadcasts (`cluster_assign`, `hard_sync`) reuse it instead of going stale.
And on the listener side, a scene fire must snap **every** listener to the
new reference — including those whose stem didn't change (the
`spatial_config` handler's same-track branch force-snaps when the payload's
timestamp differs from the current one by >250ms).

## The golden rule: one corrector to rule them all

The single most important invariant in this system: **every code path that
wants to nudge a listener's playback position calls `cancelDriftCorrection()`
first, then either `seekPreservingBT()` (instant snap) or
`requestCorrection()` (the tiered warp/duck machine, now verifier-only —
see Step 4).** Nothing calls `seekPreservingBT()` directly without first
clearing any in-flight correction via `cancelDriftCorrection()`.

This matters because BYOB has many independent triggers that *could* want to
adjust position — the 5s drift loop (now itself a `cancelDriftCorrection()` +
`seekPreservingBT()` snap above 300ms, Phase 5p), the 60s health check, waking
the phone from a locked screen, reconnecting to the network, scatter/sweep
spatial effects, slot reassignment, and the mic-based BT-latency verifier's
occasional `requestCorrection()`. If even one of these jumps straight to a raw
seek without clearing whatever another path left in flight, you get two (or
more) corrections actively fighting over the same `audio.currentTime` — each
one "fixing" drift that the other one just introduced. That's the *roving*
bug: audio that endlessly dips and re-seeks, never settling, because no single
part of the system has the full picture of what's currently being corrected.
`cancelDriftCorrection()` resets `_driftState` to `'idle'`, clears
`_driftPendingRecheck`, cancels any in-flight rate-warp timer, and restores
`playbackRate` to baseline — giving whichever path calls it next a clean
slate.

## Calibration: the missing piece for Bluetooth speakers

The seek formula's `_deviceLatencyMs` term only does anything if it's been
*measured*. `calibrateDeviceLatency()` plays a click through the speaker,
listens for it via the mic, and measures the round-trip — this captures each
phone's real Bluetooth output delay (often 100–300ms+, and different per
device/speaker).

Normally this runs automatically, once, the first time a phone is detected
*approaching* a zone (`preSyncApproach()`, GPS-gated) and not yet calibrated.
A phone using the "⚡ ENTER" HUD button to force-join from far outside the
zone skips that approach phase — so `activateZone` has a fallback: if the
`byob_device_latency` localStorage key has never been written, it runs
`calibrateDeviceLatency()` at zone entry, before audio starts.

An *uncalibrated* phone (`_deviceLatencyMs` stuck at `0` on a Bluetooth
speaker) is what an audible "speakers aren't synced" gap looks like even when
`driftState: idle` and `driftMs` near 0 on every device — every phone's
`audio.currentTime` is perfectly converged while the *audible* sound from
each speaker is still offset by its uncompensated output latency.

**Manual re-run**: the HUD has a **📡 CALIBRATE** button (`hudCalibrateNow()`)
— pauses playback, runs `calibrateDeviceLatency()`, then re-seeks
(`cancelDriftCorrection()` + `seekToSync()`) and resumes. Use this when a
cached calibration looks wrong (e.g. the user switched to a different
speaker since it was measured).

## Live debugging: `debug.html`

`broadcastHUD()` sends a snapshot every 3s on the shared `byob_debug`
realtime channel whenever a listener has their HUD panel open. `debug.html`
subscribes and renders one card per device — `currentTime`, `expectedPos`,
`driftMs`, `deviceLatencyMs`, `playbackRate`, `driftState`, plus a
"position delta between devices" readout when 2+ devices are reporting.

`expectedPos` here uses the **same formula** as `computeLagMs()`
(`elapsed + SEEK_STAB_S - _deviceLatencyMs/1000 - _scatterOffsetMs/1000`,
wrapped into `[0, duration)`) — keep these in sync; a simplified/divergent
copy here will make `driftMs` look wrong by a constant offset (previously
off by ~`SEEK_STAB_S`, ~270ms) even when the corrector itself is fine.

## Where this design was proven: `sync-sim.html`

Before porting this design into `listener.html`, it was validated in
`sync-sim.html` — a standalone simulator (no audio, no Supabase, just numbers)
that runs the same randomized "party" through the old scattered-flags
controller and the new single-gate controller side by side, with identical
seeds and event schedules. It includes checkboxes to toggle screen-wake,
scatter, and hard-sync events on/off, so the core 5s drift-correction loop can
be tested in isolation from the "snap" events. Open it locally
(`python3 -m http.server` from the repo root, then `sync-sim.html`) to
re-run or extend these comparisons.
