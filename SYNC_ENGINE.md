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
  network call). Computes `expected` vs. `audio.currentTime`, and if they've
  drifted apart by more than 60ms, calls `applyDriftCorrection()`.
- **`syncZoneAudio()`** — runs every 60 seconds, does an actual database fetch.
  Its job isn't fine-tuning — it's a safety net that catches things memory
  can miss: "did the zone end?", "did the track change and I missed the
  broadcast?"

These stay deliberately separate: one is a tight feedback loop for staying
glued to the beat, the other is a slow heartbeat for catching structural
changes (zone ended, track changed, etc).

## Step 4: how a correction actually gets applied — `applyDriftCorrection()`

Not all drift is equal, and how you fix it matters for what it sounds like:

- **Drift under 500ms** → nudge the *playback speed* by ±3% (`audio.playbackRate`)
  for just long enough to close the gap, then snap back to normal speed.
  At ±3%, this is completely inaudible — the listener never hears a seek,
  the track just very subtly speeds up or slows down for a few seconds.
- **Drift over 500ms** → too big to fix by speeding up — instead, fade the
  volume down, jump (`seek`) to the correct position, fade back up. This is
  the "duck" (`seekWithDuck()`). It's audible as a brief dip in volume, which
  is why you want it to happen as rarely as possible.

A guard flag (`_driftCorrectionActive` / `_isDucking`) makes sure a second
correction can't start measuring and acting while the first one is still
mid-flight — otherwise the second correction would see the first one's
in-progress rate change as "fresh drift" and pile another correction on top of
it, and the two would fight forever without ever settling.

## Step 5: deliberate "everyone snap together NOW" moments

Separate from continuous drift correction, the DJ can also trigger a
**coordinated hard sync** — "at this exact future timestamp, every phone jumps
to this exact position." Used for: starting a new track, switching spatial
slots, a sweep beam reaching a listener's bearing, or a manual "resync
everyone" command. These don't go through the gentle ±3% warp — they're
supposed to snap immediately, in lockstep, because the DJ has explicitly
commanded it.

Because these are forced, immediate seeks, they first call
`cancelDriftCorrection()` — which cancels any in-flight rate-warp or duck and
resets the playback rate to baseline. Without this, a coordinated snap could
land *during* an unrelated drift correction, get immediately "corrected" again
by that stale in-flight adjustment, and the listener would end up worse off
than before the snap.

## The golden rule: one corrector to rule them all

The single most important invariant in this system: **every code path that
wants to nudge a listener's playback position funnels through
`applyDriftCorrection()` / `seekWithDuck()` / `cancelDriftCorrection()`.**
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
