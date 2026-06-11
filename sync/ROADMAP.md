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
