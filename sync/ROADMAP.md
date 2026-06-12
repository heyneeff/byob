# Sync Engine Extraction Roadmap

**Mission: sync as many Bluetooth speakers as possible, as tightly as possible,
with the broadcast — and keep listener-to-broadcast latency minimal when a DJ is
playing live.**

That mission splits into the two broadcast paths the engine must serve:

1. **Timeline broadcast** (track file + `playback_started_at`): everyone plays a
   shared clock-anchored timeline. Scales to unlimited speakers; "latency to the
   broadcast" is zero by construction (there is no stream, only a shared
   timeline). Tightness = clock sync × BT calibration × drift corrector — this is
   the engine core.
2. **Live broadcast** (WebRTC, DJ mic/line-in): inherently a stream with capture →
   encode → network → jitter-buffer → BT-output latency, *different for every
   listener* and currently uncorrected (drift correction skips `srcObject`).
   Tightness here means **equalized playout**: every speaker outputs the same
   audio at the same acoustic moment, at the lowest delay the slowest path allows.

Plan: detangle the engine out of `listener.html` into a pure, tested module —
refine it until bulletproof — **then** plug it back into the apps. Nothing in
production changes until Phase 5.

Source material — three generations, take the best of each:
- `listener.html` — current corrector (single `_driftState` gate) + BT latency
  calibration. The behavioral core to extract.
- `playmin.html` — server-clock rigor (`serverNow`, `currentStartedAt`/
  `noteStartedAt` single-reference discipline).
- `dj.html` (most stable shipped version) — the reference for the **live path**:
  simple one-RTCPeerConnection-per-listener mesh (`startWebRTCBroadcast`/
  `createOfferFor`, dj.html:1189–1262) and music-correct capture constraints
  (`echoCancellation:false, noiseSuppression:false, sampleRate:48000`,
  dj.html:1343). Its weakness is timing: raw `Date.now()` / `new Date()` for
  `playback_started_at` and `resyncAt` (dj.html:909, 1332, 1372) — keep its
  transport skeleton, replace its clocks with the engine's.

Target layout:

```
/sync
  sync-engine.js       ← pure core: math + state machine, zero I/O
  sync-engine.test.js  ← node:test harness (seeded simulation + invariant tests)
  package.json         ← {"type":"module"} only — enables ESM in node, no npm install
/dj-tools
  dj-tools.js          ← DJ-side timing (serverNow, currentStartedAt, beat quantize),
                         imports shared primitives from ../sync/sync-engine.js
```

Constraint that shapes everything: **no bundler, no npm install** (CLAUDE.md).
`sync-engine.js` is plain ESM — browsers load it via `<script type="module">`,
node imports it natively for tests (`node --test 'sync/**/*.test.js'`). The `package.json` is a
one-line type marker, not a dependency manifest.

---

## What the engine IS (extraction boundary)

**Inside** (pure, deterministic, injected dependencies only):
- Seek/position math: `expectedPosition()`, `computeLag()` — the four-term formula
  (`elapsed + SEEK_STAB_S − deviceLatency − scatterOffset`, mod duration), `SEEK_STAB_S`
- Drift corrector state machine: `_driftState` gate (`idle|warping|ducking`),
  `requestCorrection`, `settleToIdle`, `cancelDriftCorrection`, duck/warp scheduling
- Clock-offset estimator: pure function over `(t0, t1, serverMs)` samples
  (RTT filter + median) — the RPC sampling stays outside
- BPM warp rate calc (`masterBpm / trackBpm`, clamped) and its interaction with
  drift warp base rate
- Scatter / sweep offset computation (bearing → delayMs)
- Calibration result validation (range check on a measured latency — the mic
  hardware part stays outside)

**Outside** (adapters, stay in the host pages):
- HTMLAudioElement (the engine sees a `transport` port: currentTime, playbackRate,
  volume, duration, paused)
- Supabase (`server_now` RPC, channels, zone fetches), localStorage, GPS,
  mic capture, toasts/Boomy, all DOM

This is the same separation `sync-sim.html` already proves works — its corrector
runs on plain numbers with a fake clock. The extraction makes the shipped code and
the simulated code *the same code*.

---

## Known defects to fix in the engine (Phase 3) — found in the current inline code

1. ✅ **FIXED (Phase 3). `computeLagMs` doesn't wrap at the track boundary** (`listener.html:4788`).
   Near the loop point (expected 199.9s, actual 0.1s on a 200s track) lag reads as
   ~±duration → spurious 2.5s duck every loop. `sync-sim.html` already has
   `wrapLag()`; the real listener never got it. — `wrapLag()` is now exported from
   `sync-engine.js` and `computeLagMs()` wraps its result to `[-duration*1000/2, duration*1000/2]`.
2. **Sweep beam-hit seek violates the seek formula** (`listener.html:5478`):
   `seekPreservingBT((elapsed − deviceLatency/1000) % duration)` — missing
   `SEEK_STAB_S` and the `_scatterOffsetMs` term (which sweep itself just set at
   line 5471). The very next `fastDriftCorrect` tick sees ~delayMs of phantom
   drift and re-corrects. One canonical `expectedPosition()` makes this class of
   bug impossible. — **deferred to Phase 5** (production wiring).
3. ✅ **FIXED (Phase 3). BPM-warp position math (audit finding C).** When
   `playbackRate ≠ 1` (master BPM warp), track position advances at `rate ×`
   wall time, but `expectedPosition()` maps elapsed 1:1. Expected position must be
   rate-aware (`elapsed × warpRate`), and warp-correction duration math
   (`lagMs / 0.03`) must account for the base rate. — `expectedPosition()` now takes
   a `warpRate` param (default 1), `computeLagMs()` and `seekWithDuck()`'s recompute
   pass `getBaseRate()` as `warpRate`, and `requestCorrection()`'s `correctionMs` is
   `Math.abs(lagMs) / (0.03 * baseRate)`. Closed in the engine; still needs Phase 5
   wiring before it takes effect in `listener.html`.
4. **Formula duplication**: the four-term expression is inlined at ≥5 sites in
   `listener.html` (3657, 3727, 3754, 3775, 4867) plus `debug.html`'s expectedPos
   plus `sync-sim.html` — three files to keep in step by hand today. — **deferred to
   Phase 5** (production wiring); the engine's `expectedPosition()` is the canonical
   replacement.
5. ✅ **FIXED (Phase 3). `cancelDriftCorrection` doesn't cancel an in-flight duck** (found while
   building the Phase 2 harness — `sync/sync-engine.js`'s `cancelDriftCorrection`,
   ported verbatim from `listener.html:4833-4838`). It clears `_driftWarpTimer`
   (the 'warping' timeout) and resets `_driftState`/`_driftPendingRecheck`, but
   `seekWithDuck`'s ramp `setInterval`s and 5s safety `setTimeout` are local
   closures it has no handle to. If a coordinated snap (hard_sync/scatter/etc.)
   arrives mid-'ducking', the cancel resets state to 'idle' and the snap seeks —
   but the orphaned duck ramp keeps running underneath: it fades volume to 0,
   reseeks (to a now-stale or coincidentally-current `expectedPosition`), fades
   back up, and calls `settleToIdle()` again ~1.5-2.5s later. Audible side effect:
   an unwanted volume dip right after a snap. — `cancelDriftCorrection()` and
   `seekWithDuck()` now share a `driftGeneration` counter; `cancelDriftCorrection()`
   bumps it, and every async callback in `seekWithDuck()` (ramp interval, ramp-down
   `onDone`, the 80ms pause, ramp-up `onDone`, and the 5s duck-safety timeout)
   no-ops if its captured generation is stale.

---

## Phases

**North star (set 2026-06-11):** every phase below should move toward the
same end state — a listener's playback stays within tens of milliseconds of
the broadcaster, for both the timeline (pre-recorded track) path and the live
(WebRTC) path, with corrections frequent and small enough to be inaudible.
Phase 5d (stripped corrector) gets the timeline path there with the simplest
possible mechanism; Phase 7 (live-path latency) does the equivalent for the
live mic-stream path. If a future phase adds complexity back (warp curves,
adaptive thresholds, etc.), it must justify itself against the 5d baseline in
`sync-sim.html` first — "simpler and just as tight" wins by default.

### Phase 0 — Baseline
- Commit the in-flight `debug.html` / `listener.html` changes (drift-spread readout,
  `paused`/`playing` HUD fields).
- Record current sim verdicts (`sync-sim.html`, a few fixed seeds) as the
  behavior baseline to compare against after extraction.

### Phase 1 — Extract the pure core (no behavior change, nothing plugged in)
- Create `sync/sync-engine.js`. Port the corrector verbatim from
  `listener.html:4782–4896` + `computeLagMs` + `seekToSync` math + clock-offset
  median + BPM rate calc, refactored onto injected ports:
  `createSyncEngine({ clock, transport, timers, onEvent })`.
- `timers` injected so tests can run simulated time thousands× real time
  (same trick as sync-sim's tick loop).
- Deliberately port the **current** behavior, bugs included — Phase 2 pins it,
  Phase 3 fixes it. Two-step so every fix shows up as a test diff, not a port
  ambiguity.

### Phase 2 — Test harness (`sync/sync-engine.test.js`, `node --test 'sync/**/*.test.js'`)
- Port sync-sim's seeded party machinery (mulberry32 RNG, listener population with
  clock error / BT latency / hw drift, event schedule) into the test file as a
  reusable scenario runner.
