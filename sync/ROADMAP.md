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
node imports it natively for tests (`node --test sync/`). The `package.json` is a
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

1. **`computeLagMs` doesn't wrap at the track boundary** (`listener.html:4788`).
   Near the loop point (expected 199.9s, actual 0.1s on a 200s track) lag reads as
   ~±duration → spurious 2.5s duck every loop. `sync-sim.html` already has
   `wrapLag()`; the real listener never got it.
2. **Sweep beam-hit seek violates the seek formula** (`listener.html:5478`):
   `seekPreservingBT((elapsed − deviceLatency/1000) % duration)` — missing
   `SEEK_STAB_S` and the `_scatterOffsetMs` term (which sweep itself just set at
   line 5471). The very next `fastDriftCorrect` tick sees ~delayMs of phantom
   drift and re-corrects. One canonical `expectedPosition()` makes this class of
   bug impossible.
3. **BPM-warp position math (audit finding C, still open).** When
   `playbackRate ≠ 1` (master BPM warp), track position advances at `rate ×`
   wall time, but `expectedPosition()` maps elapsed 1:1. Expected position must be
   rate-aware (`elapsed × warpRate`), and warp-correction duration math
   (`lagMs / 0.03`) must account for the base rate. Until fixed: master BPM stays
   off when testing sync.
4. **Formula duplication**: the four-term expression is inlined at ≥5 sites in
   `listener.html` (3657, 3727, 3754, 3775, 4867) plus `debug.html`'s expectedPos
   plus `sync-sim.html` — three files to keep in step by hand today.

---

## Phases

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

### Phase 2 — Test harness (`sync/sync-engine.test.js`, `node --test sync/`)
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
- These tests are the new pre-flight: **`node --test sync/` green before any sync
  change ships** (replaces "eyeball it in sync-sim" as the gate; the sim stays for
  visual exploration).

### Phase 3 — Bulletproofing (fix the four defects above, tests first)
- For each: write the failing test against the Phase-1 port, fix in the engine,
  watch it go green, confirm fuzz metrics didn't regress.
- Sweep the engine for edge cases the harness makes cheap to probe: duration ≤ 0,
  paused transport, latency cache stale after BT device change, clock-offset
  estimator under RTT spikes / all-samples-rejected.
- Exit criterion: fuzz suite green across many seeds **with master BPM warp
  enabled** (closes audit finding C).

### Phase 4 — Point sync-sim.html at the real engine
- `sync-sim.html` imports `./sync/sync-engine.js` for the "new" controller instead
  of carrying a copy; the legacy controller copy stays for comparison.
- From here on the sim exercises the shipped code, not a transcription of it.

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
- Verify: two-phone test against `debug.html` drift-spread readout; sweep, scatter,
  hard_sync, track change, BPM warp on.

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
  (`node --test sync/`).
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
