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
  `computeLagMs()`), and if they've drifted apart by more than 60ms, calls
  `requestCorrection()`.
- **`syncZoneAudio()`** — runs every 60 seconds, does an actual database fetch.
  Its job isn't fine-tuning — it's a safety net that catches things memory
  can miss: "did the zone end?", "did the track change and I missed the
  broadcast?"

These stay deliberately separate: one is a tight feedback loop for staying
glued to the beat, the other is a slow heartbeat for catching structural
changes (zone ended, track changed, etc).

## Step 4: how a correction actually gets applied — `requestCorrection()`

Not all drift is equal, and how you fix it matters for what it sounds like:

- **Drift under 15ms** → ignored. Not worth correcting.
- **Drift 15–500ms** → nudge the *playback speed* by ±3% (`audio.playbackRate`)
  for just long enough to close the gap, then snap back to normal speed.
  At ±3%, this is completely inaudible — the listener never hears a seek,
  the track just very subtly speeds up or slows down for a few seconds.
  This is the **`'warping'`** state.
- **Drift over 500ms** → too big to fix by speeding up — instead, fade the
  volume down, jump (`seek`) to the correct position, fade back up. This is
  the "duck" (`seekWithDuck()`), the **`'ducking'`** state. It's audible as a
  brief dip in volume, which is why you want it to happen as rarely as
  possible.

### One gate: `_driftState`

All of this is governed by a single state variable, `_driftState`
(`'idle'` / `'warping'` / `'ducking'`), through one entry point —
`requestCorrection(lagMs)`:

- If `_driftState === 'ducking'` (mid volume-ramp, audible if interrupted),
  the new request is remembered via `_driftPendingRecheck` instead of acting
  immediately — interrupting a duck would be jarring. Once the duck finishes,
  `settleToIdle()` re-checks drift and fires a fresh correction if still needed.
- If `_driftState === 'warping'`, a new request is **not** deferred — a
  rate-warp is just a `playbackRate` multiplier with no audible artifact, so
  it's always safe to recompute with fresh numbers. (Earlier designs deferred
  this too, which let a stale ±3% rate — chosen for drift that no longer
  exists — keep running in the *wrong direction* for its full remaining
  duration, making things worse instead of better.)
- Otherwise, drift is classified as above and `_driftState` moves to
  `'warping'` or `'ducking'`.

`settleToIdle()` is the piece a naive gate gets wrong: when a correction is
deferred because the gate was busy, *something* must recheck once it frees up
— otherwise drift just accumulates silently. This is what makes "single gate"
actually safe rather than merely "less wrong than scattered flags."

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

## The golden rule: one corrector to rule them all

The single most important invariant in this system: **every code path that
wants to nudge a listener's playback position funnels through
`requestCorrection()` / `seekWithDuck()` / `cancelDriftCorrection()`.**
Nothing calls `seekPreservingBT()` directly except the deliberate,
DJ-coordinated snap moments described above (and those clear any in-flight
correction first).

This matters because BYOB has many independent triggers that *could* want to
adjust position — the 5s drift loop, the 60s health check, waking the phone
from a locked screen, reconnecting to the network, scatter/sweep spatial
effects, slot reassignment. If even one of these jumps straight to a raw seek
without checking whether another correction is already in progress, you get
two (or more) corrections actively fighting over the same `audio.currentTime`
— each one "fixing" drift that the other one just introduced. That's the
*roving* bug: audio that endlessly dips and re-seeks, never settling, because
no single part of the system has the full picture of what's currently being
corrected. Funneling everything through one gated entry point is what gives
that one part the full picture.

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