- One test per CLAUDE.md invariant, named for it:
  - new request during `warping` recomputes immediately, never deferred
  - request during `ducking` sets pending recheck; `settleToIdle` re-checks
  - coordinated snaps cancel in-flight correction before seeking
  - <15ms ignored / 15–500ms warp / >500ms duck thresholds
  - duck safety timer releases the gate on a stuck duck
  - scatter is a snap, never fed to `requestCorrection`
  - one `playback_started_at` reference survives cluster reassigns / scene fires
  - seek math: all four terms, mod-duration wrap, negative-elapsed wrap
- Seeded fuzz runs: N seeds × 20-min simulated party, assert p95 drift < threshold
  and zero "roving" (corrections that increase |lag|).
- These tests are the new pre-flight: **`node --test 'sync/**/*.test.js'` green before any sync
  change ships** (replaces "eyeball it in sync-sim" as the gate; the sim stays for
  visual exploration).

### Phase 3 — Bulletproofing (fix the four defects above, tests first) ✅ DONE
- Defects #1, #3, #5 fixed in `sync-engine.js`, each landed as a new failing
  test → fix → green (see "Known defects" above for details). #2 and #4 are
  production-wiring issues, deferred to Phase 5.
- `node --test 'sync/**/*.test.js'` is 25/25 green, including 3 new Phase-3
  unit tests (lag wrap at the loop point, rate-aware `expectedPosition`/
  `computeLagMs`, warp-duration scaling with `baseRate`) and a duck-cancellation
  test for #5. Party fuzz (seeds 1-3) still green at the existing thresholds
  (p50 < 150ms, max < 2500ms) — no regression from the lag-wrap change.
- Remaining from the original scope, not yet done: an explicit edge-case sweep
  (duration ≤ 0, paused transport, latency cache stale after BT device change,
  clock-offset estimator under RTT spikes / all-samples-rejected) and a fuzz
  run with `getBaseRate()` returning a non-1 warp rate end-to-end. Tracked here
  for Phase 4+ rather than blocking the sequence — the rate-aware math is unit
  tested directly (see `requestCorrection: warp correction duration scales
  inversely with baseRate`).

### Phase 4 — Point sync-sim.html at the real engine ✅ DONE
- `sync-sim.html` is now `<script type="module">` and imports
  `createSyncEngine`/`expectedPosition` from `./sync/sync-engine.js` for the
  "new" panel; the legacy controller (scattered flags / fragmented references)
  stays as its own transcription for comparison.
- Each "new" listener gets its own `createSyncEngine()` instance wired to a
  transport adapter over its `{ currentTime, playbackRate, volume }`, plus a
  shared fake-timer queue (same virtual clock as `sync-engine.test.js`) so
  warp snap-back / duck ramps / duck-safety resolve as the sim ticks.
  `playbackStartedAt` starts at `-1` (truthy "just started"), matching the
  party-test convention.
- From here on the sim exercises the shipped code, not a transcription of it.
  Verified via headless Chrome (`google-chrome --headless=new --dump-dom`):
  seed 42 / 8 listeners / 20min — new-panel avg settled drift ~66ms (vs ~55ms
  for the old transcription, vs legacy's ~89.6s), 23 dips, 718 hard seeks,
  0 bypass seeks — consistent with the pre-Phase-4 baseline, no regression.

### Phase 5 — Plug into listener.html
- `<script type="module">` loads the engine and exposes it to the existing classic
  script (`window.SyncEngine = …`). Module scripts run deferred — fine, the engine
  is only needed at zone entry, but `activateZone` must await/verify it's loaded.
- Replace, in order of blast radius:
  1. `computeLagMs` / inline expected-position expressions → `engine.expectedPosition()`
  2. corrector functions (4782–4896) → engine instance with the
     HTMLAudioElement transport adapter
  3. `seekToSync`, sweep/scatter handlers → engine equivalents
- `fastDriftCorrect` / `syncZoneAudio` loop *scheduling* and all Supabase/DOM glue
  stay in listener.html — they become thin adapters.
- `debug.html` imports `expectedPosition` from the engine (kills its formula copy).
- **Cross-device verification (required, can't be done by node:test):** the
  fuzzed simulation models clock error, BT latency, and hw drift as numbers —
  real phones have real BT stacks, real `outputLatency`, and real backgrounding
  behavior the model can't capture. Before/after the swap, run the same fixed
  multi-phone rig (mix of iOS + Android, at least one BT speaker, at least one
  wired/earpiece) and watch `debug.html`'s drift-spread readout across all of
  them simultaneously:
  - baseline run on the current inline corrector → record drift-spread over a
    multi-minute set with sweep/scatter/hard_sync/track-change/BPM-warp events
  - same rig, same event sequence, on the engine-backed build → drift-spread
    must match or improve, and no device should show a "roving" pattern
    (drift sign flips that never settle)
  - repeat with a phone backgrounded/screen-locked through a `visibilitychange`
    cycle, and with a phone going offline/online (reconnect path)
  - this is the gate for Phase 5 — don't merge on simulation results alone.
  - **Post-5d**: the corrector has no `warping`/`ducking` states left to
    observe in the periodic loop — `driftState` should read `idle` almost
    always, with `driftMs` oscillating in a tight band around
    `±SNAP_THRESHOLD_MS` (60ms) via frequent small `seekPreservingBT` snaps.
    The pass criterion is simply: does `driftMs` stay bounded near ±60ms
    indefinitely, with no flat multi-second plateaus (the 5b/5c/5d failure
    signature)?

### Phase 5a — drift-check loop liveness (found via first debug-export session, 2026-06-11)
A real-party `debug.html` CSV export (Record/Export added this session) showed
`driftState: idle` for **7 of 10 devices** for minutes at a time despite drift
of -1.5s to -310s (and growing unbounded on 4 of them — `currentTime` frozen
while `expectedPos` kept advancing). The corrector math (Phase 3) was never the
problem; `requestCorrection()` simply wasn't being *called*:
- `fastDriftCorrect()` ran on `setInterval(..., 5000)` only. Browsers throttle
  `setInterval` on backgrounded/screen-locked tabs — BYOB's primary listening
  mode (phone as BT speaker, screen off) — sometimes to less than once/minute.
- `_handleStall()` (stall/waiting/suspend recovery) called `audio.play()` to
  resume but never reseeked, so a multi-minute stall left `currentTime` frozen
  at its pre-stall value even after "recovery."

Fixes landed in `listener-engine.html` (not yet ported to `listener.html` —
this rides along with the Phase 5 cross-device test):
- `audio.addEventListener('timeupdate', ...)` now triggers `fastDriftCorrect()`
  (throttled to ~5s via `_lastDriftCheckAt`) — `timeupdate` fires off the media
  clock, not the JS timer queue, so it survives backgrounding. The
  `setInterval(fastDriftCorrect, 5000)` stays as a redundant backstop.
- `_handleStall()` now cancels any in-flight correction and reseeks to
  `expectedPosition()` via `seekPreservingBT()` before resuming, same as a
  coordinated snap — same pattern as `audio.addEventListener('error', ...)`.
- `broadcastHUD()` now also sends `visibilityState`, `lastDriftCheckAgoMs`,
  `readyState`, `stallCount` so the *next* debug export can directly confirm
  the check loop is alive on backgrounded devices (look for
  `lastDriftCheckAgoMs` staying under ~6-7s even when `visibilityState:hidden`).
  `debug.html` records and renders all four.

**Verification needed**: run another `debug.html` Record/Export session on
`listener-engine.html` with phones screen-locked — confirm `lastDriftCheckAgoMs`
stays bounded and no device shows unbounded/flat drift like the 2026-06-11
session. Roll into the Phase 5 cross-device gate.

### Phase 5b — recover from `audio.paused` directly (2nd debug session, 2026-06-11 17:41)
The Phase 5a fix worked — `lastDriftCheckAgoMs` stayed bounded (~0.5-4.5s) even
on `hidden` tabs, confirming `fastDriftCorrect` is now reliably ticking. But
drift was *still* unbounded on both builds (`dev_lpnz7e` reached -232s,
`dev_w2wif2` -95s, `dev_ytqxw8` +234s) — `driftState` stuck `idle` throughout.

Root cause: `audio.currentTime` was completely frozen (e.g. pinned at 78.431
for `dev_lpnz7e` for 100+ seconds while `expectedPos` climbed past 200) —
`audio.paused === true`, and `fastDriftCorrect` just `return`ed on
`audio.paused` every tick, doing nothing. `_handleStall` only listens for
`stalled`/`waiting`/`suspend` events, which apparently don't fire for whatever
paused these elements (OS/BT-driven pause, or a `pause` event with no
preceding stall event). This is the same failure mode in `dev_w2wif2`
(production `listener.html`, not just the engine build) — pre-existing, not a
Phase 5a regression.

Fix in `listener-engine.html`:
- New shared `_resumeAndReseek()` — `audio.play()` then
  `cancelDriftCorrection()` + `seekPreservingBT(expectedPosition(...))`.
- `fastDriftCorrect()` now checks `audio.paused` itself: if `_webAudioPlaying`
  is true but `audio.paused`, increment `stallCount` and call
  `_resumeAndReseek()` instead of silently bailing.
- `_handleStall()` now just calls `_resumeAndReseek()` (deduped).

**Verification needed**: another Record/Export session — watch for `paused`
flipping to `true` with `stallCount` incrementing and `driftMs` recovering
toward 0 afterward, instead of the unbounded climb seen in both 2026-06-11
sessions. If this fixes it, this same `_resumeAndReseek` pattern should be
ported to `listener.html` too (it's a real production bug, independent of the
engine wiring) — flag for after the Phase 5 gate.

### Phase 5c — `_isMuted` silently disabled drift correction entirely (3rd debug session, 2026-06-11 17:58)
Phase 5b's `_resumeAndReseek` is working — `stallCount` increments and large
excursions (e.g. `dev_bjqjtt` -157900ms) do recover toward smaller values.
But on most engine devices, drift then settles onto a *stable, non-zero*
plateau (e.g. -2580ms, -2702ms, -98556ms) for minutes at a time, with
`driftState` stuck `idle` the whole time despite `|driftMs| >> 60ms`. Two
devices showed this for 130+ samples each (`dev_bjqjtt`, `dev_nj1jr5`).

`lastDriftCheckAgoMs` stayed bounded throughout, which looked like Phase 5a
was insufficient — but `_lastDriftCheckAt = performance.now()` is the *first*
line of `fastDriftCorrect()`, so it updates even when every subsequent line
bails out. It does NOT prove `computeLagMs()`/`requestCorrection()` ran.

Root cause: `fastDriftCorrect()` had `if (!audio.duration || _isMuted) return;`
— a muted listener (the normal state for test phones in close proximity, to
avoid feedback) never gets drift-corrected at all. The plateau jumps are from
elsewhere (likely the 60s `syncZoneAudio()` health check reseeking); between
those jumps, drift just sits wherever it landed, forever, while muted.

`_isMuted` only needs to gate things that are *audible* — `seekWithDuck()`
ramps `transport.volume`, but `audio.muted = true` overrides volume entirely,
so a duck while muted is silent regardless. There's no reason to skip
correction.

Fix: removed `_isMuted` from the `fastDriftCorrect()` bail condition in both
`listener-engine.html` and `listener.html` (production had the same bug, with
the added `audio.paused` check folded into the same line — now split per
Phase 5b's pattern). Added `isMuted` to both builds' `hud_data` payload and
`duration`/`isMuted` to `debug.html`'s `REC_COLS` + sync card, so a muted
device's drift trajectory is now distinguishable from an unmuted one.

**Verification needed**: next session, confirm `driftState` actually
transitions to `warping`/`ducking` on muted devices and that the long flat
plateaus disappear (drift should oscillate near 0 like an unmuted device,
not sit at a constant non-zero offset for minutes).

**Update (4th debug session, 2026-06-11 18:30)**: Phase 5c shipped the fix,
but the new session showed `requestCorrection`'s warp/duck still doesn't
reliably engage even when unmuted (`isMuted: false`) — `dev_297vo4`
(chrome-ios) sat at a flat -47080ms drift for 3 minutes, then -2582ms for
another 3 minutes, `driftState` stuck `idle` throughout despite
`lastDriftCheckAgoMs` confirming the loop runs and `audio.currentTime`
advancing normally (not frozen — a different failure mode than 5b's stall).
One device (`dev_hypy6g`, production `listener.html`/safari) DID show
`driftState` transitioning (`warping:97 ducking:3 idle:32` over 132 samples)
and converged to -224ms by the end — so the warp/duck path *can* work, but
is unreliable across builds/browsers in a way we couldn't pin down from the
telemetry alone.

### Phase 5d — strip the warp/duck state machine entirely (2026-06-11)
The user recalled that the May 13 2026 `listener.html` (`6f4f5b0`) — the one
the manual HUD-sync workflow worked great against — had **no** `_driftState`,
no rate-warping, no ducking. Its entire corrector was a 10s loop:
`if (|drift| > 0.3s) seekPreservingBT(expected)`. Given three sessions of the
warp/duck state machine getting stuck in `idle` for unclear reasons, and the
user's go-ahead to strip it down, Phase 5d drops `requestCorrection`'s
warp/duck bands from the periodic corrector entirely.

Validated in `sync-sim.html` first (added a third "stripped" controller +
panel, same seed/event schedule as legacy/new): stripped settles to ~65ms avg
drift — statistically identical to the warp/duck design's 66ms — with **zero**
audible volume dips (vs 23 for warp/duck), at the cost of more frequent quick
180ms `seekPreservingBT` ramps (891 vs 718 hard seeks). Net: same precision,
strictly less audible.

Implemented in `listener-engine.html`:
- New `SNAP_THRESHOLD_MS = 60` and shared `_expectedNow()` helper (factored
  out of `_resumeAndReseek`, also used by `fastDriftCorrect`).
- `fastDriftCorrect()`: when `|lagMs| >= 60`, call `cancelDriftCorrection()` +
  `seekPreservingBT(_expectedNow())` directly — no `requestCorrection()`.
- `visibilitychange` resync handler: same direct snap, same threshold,
  replacing its `requestCorrection()` call.
- `requestCorrection`/`_driftState`/warp/duck remain in `sync/sync-engine.js`
  and are still used by the mic-based auto-sync verifier (`_syncState`,
  unrelated state machine) — only the periodic drift loop stopped using them.

`node --test` still 25/25 (engine module unchanged). Not yet ported to
production `listener.html` — validate this on `listener-engine.html` first
via another debug session, watching for `driftMs` staying within ~60-100ms
band via frequent small snaps instead of the old flat multi-second plateaus.

**Update (5th debug session, 2026-06-11 21:05)** — first run after Phase 5d
shipped. All 5 devices were `listener-engine`/chrome-ios. Result: **the strip
didn't fix it**. `driftMs` is not bounded near ±60ms — it's pinned at large,
rock-solid CONSTANT offsets for minutes at a time (e.g. `dev_9kxjhd`: -1491 to
-1494ms steady for 58s straight, jitter <3ms; `dev_l06s91`: -1383ms for ~20s,
then -1755ms for ~20s, then a track change, then -2585ms steady for the
remaining ~3 minutes). `|lagMs|` is 1383-2585ms — far above `SNAP_THRESHOLD_MS
= 60` — every single 5s tick, with `driftState='idle'`, `syncState='idle'`,
`isMuted=false`, `stallCount=0`, `playbackRate=1.000`, `audio.currentTime`
advancing normally (not frozen). If `seekPreservingBT(_expectedNow())` were
firing and taking effect, drift would snap toward 0 every ~5s and we'd see it
oscillate in a small band — instead it's perfectly flat, meaning either the
snap branch isn't being reached, or `audio.currentTime = x` is being silently
ignored on chrome-ios for this audio element.

### Phase 5e — instrument the snap itself (2026-06-11)
Rather than guess further, added direct verification to
`listener-engine.html`'s `fastDriftCorrect()`: when `|lagMs| >= 60`, capture
`before = audio.currentTime` and `target = _expectedNow()`, call the snap as
before, then 250ms later read `audio.currentTime` again and broadcast:
- `snapCount` — running total of snap attempts
- `lastSnapMovedMs` — how much `audio.currentTime` actually changed
  (`after - before`); should be roughly `target - before` if the seek worked,
  ~0 if it was ignored
- `lastSnapVerifyMs` — how close `audio.currentTime` landed to `target`
  after the seek (`after - target`); near 0 = seek worked and held

Surfaced in `debug.html`'s sync card (`snaps`/`snapVerify`/`snapMoved` rows,
`snapVerify` flagged `bad` if |value| > 100ms) and added to `REC_COLS`.

`node --test` still 25/25 (no engine changes — instrumentation only).

**Verification needed**: next session on `listener-engine.html`/chrome-ios —
if `snapCount` climbs but `lastSnapMovedMs` stays ~0 while `driftMs` stays
flat, the seek is being silently ignored (likely a chrome-ios `audio.currentTime`
quirk — next step would be trying `audio.fastSeek()` or a pause/seek/play
sequence). If `lastSnapMovedMs` ≈ `target - before` but `driftMs` is STILL
flat afterward, the seek works but something re-seeks back, or `_expectedNow()`
itself is computing the wrong target (formula bug, not a browser quirk).

**`baseline-phase5e` tag** — marks this commit (`3b9f489`) as a recovery
checkpoint: Phase 5d+5e shipped, drift down to a stable ~1.4-2.6s constant
offset (vs. multi-minute plateaus / six-figure-ms excursions pre-5d), no
audible volume dips. `git checkout baseline-phase5e` to come back here if a
later attempt at closing the remaining ~1.4s gap regresses things.

**Update (6th debug session, 2026-06-11 21:37)** — 5 chrome-ios
`listener-engine` devices. 4 of 5 sat at a rock-solid CONSTANT drift around
-1418 to -1477ms (essentially the same ~1.4s gap as session 5), all with
`snapCount=0` for the entire session — `computeLagMs()` (the engine's lag,
which gates the snap) is evidently NOT returning the same ~1400ms that
`driftMs` (broadcastHUD's independently-computed `currentTime - expectedPos`)
reports, even though both call `expectedPosition()` with what looks like
identical inputs. The 5th device (`dev_peq7l4`) showed a DIFFERENT, known
issue: `audio.currentTime` frozen at 11.957 for 66+ seconds while `expectedPos`
climbed normally (drift growing linearly from -18564 to -81660), then a track
loop snapped `currentTime` to 0.242 (drift -96380) — this is the same
frozen-`currentTime`-despite-`audio.paused===false`-or-`_webAudioPlaying`-out-
of-sync pattern as `dev_t42o7l` in session 4. Treated as a separate, lower-
priority issue from the main ~1.4s gap (it self-recovers on track loop/change,
just badly out of sync until then).

### Phase 5f — instrument computeLagMs() vs broadcastHUD's driftMs (2026-06-11)
To resolve the `snapCount=0` mystery: `fastDriftCorrect()` now also stores
`window._engineLagMs` — the raw `computeLagMs()` result (or `null` if the
engine bailed) — on every tick, regardless of whether a snap fires. Broadcast
as `engineLagMs` in HUD payload, shown on `debug.html` next to `DRIFT`
(flagged `warn` if it differs from `driftMs` by >100ms).

`node --test` still 25/25 (instrumentation only).

**Verification needed**: next session — compare `engineLag` to `DRIFT` on the
4 "stuck at ~1.4s" devices.
- If `engineLag` ≈ `—` (null) the whole time → `computeLagMs()`'s bail
  condition (`!ctx.playbackStartedAt` / `!transport.duration` /
  `transport.hasSrcObject?.()`) is true when `driftMs` says it shouldn't be —
  likely `getContext()`/`activeZone` desync between the module and classic
  script scopes.
- If `engineLag` reads ~0-50ms while `DRIFT` reads ~-1400ms → the two
  `expectedPosition()` calls are getting different `deviceLatencyMs` /
  `scatterOffsetMs` / `warpRate` / `elapsedS` inputs despite reading the same
  globals — narrow down which input differs.
- If `engineLag` ≈ `DRIFT` (~-1400, matches) → `computeLagMs()` IS returning
  the right value and the `>= SNAP_THRESHOLD_MS` branch should be entered;
  re-check `snapCount` — if it's still 0 here, the bug is in the `if`
  condition or `Math.abs()` itself (very unlikely, but would mean re-reading
  the literal code running on-device vs. this source).

**Update (7th debug session, 2026-06-11 22:05)** — first session with
`sync_event` markers (track_change/hard_sync) and `engineLagMs`. Result:
`engineLagMs` matches `|driftMs|` essentially exactly throughout (e.g.
-4452/4452, -1594/1594, -2611/2611) — `computeLagMs()` IS returning the
correct large lag. The `>= SNAP_THRESHOLD_MS` branch is entered every tick
(|lag| 1400-141000ms, all >> 60), **yet `snapCount` is STILL 0 for every
device, the entire session** — confirming the bug is inside the snap branch
itself: something throws before `window._snapCount++` (which sat as the
*first* line, so even the counter not incrementing means the throw must be
happening... re-examine: counter was moved to first line in 5g, see below).

This session also had far more `track_change`/`hard_sync` events (DJ actively
testing) than the baseline session — explains the user's "less tight than
baseline" feel: each track change produces a transient huge-lag window
(observed: -2611ms → -77667ms after one track_change, -4452ms → -141809ms
after another) that — because snaps still don't fire — never resolves until
the NEXT track change. More events = more time spent in these large-lag
windows. One more wrinkle seen mid-transition: `driftMs` and `engineLagMs`
sometimes disagree by exactly one ~3s sample tick right after a track change
(one reads the new `activeZone.playback_started_at`, the other still reads
the old one for one cycle) — a transient staleness race, separate from the
snap-not-firing bug.

### Phase 5g — try/catch around the snap, surface the thrown error (2026-06-11)
Restructured `fastDriftCorrect()`'s snap branch: `window._snapCount++` now
happens immediately on entering the `>= SNAP_THRESHOLD_MS` branch (so a
nonzero `snapCount` next session will at least confirm the branch is
reached — if it's STILL 0, the `if` condition itself isn't true on-device
despite what `engineLagMs` shows, which would be a stale-deployment question).
The rest of the snap body (`_expectedNow()`, `cancelDriftCorrection()`,
`seekPreservingBT()`, the verify-readback `setTimeout`) is wrapped in
try/catch; any thrown error's `.message` is stored in `window._lastSnapError`
and broadcast as `snapError`, shown on `debug.html` (flagged `bad` if
non-empty) and recorded in the CSV. Leading hypothesis for the throw:
`cancelDriftCorrection()`'s `transport.playbackRate = getBaseRate()` or
`seekPreservingBT`'s `transport.currentTime = safeTime` receiving `NaN` from
`_expectedNow()`/`_getBpmWarpRate()`, which throws
`TypeError: ... non-finite` when assigned to an `HTMLMediaElement` property.

`node --test` still 25/25 (instrumentation only).

**Verification needed**: next session — `snapCount` should now be nonzero.
If `snapError` is non-empty, that error message is the actual root cause —
fix it directly (likely a NaN guard in `_expectedNow()` or `_getBpmWarpRate()`).
If `snapCount` is nonzero and `snapError` is empty but drift still doesn't
close, check `lastSnapMovedMs`/`lastSnapVerifyMs` as originally planned in 5e.

### Phase 5h — root cause found: unbound `timers.clearTimeout` Illegal Invocation (2026-06-11)
8th debug session confirmed the leading hypothesis was wrong but surfaced the
real bug: `snapError = "Can only call Window.clearTimeout on instances of
Window"` on EVERY snap attempt, for every device, all session
(`snapCount` climbing to 40-91, `snapError` non-empty every time).

Root cause: in `listener-engine.html`'s `createSyncEngine({...})` setup, the
`timers:` object passed bare unbound references —
`{ setTimeout, clearTimeout, setInterval, clearInterval,
requestAnimationFrame, now: () => performance.now() }`. Calling
`timers.clearTimeout(id)` invokes it with `this === timers`, not
`this === window`. WebKit's branded `Window.prototype.clearTimeout` (and the
other four) reject that with "Illegal invocation" before doing anything else.

`cancelDriftCorrection()`'s very first line is `timers.clearTimeout(driftWarpTimer)`
— so it threw immediately, every time, meaning `seekPreservingBT()` was NEVER
reached across the entirety of Phases 5d-5g. This is THE primary bug: every
constant-offset drift pattern seen in sessions 5-8 (~-1.4 to -2.6s baseline,
huge transient excursions after track changes that never resolved) is
explained by snaps never actually executing despite `computeLagMs()` /
`engineLagMs` correctly showing the lag every tick.

**Fix**: bind all five timer functions to `window`:
```js
timers: {
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: window.clearTimeout.bind(window),
  setInterval: window.setInterval.bind(window),
  clearInterval: window.clearInterval.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  now: () => performance.now(),
},
```

Verified via headless Chrome (iframe harness calling
`window.SyncEngine.cancelDriftCorrection()` directly): now returns
`{cancelOk:true}` instead of throwing. `node --test` still 25/25 — the engine
module itself was always correct; this was purely a caller-side wiring bug.

**Verification needed**: next session — `snapError` should now be empty,
`snapCount` should increment, `lastSnapMovedMs` should be close to
`target - before` (the snap actually moves `currentTime`), and
`lastSnapVerifyMs` should be near 0 (the seek held 250ms later). `driftMs`/
`engineLagMs` should finally start closing toward the ±60ms `SNAP_THRESHOLD_MS`
band instead of sitting at a constant multi-second offset.

### Phase 6 — /dj-tools/dj-tools.js
- Strip the DJ side down to its core function: put a timeline or a live stream on
  the air with correct timing. Everything else (deck UI, scenes, crowd map) stays
  in the host page.
- Extract from `playmin.html`: `serverNow`/clock-offset (1069–1086, currently a
  near-copy of the listener's), `noteStartedAt`/`currentStartedAt` (3234–3238),
  beat quantization (`beatMs − serverNow() % beatMs`), sweep/scatter offset math.
- Extract from `dj.html` (most stable): the WebRTC broadcast mesh
  (`startWebRTCBroadcast`, `createOfferFor`, `stopWebRTCBroadcast`) and the
  music-correct capture constraints — re-timed onto the engine's server clock
  (no more raw `Date.now()` in `resyncAt` / `playback_started_at`).
- Import the clock estimator and position math from `../sync/sync-engine.js` —
  one formula, both sides of the radio.
- `playmin.html` consumes it the same `<script type="module">` way.

### Phase 7 — Live-path latency: measure, then equalize
The live path is where "close to the broadcast" is won or lost. Sequenced after
the timeline engine is solid because it reuses two of its parts: the server clock
and `_deviceLatencyMs`.

1. **Measure first.** Instrument end-to-end live latency per listener:
   DJ stamps capture time (server clock) → listener compares against acoustic
   output estimate (`jitterBufferDelay`/`playoutDelay` from
   `RTCRtpReceiver.getStats()` + `outputLatency` + calibrated `_deviceLatencyMs`).
   Broadcast it on `byob_debug`; render per-device live latency in `debug.html`.
   No tuning until these numbers exist.
2. **Shrink the floor.** Capture constraints from dj.html, `latency:0` hint in
   `getUserMedia`, opus `maxplaybackrate`/`ptime` SDP munging if measurement shows
   encode/packet overhead matters. Target: lowest stable per-listener delay.
3. **Equalize across speakers.** Two adjacent phones on BT speakers with different
   jitter buffers sound like slapback echo even at low absolute latency. Pick a
   zone-wide playout deadline `D` (slowest healthy listener + margin, DJ-visible);
   each listener trims its receiver buffer (`jitterBufferTarget` /
   `playoutDelayHint` where supported) so that
   `network + buffer + outputLatency + deviceLatencyMs ≈ D`. The BT calibration
   number finally pays off on the live path too.
4. **Scale ceiling.** A phone-hosted mesh caps at roughly 6–10 peer connections.
   Decide the over-cap strategy *after* measuring real limits: SFU (metered.live
   already provides TURN; their SFU is the natural upgrade) vs. timestamped-chunk
   relay through Supabase (trades ~2–5s latency for unlimited scale and lands back
   on the timeline engine's math — acceptable for "radio" sets, not for live
   scratching; possibly offered as a DJ-selectable mode).
- Engine's role in all of this: pure functions for the latency budget
  (`playoutDeadline(D, stats, deviceLatencyMs) → bufferTarget`) live in
  `sync-engine.js` and get tested in the harness like everything else.

### Phase 8 — Docs & guardrails
- Rewrite `SYNC_ENGINE.md` around the module (it's the design doc for
  `sync/sync-engine.js` now).
- Update CLAUDE.md: file roles, invariants ("seek formula lives in one place"
  replaces "keep three copies in step"), and the new pre-flight
  (`node --test 'sync/**/*.test.js'`).
- Mark the superseded inline regions of `listener.html` history in the Roadmap
  session log.

---

## Order of operations summary

Phases 1–4 touch nothing the party runs on — pure addition. Phase 5 is the only
risky step on the timeline path, and by then every behavior it swaps in has been
pinned by tests and fuzzed. If Phase 5 misbehaves on real phones, the diff is
adapter wiring, not engine logic.

Phases 6–7 then rebuild the DJ side on the proven engine: dj.html's stable
WebRTC skeleton + the engine's clocks first (6), then the live-latency
measure → shrink → equalize → scale ladder (7). Live-path work is deliberately
last: equalized playout depends on the server clock and BT calibration being
trustworthy, and those are exactly what Phases 1–5 harden.

### Phase 5i — restore the tiered corrector now that snaps actually fire (2026-06-11)
9th debug session (post-5h): `snapError` empty, but `driftMs` sat at a
steady -150 to -190ms for every device, and the user reported the music
"ducking and clipping" constantly — every ~3s, nonstop, audible.

With Phase 5h's fix landed, `fastDriftCorrect()`'s Phase 5d snap-everything-
`>=60ms` branch was now actually executing `seekPreservingBT()` every tick.
A steady ~150-190ms offset is squarely inside the engine's 15-500ms
"warping" band — it should be closed with an inaudible ±3% playbackRate
nudge, not a seek. Instead every tick was muting, jumping `currentTime`,
and ramping volume back — the "clip" the user heard, forever, for a drift
that was never going to be fixed by another identical seek next tick.

Phase 5d's strip-down was validated back when the unbound-`timers` bug
(5h) meant the snap silently threw and did nothing — so "no audible volume
dips" in that validation was really "the corrector never ran at all", not
evidence the snap-only design was sound once snaps started working.

**Fix**: `fastDriftCorrect()` now calls `requestCorrection(lagMs)` directly
(the engine's existing tiered corrector, already used elsewhere e.g. line
~5031) instead of a hand-rolled threshold+snap:
- `<15ms` → ignored
- `15-500ms` → `'warping'`: ±3% `playbackRate` nudge, inaudible, visible in
  debug.html as `driftState='warping'` and `rate` != 1.000
- `>500ms` → `'ducking'`: fade-down/seek/fade-up (~2.5s), visible as
  `driftState='ducking'`

`SNAP_THRESHOLD_MS` (now 500, was 60) is kept only for the two coordinated
recovery paths — `_resumeAndReseek()` (after a stall) and the
`visibilitychange` wake handler — where audio is already silent/paused and
an instant seek is the right call, not a steady-state drift response.

Removed the now-dead Phase 5e/5g verification fields (`snapError`,
`lastSnapVerifyMs`, `lastSnapMovedMs`) from `broadcastHUD()` and
`debug.html` — they existed to diagnose the 5h throw, which is fixed and
covered by `node --test`. `snapCount` renamed `duckCount`, incremented only
when `|lagMs| > 500` (i.e. a real duck), shown in debug.html as `ducks`.

`node --test` still 25/25 (engine module unchanged — only the caller's
choice of which engine function to call changed).

**Verification needed**: next session — `driftState` should show
`'warping'` (with `rate` ~0.970/1.030) for the steady ~150-190ms offsets
seen this session, closing smoothly over a few seconds with NO audible
clip/duck. `driftState='ducking'` (and an audible-but-brief fade) should
only appear right after track changes / hard_sync, where lag can be large.

### Phase 5j — track-change duck loop: bogus lag from stale duration/currentTime (2026-06-11)
10th debug session (post-5i): the warp corrector works well — `dev_oasl08`
and `dev_2njek4` mostly sat in `driftState='warping'` with `rate=1.030`,
drift oscillating in the tens-to-low-hundreds of ms (10-400ms), closing and
reopening smoothly with no reported clipping during steady playback. User
confirmed normal correction (~10-130ms) was smooth, but **track changes
("new song") still "got really tripped up"** with audible ducking/clipping.

CSV showed why: at each track change, `dev_oasl08` and `dev_2njek4` both
flip to `driftState='ducking'` with `driftMs`/`engineLagMs` around
**-225820ms** (≈ -225.8s) or **-2776/2777ms**, and STAY ducking — `duckCount`
climbing every ~2.5s (1→3→5→7→9→11→13→15→17→19) — for 30-50+ seconds,
i.e. continuous fade-down/seek/fade-up on a loop.

Root cause: `buildZoneChannel`'s track-change handler does
`activeZone = { ...activeZone, ...zn }` (new `playback_started_at`)
*synchronously*, then calls `loadTrack()`, which sets `audio.src` and calls
`audio.load()` — `audio.duration`/`audio.currentTime` stay at the OLD
track's values until `'loadedmetadata'` fires (async, can take seconds on a
slow BT connection). If `fastDriftCorrect()` runs in that window,
`computeLagMs()` combines the NEW `playback_started_at` with the OLD
`duration`/`currentTime`, producing a lag of plus-or-minus the old track's
near-full duration — `>500ms` every time, so it ducks; the duck's recompute
(`seekWithDuck`'s `safeTime`) happens after only ~1.5s, often still before
`loadedmetadata`, so it can land on another bogus value and duck again —
looping until the new track finally loads.

**Fix**: `loadTrack()` sets `window._trackLoading = true` on entry, cleared
inside the `loadedmetadata` handler right after `seekToSync()`.
`fastDriftCorrect()` and the `visibilitychange` wake-snap both bail early
while `window._trackLoading` is true — no drift correction runs against a
stale duration/currentTime pair.

`node --test` still 25/25 (engine module unchanged — purely a caller-side
sequencing guard).

**Verification needed**: next session — on a track change, `driftState`
should go `idle`/whatever it was → (briefly nothing, while `_trackLoading`)
→ `idle` or a single small `warping`/`ducking` once the new track's real
drift is known, NOT a multi-duck loop with `driftMs` in the hundreds-of-
thousands of ms.

### Phase 5k — duck loop when the seek doesn't land: stuck-duck fallback to warp (2026-06-11)
11th debug session (post-5j, no track changes this session — purely
steady-state). User reported "desynced the whole time" and "really jarring
clipping". `dev_z0194x`/`dev_jpi7be` showed a slow sawtooth (warp closes the
gap, then it reopens by a similar amount — separate, lower-priority tuning
issue, not yet addressed). But `dev_kgfip9` was the dominant problem:
`driftState='ducking'` for the ENTIRE ~3.5min session, `driftMs` pinned at a
constant -524 to -541ms, `duckCount` climbing 3→65. `currentTime` and
`expectedPos` advanced in lockstep at the same rate the whole time — the gap
never moved despite 15+ duck attempts.

Root cause: on this device/browser, `seekWithDuck`'s `transport.currentTime
= safeTime` (an `<audio>` element routed through Web Audio via
`createMediaElementSource`) is a silent no-op — the seek doesn't take. Each
duck fades down, "seeks" (no-op), fades back up, and 2.5s later the same
~525ms gap triggers another duck. Continuous fade/seek/fade-up = the
"jarring clipping".

**Fix** (caller-side, `fastDriftCorrect()`): track `_lastDuckLagMs` /
`_stuckDuckCount`. If two consecutive duck-triggering lags are within 30ms
of each other (the previous duck didn't move the needle), `cancelDriftCorrection()`
then `requestCorrection(Math.sign(lagMs) * 499)` — forces the 15-500ms
"warping" branch (a sustained +/-3% rate nudge) instead of ducking again.
Slower (closing a 500ms gap takes ~17s at 3%) but completely inaudible —
versus clipping every ~2.5s forever.

`node --test` still 25/25 (engine module unchanged — caller-side choice of
which correction to request).

**Verification needed**: next session — `dev_kgfip9`-type devices should
show `driftState='ducking'` at most twice in a row for a given persistent
large gap, then switch to `driftState='warping'` with `rate`~0.970/1.030
sustained for ~15-20s while the gap closes, with NO further fade/clip. Also
revisit the `z0194x`/`jpi7be` sawtooth — if it persists once kgfip9-style
clipping is gone, it's the next thing to dig into (possibly BPM-warp rate
recompute timing or a `_scatterOffsetMs` that's changing periodically).

### Phase 5l — stop ducking entirely from the periodic corrector (2026-06-11)
12th debug session (post-5j/5k). User: "CLoser, still a bit of clipping, but
much closer to what we want! until it's syncing in and out now upon a new
song." The CSV contained `sync_event` markers for both `track_change` and
`hard_sync`. Around each event, ALL THREE devices saw a transient
bogus-huge-lag spike (tens to hundreds of thousands of ms, `driftState`
briefly `'idle'` then re-evaluated) — consistent with 5j's stale-context
race, but this time around `hard_sync`/`resync_at` too, not just track
loads.

Two of the three devices recovered cleanly within ~10-15s
(`dev_cpswyc` back to normal warping oscillation, `dev_wfyl5s` settling to
`driftMs` -8 to -17ms, `idle`, for the rest of the session — proof the
corrector CAN land essentially perfect sync). But `dev_t0sqxy` landed in
`driftState='ducking'` from 23:29:14 onward and NEVER recovered: `driftMs`
*grew* roughly -400ms every ~12-16s (-2786 -> -3197 -> -3609 -> -4006 ->
-4409 -> -4826), `duckCount` climbing 3->23, continuous clipping through the
end of the session (~60s). 5k's stuck-duck check didn't catch this — it
requires two consecutive duck-triggering `|lagMs|` values within 30ms of
each other, but here each duck cycle's lag differed by ~400ms from the last.

At this point the user said directly: "i really feel like we shouldn't keep
ducking at all. i had introduced it[duck], to replace the clipping, but best
case scenario is it doesn't do other[harm], either" — i.e. ducking was meant
to fix clipping, but across 5i/5k/5l it has only ever BEEN the clipping (a
steady drift duck-looping every ~3s in 5i pre-fix, a no-op-seek duck-looping
forever in 5k, and now a growing-drift duck-loop in 5l) — there's no
scenario observed yet where it actually helps.

**Fix** (caller-side, `fastDriftCorrect()`): the `>500ms` branch no longer
calls `requestCorrection(lagMs)` with the raw value (which enters the
engine's `'ducking'` tier). Instead it clamps to
`requestCorrection(Math.sign(lagMs) * 499)` — always the `15-500ms`
"warping" tier, a sustained +/-3% rate nudge. This:
- Never fades/seeks/fades — no clipping, ever, from the periodic corrector.
- Re-evaluates fresh every tick (per the engine's "a new request during
  'warping' recomputes immediately" rule), so a one-tick bogus spike around
  a `sync_event` self-corrects on the very next tick instead of latching into
  a multi-duck loop.
- For genuinely large real drift, closing ~500ms takes ~17s at 3% — slower
  than a 2.5s duck, but always inaudible. Real large drift should be rare in
  steady state (coordinated snaps via `seekPreservingBT` after
  `cancelDriftCorrection()` handle the big jumps at track-change/hard_sync —
  this corrector only needs to mop up residual/bogus drift between those).

Removed the now-dead Phase 5k stuck-duck-detection (`_stuckDuckCount`/
`_lastDuckLagMs`) — `requestCorrection` can no longer be called with
`|lagMs| > 500` from this path, so the engine's `'ducking'` state should
never be entered via the periodic corrector at all. Renamed the HUD/CSV
field `duckCount` -> `bigLagCount` (debug.html row "ducks" -> "big lags") to
reflect that it now counts forced-warp events, not actual ducks.

`node --test` still 25/25 (engine module unchanged — caller-side choice of
which correction to request; the engine's `'ducking'` tier and
`seekWithDuck()` remain defined/tested but should be unreachable from
`fastDriftCorrect()`'s wiring now).

**Verification needed**: next session — `driftState` should never read
`'ducking'` during steady-state drift correction (only possibly momentarily
right after a coordinated snap, if at all). Around `track_change`/`hard_sync`
`sync_event`s, expect a brief `'warping'` burst (rate 0.970/1.030) that
settles to `idle` within ~15-20s, with NO audible fade/clip — including for
devices like `dev_t0sqxy` that previously got stuck. If a device still shows
persistent large drift after this, it should show as sustained `'warping'`
(audible as a slight pitch shift, not clipping) rather than ducking.

### Phase 5m — hard-reload fallback for a frozen-paused audio element after track change (2026-06-11)
13th debug session (post-5l). Confirmed 5l worked exactly as intended:
`driftState` never read `'ducking'` anywhere in this CSV. `dev_syp0il` and
`dev_f8vluc` each hit a transient bogus ~147000ms spike around the
`hard_sync`/`track_change` events (23:41:10-14), then sat in sustained
`'warping'` (rate 1.030) for ~80-90s while a real ~2.5-2.7s post-wrap gap
closed at the expected ~30ms/s — slow, but continuously inaudible, no
fade/clip. Good.

But `dev_bwlh40` hit a NEW failure mode after its `track_change` (23:41:47.751):
`currentTime` froze at exactly `39.309` for the rest of the session (~60s+),
`readyState` stayed `4` (HAVE_ENOUGH_DATA), `audio.paused` was true every
tick (`stallCount` climbed 1->12, i.e. `_resumeAndReseek()` was called on
every tick), `driftMs` grew unbounded to -58779ms. `_resumeAndReseek()`
(`audio.play().then(cancelDriftCorrection + seekPreservingBT)`) was firing
every tick but never unstuck it — either `.play()` resolves but the element
re-pauses immediately, or `.paused`/`.currentTime` are unreliable on this
device after the `loadTrack()` src swap (same family of
`createMediaElementSource` quirks as 5k's no-op seek, but worse: total
freeze).

**Fix** (caller-side, `fastDriftCorrect()`'s paused branch): track
`window._lastPausedCurrentTime` / `window._frozenTicks`. If `currentTime`
hasn't changed across 3 consecutive paused ticks (~10-12s) despite
`_resumeAndReseek()` running each tick, escalate to `_hardReloadTrack()` —
re-runs `loadTrack(url, title, startedAt, playAt, playFromS)` with the
current track's URL/title (now cached in `window._currentTrackUrl` /
`window._currentTrackTitle`, set at the top of `loadTrack()`), which
reassigns `audio.src` and calls `audio.load()` for a fresh decode pipeline —
a full reload succeeds where repeated `.play()` on the stuck element didn't.
`_frozenTicks`/`_lastPausedCurrentTime` reset whenever audio isn't paused.

`node --test` still 25/25 (engine module unchanged — caller-side stall
escalation).

**Verification needed**: next session — after a track change, if a device's
`currentTime` ever freezes while `paused`, expect at most ~3 stalled ticks
(~10-12s) before a `track_change` `sync_event` re-fires for that device
(the hard reload) and `currentTime`/`driftMs` resume normal movement — not
a multi-minute freeze with `driftMs` growing into the tens of thousands.
Also keep an eye on the ~80-90s slow-warp recovery for ~2.5s+ gaps after
hard_sync/track_change (5l's tradeoff for never ducking) — if that reads as
"syncing in and out" for a noticeably long stretch, may need a faster (but
still inaudible) warp rate for large-but-not-bogus gaps specifically in the
post-sync_event window.

### Phase 5n — strip spatial/BPM-warp machinery to isolate the corrector (2026-06-12)
14th debug session (post-5l/5m). Good news: zero ducking, zero stalls across
all 3 active devices for the full ~3.5min session — 5l/5m holding. But all
three (`dev_4u64j8`, `dev_jyld5j`, `dev_rgugtn`) settled into a persistent
sawtooth that never converged: `driftMs` cycling between roughly -320ms and
-30/-50ms with a ~12-16s period, repeating for the entire session, roughly
in sync across devices. User confirmed no Movement/Sweep/Scatter scene was
running. User's read: "the stable baseline was actually really good and
didn't feel like chance" — i.e. compare honestly against the pre-Phase-5
baseline, and the spatial/BPM-warp/DJ-side machinery may be "corrupted"
and worth stripping out while isolating the corrector.

Rather than chase the exact mechanism (BPM-warp rate, spatial slot
flapping via `getSpatialSlot()`'s GPS-bearing-based cluster assignment, or
scatter-offset reassignment all touch `audio.playbackRate` / `_scatterOffsetMs`
/ which track loads — any of which could produce a periodic step that the
corrector then chases), disabled the whole stack for now so the next CSV
isolates the corrector itself with nothing else able to move
`audio.playbackRate`/`_scatterOffsetMs`/track selection underneath it:

- `_getBpmWarpRate()` -> always returns `1.0` (was `masterBpm/trackBpm`).
- `applyBpmWarp()` -> no-op, forces `audio.playbackRate = 1.0`.
- `getSpatialSlot()` -> always returns `'C'` (was GPS-bearing cluster/ring
  assignment — degrades to CLAUDE.md's "Single" mode, everyone on Center).
- `sweep_start`/`sweep_stop`/`scatter`/`cluster_assign` sync-channel
  handlers -> no-ops (were the only other writers of `_scatterOffsetMs`
  besides `hard_sync`'s `resetOffsets`/`clearScatter`, which still works).

All changes are caller-side, behind early-returns with "Phase 5n" comments
for easy reversal once the corrector is validated clean. `hard_sync`,
`spatial_config`'s Center-track loading/tip handling, and the core
drift-correction loop are untouched. `node --test` still 25/25.

**Verification needed**: next session — with nothing else able to move
`audio.playbackRate` or `_scatterOffsetMs`, does the sawtooth disappear? If
`driftMs` settles near 0 (idle) and stays there, the spatial/BPM-warp stack
was the cause (and the fix is either: don't reapply `applyBpmWarp`/slot
reassignment except on real track changes, or smooth `_scatterOffsetMs`
transitions through the corrector instead of stepping it). If the sawtooth
PERSISTS even with this stack fully disabled, it's purely a corrector/timing
issue independent of spatial code — revisit `requestCorrection`'s "snap
back to base rate" timer math in `sync-engine.js` and `sync-sim.html`.

### Phase 5o — settleToIdle always rechecks drift, not just on driftPendingRecheck (2026-06-12)
15th debug session (post-5n, zero `sync_events`, devices `dev_1xum4b`,
`dev_2q1vjd`, `dev_veycv0`). Sawtooth from 5n PERSISTED with the entire
spatial/BPM-warp stack disabled — per 5n's own stated criterion, this points
at the corrector/timer logic in `sync-engine.js` itself, not the spatial
layer.

Per-device time series showed a strikingly consistent shape: while
`'warping'` (rate 1.030), `driftMs` closes toward 0 at ~90ms per ~3s tick
(matches the nominal 3% rate). It gets down to single digits to ~80ms
(the "82ms"/"12ms moments" the user called out). Then, on the tick where
the warp's `correctionMs` timer fires and `settleToIdle()` resets
`playbackRate` to `baseRate` (1.000) and `driftState` to `'idle'`,
`driftMs` jumps straight back up by ~130-300ms — and the cycle restarts
from there, never settling. `dev_1xum4b`'s idle troughs landed at
-164/-165/-162/-164/-165/-164ms — suspiciously tight for hardware jitter,
suggesting a structural cause rather than random BT buffer noise.

The bug: `settleToIdle()` only rechecked live drift when
`driftPendingRecheck` was set — which only ever happens mid-`'ducking'`.
For `'warping'`, the warp timer just snapped `playbackRate` back to
`baseRate` and went idle unconditionally, regardless of whether the lag at
that exact moment (computed from `correctionMs`, fixed at warp-start) had
actually closed to <15ms. Any residual lag — or any rate-change glitch the
snap-back itself introduced — then sat unaddressed until the next ~5s
periodic `fastDriftCorrect` tick, during which it could grow further. This
is exactly "getting close, then jumping back up": the corrector wasn't
holding position once it got close, because it stopped checking the moment
it arrived.

Fix: `settleToIdle()` now ALWAYS calls `computeLagMs()` when a warp/duck
timer completes (not just when `driftPendingRecheck` is set), and
immediately calls `requestCorrection(lagMs)` again if `|lagMs| >= 15`. This
makes the corrector self-renewing — the moment a warp's timer fires, it
checks "are we actually close now?" and either goes idle (if yes) or
re-engages correction at the fresh lag (if no), instead of blindly trusting
the timer's start-of-warp estimate and waiting up to ~5s for the next
external check. `driftPendingRecheck` is now somewhat redundant for the
ducking path (its recheck would happen anyway) but left in place — it's
harmless and documents intent.

`node --test` still 25/25 (including the 3 seeded party-sim tests — no
bounds needed loosening).

**Verification needed**: next session — does the sawtooth's amplitude
shrink and/or its trough get closer to/stay near 0 for longer? If
`driftMs` still jumps by ~130ms+ right at the warping->idle transition even
with the immediate recheck, the rate-change itself (1.030 -> 1.000) is
likely causing a real `currentTime` stall/glitch on these devices (a known
Web Audio behavior on some platforms) — next step would be to avoid the
abrupt rate step entirely, e.g. by not fully returning to `baseRate` when
residual drift is small but nonzero (a "trim rate" slightly off 1.0 to
continuously compensate for the device's apparent natural skew, rather than
oscillating between 1.030 and 1.000).

### Phase 5p — drop playbackRate warping entirely; back to May 13 baseline snap-only (2026-06-12)
16th debug session (post-5o, `dev_sancq3`/`dev_xri1y6`/`dev_mvtoff`). 5o's
immediate-recheck made `settleToIdle` self-renewing, but the data showed why
that wasn't the right axis to push on: `driftState='warping'`
(`playbackRate=1.030`) was active in nearly every single row across the
whole session — `engineLagMs` sat continuously in the 60-460ms range, i.e.
inside the 15-500ms "warping" band essentially permanently. The corrector
was technically "working" (drift stayed bounded, mostly -50 to -460ms,
never blew up), but the practical effect was audio pitched up ~3% almost
the entire time, continuously — which the user described as making the
music "crazy to listen to, like a finger on a record."

User's direction: stop treating this as a tuning problem on the warp/duck
state machine and go back to what was confirmed to actually sound good —
the May 13 2026 `listener.html` (`6f4f5b0`) baseline. That design had **no**
`_driftState`, no rate-warping, no ducking: a periodic check (10s there)
that does nothing unless `|drift| > 300ms`, in which case it calls
`seekPreservingBT(expected)` (mute/seek/180ms-ramp) and otherwise leaves
`audio.playbackRate` untouched at exactly 1.0.

Phase 5d tried almost this in `listener-engine.html` (snap-only, but at a
60ms threshold) — and at the time it looked like it made things WORSE
("ducking and clipping" every ~3s, Phase 5i). But that test ran BEFORE the
unbound-`timers.clearTimeout` fix (5h): every snap was silently throwing and
doing nothing, so "no audible dips" in 5d's validation just meant "the
corrector never ran." Once snaps started actually firing (5i), a 60ms
threshold against the ~5s check cadence meant a seek+ramp almost every
tick — that's the clipping 5i described, not a flaw in snap-only per se.

**Change** (`listener-engine.html`):
- `fastDriftCorrect()`'s tail no longer calls `requestCorrection()` at all.
  Replaced the `>500ms` clamp-to-warp (5l) and the `<=500ms` `requestCorrection`
  call with one branch: `if (|lagMs| >= DRIFT_SNAP_THRESHOLD_MS) { snapCount++;
  cancelDriftCorrection(); seekPreservingBT(_expectedNow()); }` — else do
  nothing. `audio.playbackRate` is never modified by this loop; it stays at
  `getBaseRate()` (1.0, since Phase 5n) at all times.
- New `DRIFT_SNAP_THRESHOLD_MS = 300` (the May 13 baseline's value) —
  separate from the existing `SNAP_THRESHOLD_MS = 500` used by the
  stall-recovery/visibilitychange wake paths (those are coordinated
  recovery snaps, different purpose, left as-is).
- `requestCorrection`/`cancelDriftCorrection`/`_driftState`/warping/ducking
  remain in `sync/sync-engine.js` and `listener-engine.html` — still used by
  the mic-based BT-latency auto-sync verifier (`_syncState`, a different
  state machine per CLAUDE.md). Only the periodic drift loop stopped calling
  `requestCorrection`.
- Renamed the HUD/debug field `bigLagCount` -> `snapCount` (now genuinely
  counts `seekPreservingBT` snaps, not warp-clamp events) in
  `broadcastHUD()`, `debug.html`'s `REC_COLS`, and its card row ("big lags"
  -> "snaps").
- `sync-sim.html`'s existing "stripped" controller (added in 5d, dormant
  since) already models exactly this design — bumped its
  `STRIP_THRESHOLD_MS` from 60 to 300 to match.

`node --test` still 25/25 (engine module itself unchanged — only the
caller's corrector choice and a field rename).

**Verification needed**: next session — `driftState`/`rate` should now sit
at `'idle'`/`1.000` essentially always (the mic-verifier may occasionally
nudge it, briefly). Drift should sawtooth between roughly 0 and -300ms with
infrequent `seekPreservingBT` snaps (`snapCount` incrementing slowly, not
every tick) — and critically, no continuous pitch/tempo wobble. If snaps
are firing far more often than every ~10-20s per device, 300ms may still be
too low for this cadence/device population and could need raising; if drift
regularly overshoots well past 300ms before a snap lands, the threshold or
check cadence may need tightening instead.

**CONFIRMED** by the 17th debug session
(`byob-debug-session-2026-06-12T02-20-48-053Z.csv`): both `listener-engine`
devices held `driftState='idle'`/`rate='1.000'` for the entire session
(72/72 and 106/106 rows respectively), settling to a small constant drift
(~-148ms and ~-221ms) with only 0-2 snaps total — no continuous warping.
Meanwhile the one `build='listener'` device (production `listener.html`,
which had not yet received this change) showed the old behavior: 64/87 rows
`driftState='warping'`, `rate='1.030'`, oscillating drift between roughly
-55ms and -345/-540ms continuously — i.e. the exact "finger on a record"
sound, isolated to the un-ported file.

## Phase 5q — port the Phase 5p/5o corrector design into production `listener.html`

`listener.html` predates the `sync/sync-engine.js` extraction (Phase 1) and
has its own inline `_driftState`/`requestCorrection`/`cancelDriftCorrection`/
`seekPreservingBT`/`settleToIdle`/`computeLagMs` — none of Phase 5a-5p's
fixes had reached it, which is why the 17th session's `build='listener'`
device was still warping continuously (see "CONFIRMED" above) while the two
`listener-engine` devices held rock solid.

**Change** (`listener.html`):
- New `DRIFT_SNAP_THRESHOLD_MS = 300` constant.
- New `_expectedNow()` helper (mirrors `computeLagMs()`'s `expected` term) —
  the seek target for both the drift-loop snap and the visibilitychange wake
  snap.
- `fastDriftCorrect()`'s tail: replaced `if (Math.abs(lagMs) > 60)
  requestCorrection(lagMs)` with `if (Math.abs(lagMs) >=
  DRIFT_SNAP_THRESHOLD_MS) { snapCount++; cancelDriftCorrection();
  seekPreservingBT(_expectedNow()); }` — same snap-only design as Phase 5p.
  `audio.playbackRate` is never touched by this loop.
- `visibilitychange` wake handler: was calling `requestCorrection(lagMs)` at
  a 60ms threshold (i.e. could trigger a warp/duck on wake). Changed to a
  coordinated snap — `cancelDriftCorrection()` then
  `seekPreservingBT(_expectedNow())` — at the same 60ms threshold (audio is
  silent on a locked screen at wake, so an instant seek is inaudible; no
  need to wait for 300ms here).
- `settleToIdle()` already had Phase 5o's pending-recheck logic in
  `listener.html` — no change needed there.
- `requestCorrection`/`cancelDriftCorrection`/`_driftState`/warping/ducking
  remain inline, unused by the periodic loop now, still used by the
  mic-based BT-latency auto-sync verifier (`_syncState`).
- `broadcastHUD()`: added `snapCount: window._snapCount || 0` so
  `debug.html`'s "snaps" row populates for `build='listener'` devices too.

`node --test` still 25/25 (`sync/sync-engine.js` untouched — this is a
caller-side port of an already-validated design, not a new corrector).

**Verification needed**: next session — `build='listener'` devices should
now show the same `driftState='idle'`/`rate='1.000'` holding pattern as the
`listener-engine` devices, with infrequent `snapCount` increments instead of
continuous `warping`/`rate=1.030`.

**CONFIRMED** by an 18th, 67-minute debug session
(`byob-debug-session-2026-06-12T03-42-46-312Z.csv`): `dev_939j12`
(`build='listener'`, production) held `driftState='idle'`/`rate='1.000'` for
474/475 rows with `snapCount` reaching 31 over the session — no warping, no
"finger on a record." User confirmed: "the warping is no longer unsettling."

## Phase 5r — close the residual gap: continuous micro-rate trim

The same 18th session also quantified what's left: drift sawtooths between
snaps rather than holding flat. `dev_939j12` and `dev_2gntq9` (one of each
build) both ran the full 67 minutes — median drift -57 to -60ms, p10 around
-130 to -300ms, snapping ~31-32 times (roughly every 2 minutes). That ~2-3ms/s
climb between snaps is a *constant* per-device hardware clock-rate error
(the audio clock runs a fixed fraction fast/slow relative to `syncedNow()`),
not one-time calibration error — `dev_824w1u` sat at a steady median -180ms
the whole session, never approaching 0.

User's target: get this under 50ms. Lowering `DRIFT_SNAP_THRESHOLD_MS` would
mean a 180ms mute/seek/ramp roughly every 20s instead of every ~2min — likely
too frequent. Instead: cancel the constant drift-rate error directly with a
**continuous, proportional, much gentler** rate trim than the Phase 5h-5o
±3% warp that caused the original "finger on a record" complaint.

**Change**:
- `sync/sync-engine.js`: new `microCorrectionRate(lagMs, baseRate)` —
  `rate = baseRate * (1 + clamp(lagMs * MICRO_GAIN_PER_MS, ±MICRO_MAX_PCT))`,
  `MICRO_GAIN_PER_MS = 0.0002`, `MICRO_MAX_PCT = 0.006` (±0.6%, ~5x gentler
  than the old ±3%). New `createSyncEngine().applyMicroCorrection(lagMs)` —
  sets `transport.playbackRate` to this, but only while `driftState ===
  'idle'` (no-op during the verifier's warp/duck, so the two never fight over
  `playbackRate`).
- `fastDriftCorrect()` in both `listener-engine.html` and `listener.html`:
  when `|lagMs| < DRIFT_SNAP_THRESHOLD_MS`, call `applyMicroCorrection(lagMs)`
  instead of doing nothing. `listener.html` got its own inline
  `applyMicroCorrection()` mirroring the engine's (it doesn't import
  `sync/sync-engine.js`).
- `sync-sim.html`: new "Micro" panel/controller (`microTickEngine`) — stripped
  (snap at `STRIP_THRESHOLD_MS`) plus `applyMicroCorrection` below it. Verdict
  table now compares legacy / new / stripped / micro.
- `debug.html`: the `rate` row's warn threshold changed from `!== '1.000'`
  to `|rate - 1| > 0.006` — a permanent small trim is now expected, not a
  fault.
- New tests in `sync/sync-engine.test.js`: `microCorrectionRate` math (zero
  lag, sign, linearity below cap, clamping, baseRate scaling),
  `applyMicroCorrection` (trims while idle, no-ops mid-duck), and a
  600-tick (10-minute) convergence test — a constant ±0.5% hardware-drift
  lag converges to `|lag| < 50ms` steady-state. `node --test` 33/33.

A standalone check (`/tmp/sim_check.mjs`, same engine + 5s cadence, 20
simulated minutes) confirmed convergence across the full hardware-drift
range modeled in `sync-sim.html`: hwDriftPct ∈ {-0.5%, -0.25%, 0, +0.25%,
+0.5%} → steady-state `|lag|` ∈ {25.1, 12.5, 0.0, 12.5, 24.9} ms, zero snaps
needed in any case — the trim alone keeps drift under the 50ms target for
the worst-case device modeled.

**Verification needed**: next session — `driftMs` for both builds should now
hold close to 0 (within ~25ms) between snaps instead of sawtoothing toward
-300ms, `rate` will float a little (e.g. 0.994-1.006) continuously rather
than pinning at exactly 1.000, and `snapCount` should grow much more slowly
(or not at all) since the trim removes the steady climb that drove snaps.

## Phase 5s — investigating a new fast-snap pattern (19th session)

A 19th, 6-minute session (`byob-debug-session-2026-06-12T04-11-11-178Z.csv`,
654 rows, 3 devices — 1 `listener`, 2 `listener-engine`) showed something
different from, and worse than, the 18th session: `snapCount` climbed from
single digits to 26-54 within ~6 minutes — roughly **one snap every 7-9
seconds**, vs. one every ~2 minutes in the 18th session. User asked how to
stop the audible "jumping"; this session shows it got more frequent, not
less.

The pattern is a clean, repeating sawtooth, e.g. `dev_4hpqb3`:
`driftMs` 0 -> -250 -> -430 -> snap -> 0 -> -250 -> -430 -> snap..., every
~8s. Looking at `currentTime`/`expectedPos` directly: `expectedPos` advances
by exactly the real-time delta each tick (~4.0s), but `currentTime` only
advances ~3.55-3.82s in the same window — `audio.currentTime` is losing
~150-280ms of real time roughly every 4 seconds, *while `playbackRate` reads
exactly 1.000 or 1.006* (i.e. the micro-trim, which is far too small —
±0.6% ≈ ±24ms/4s — to explain a 150-280ms/4s loss).

Two hypotheses considered:
1. **BPM-warp / position-formula mismatch** — `_getBpmWarpRate()` sets
   `audio.playbackRate` as the *correction* base rate, but the seek
   `expected` formula (`computeLagMs`/`_expectedNow`/`broadcastHUD`) assumes
   1x real-time progression regardless of warp rate. If `_getBpmWarpRate()
   != 1` (master BPM set, track BPM mismatched), `currentTime` and `expected`
   would diverge at a *constant* rate forever. **Ruled out** — the reported
   `playbackRate` is 1.000/1.006, and the loss-per-tick isn't constant
   (3.75/4.00 vs 3.59/4.00 in adjacent windows), which a constant-ratio warp
   mismatch wouldn't produce.
2. **Real audio buffer stalls** — `<audio>` periodically stalls/rebuffers
   (`stalled`/`waiting`/`suspend`), losing real playback time in bursts of
   varying size. `listener.html` already has a `_handleStall()` watchdog for
   exactly this (resumes via `audio.play()` after 2.5s) but — unlike
   `listener-engine.html` — never counted these events or reported
   `audio.readyState`, so `stallCount`/`readyState` were blank in the CSV for
   `build='listener'` devices. This is the leading hypothesis: a varying
   150-280ms loss every few seconds looks exactly like recurring short
   rebuffers, not a rate/formula bug.

**Change** (`listener.html`, diagnostics only — no corrector behavior
changed):
- `_handleStall()` now increments `window._stallCount` when its 2.5s
  watchdog actually fires a resume (mirrors `listener-engine.html`).
- `fastDriftCorrect()` now stamps `window._lastDriftCheckAt =
  performance.now()` on every tick.
- `broadcastHUD()` now reports `readyState: audio.readyState`, `stallCount`,
  `visibilityState: document.visibilityState`, and `lastDriftCheckAgoMs` —
  the same fields `listener-engine.html` already sends, so `debug.html`'s
  existing "stalls"/"readyState"/"visibility"/"lastDriftChk" rows populate
  for `build='listener'` too.

**Verification needed**: next session — if `stallCount` climbs in step with
`snapCount` (roughly 1:1, every ~8s) and/or `readyState` dips below 4 right
before each snap, that confirms recurring buffer stalls as the cause — fix
becomes an audio-buffering investigation (e.g. `preload`, source format,
Bluetooth output pipeline), not a corrector change. If `stallCount` stays
flat while snaps keep firing, look elsewhere (e.g. GPS/position recompute
cost on the main thread blocking the audio element).
