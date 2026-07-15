# Ternary Engine Tuning Log

Oracle: 58.6 → 10 (Joyous → Treading). Tread carefully. Small steps, measure each one.
Goal: herd all devices under 50ms drift. Constrain the bounce, don't chase 0ms.

---

## Baseline (pre-tuning, from CSV 2026-06-24 / 2026-06-25)

**Hardware signature:** BT stall of exactly +82ms, firing each time a device reaches
P-state (<10ms). Perfectly consistent across 285 P→N transitions for ter_ip08jy.
This is a hardware buffer-drain event, not a code bug. Irreducible.

**Engine constants:**
  PROP_GAIN        = 0.0002
  MAX_WARP         = 0.025   (2.5%)
  warpTimer        = 2600ms
  DRIFT_CHECK_MS   = 1500ms  (in listener.html)
  TH_P             = 10ms
  TH_Z             = 50ms
  TH_SEEK          = 500ms

**Convergence math at baseline (DRIFT_CHECK_MS=1500ms, PROP_GAIN=0.0002):**
  Per-tick decay factor = 1 - (1.5 × 0.0002 × 1000) = 0.70
  From 82ms: 82 → 57 → 40 → 28 → 20 → 14 → 10 → 7 → ... → P
  Ticks to P: ~6 (9 seconds). Stall fires immediately on reaching P.
  Time in N-state (>50ms) per cycle: 2 ticks = 3 seconds.
  Time in Z-state (10–50ms) per cycle: ~4 ticks = 6 seconds.
  Observed P-state: 8% (matches: 1 tick P per ~12-tick cycle = 8.3%).

**Key observation:** At 82ms stall, warpPct = 82×0.0002 = 1.64% — below MAX_WARP cap.
  MAX_WARP is NOT the bottleneck. PROP_GAIN is.

**To close 82ms to <50ms in ONE tick:**
  Need: 82 × (1 - 1500 × PROP_GAIN) < 50
  Solving: PROP_GAIN > 0.000260
  At PROP_GAIN=0.00028: x(1) = 82 × (1 - 0.42) = 47.6ms ✓ (just under 50ms)

---

## Step 1 — 2026-06-29

**Change:** PROP_GAIN 0.0002 → 0.00025 (+25%, conservative first step)
**File:** sync/ternary-engine.js line 116
**Reasoning:** Oracle 58.6→10 says tread. 0.00026 is the mathematical minimum to close 82ms
to exactly Z-state in one tick. Going to 0.00025 lands just above 50ms after one tick
(82×0.625=51ms) but the second tick closes to 32ms. Safer than jumping straight to target.
Leaves MAX_WARP unchanged — doesn't apply at 82ms drift.

**Expected:**
  - Per-tick decay: 1 - (1.5 × 0.00025 × 1000) = 0.625
  - From 82ms: 82 → 51 → 32 → 20 → 13 → 8 (P) — 5 ticks vs 6 ticks at baseline
  - Time in N-state per cycle: still 1 tick (82→51ms in one tick, but 51>50 so still N)
  - Time in Z-state: improves slightly, 32→20→13 = 3 ticks in Z

**Status:** applied. Awaiting CSV from next session.

---

## Step 2 — 2026-06-29 (live session)

**Change:** MAX_WARP 0.025 → 0.040 (4.0%)
**Oracle:** 12.1.6→17
**Reasoning:** During the first live 4-device test, observed multiple devices with
larger BT stalls (~150-380ms, "Class C/cascading" hardware) where PROP_GAIN alone
hit the MAX_WARP cap before closing the gap in time. Raised the ceiling so heavier
stalls get more correcting force per tick.

**Commit:** 9ab1df4

---

## Step 3 — 2026-06-29 (live session, "stop the leapfrog")

**Problem identified live:** BT stall firing period ≈ engine convergence time on
several devices, so they were knocked out of P(converged) almost as soon as they
arrived — a "lockstep leapfrog" where devices never held sync for more than one tick.

**Change:** PROP_GAIN 0.00025 → 0.00040
**Oracle:** 8.1.5→24
**File:** sync/ternary-engine.js line 116
**Reasoning:** Needed to close ~80ms Class B stalls in ~2 ticks (≈3s), faster than
the observed ~6s stall period, so a device can re-stabilize at P before the next
stall lands instead of perpetually chasing it.

**Auto-cal fix (same step):** layer.js `detectFloor()` was misfiring on Class C
devices (z5km0a-class, 270-380ms stalls) — it kept "detecting" a floor and applying
corrections that the 1200ms deviceLatencyMs cap silently swallowed, looping every 60s
with zero effect. Added a >200ms floor guard (real floors are <200ms; anything higher
is stall contamination) and a `_capHits` counter that gives up after 3 swallowed
corrections instead of retrying forever.

**Commits:** 01514bc (engine), d93b5ae (layer.js fix), 94c55fe (listener.html HUD button)

**Live result (confirmed after push landed on origin/main):**
  - `cionsr` (Class B, ~80-95ms stalls): held CONVERGED (C-state, <10ms drift) for
    3+ consecutive ticks (~90s+) — the leapfrog is broken for this device class.
    Still occasionally knocked out by larger seek/resync events (-300ms range jumps),
    which are a separate phenomenon from BT stalls.
  - `v7mgrc` (Class C, ~90-250ms repeating stalls): still stuck DIVERGING around
    400-470ms, NOT improving. Stalls are landing faster/larger than even the new
    gain can close. This device needs a different lever — likely MAX_WARP isn't
    high enough yet, or auto-cal deviceLatencyMs correction isn't engaging for it.

**Oracle on next step (17→16, lines 1,5 — Following→Enthusiasm):** Hold current
change, gather more data before adjusting again. The change made was correct
(line 1: "the standard changed rightly"); trust it and observe rather than
reaching for another lever immediately (line 5 + Enthusiasm: confidence through
alignment, not force). v7mgrc needs more observation cycles before its specific
fix is clear.

**Status:** holding. Continuing to monitor v7mgrc and other Class C devices.

---

## Step 4 — 2026-06-29 (live session, "smooth the wrinkles / nudge once synced")

**Problem:** With the leapfrog broken, devices now reliably reach CONVERGED — but
small re-drifts right after convergence were getting the same full-strength
proportional correction as a fresh large drift, causing audible cutting in/out
(overshoot/oscillation right at the point of tightest sync, where it's most
noticeable).

**Oracle (on continuing at all):** 2.1.6→27 (Receptive→Nourishment). Confirmed:
continue, but the next move should be gentler/sustaining, not another blanket
gain increase. Line 6 (dragons fighting) warned specifically against
over-correcting at the point of near-convergence — exactly this symptom.

**Oracle (on the nudge-tier design):** 14.1.3→64 (Great Possession→Before
Completion). Confirmed the shape: give one gentle tick of correction right
after P-state, but it must properly escalate back to full strength if that's
not enough (line 3 — a half-measure that never escalates is "not equal to the
task"). 64 cautions to verify carefully since we're close to a good stable
state and it's easy to introduce a new defect here.

**Change:** Added NUDGE_GAIN = 0.00010 in `requestCorrection()`. When the
previous trit state was P (just converged), use NUDGE_GAIN for that single
correction tick instead of PROP_GAIN. If still off next tick, prevTrit is no
longer P, so it automatically escalates to full PROP_GAIN — no extra state
machine needed, the existing per-tick trit tracking does this for free.
**File:** sync/ternary-engine.js — requestCorrection()

**Status:** implemented, not yet observed live. Needs push + live monitoring
to confirm the cut-in/cut-out wrinkle is smoothed without reintroducing the
leapfrog (i.e. confirm escalation actually kicks in when needed).

---

## Step 5 — 2026-06-29 (live session, "spinning the same 500ms loop")

**Problem:** User confirmed an audible, known bug — the same short clip
(roughly 500ms) repeating/spinning in place for several seconds. Root cause
matches a comment already in the code (listener.html fastDriftCorrect): on
some BT routes, `audio.currentTime = x` silently no-ops while playing — the
seek "completes" in JS but the BT pipe doesn't actually move. Drift balloons
past 500ms again next tick, triggers another seek to nearly the same target,
repeat — audible as a spin/stutter. Diagnostics for this already existed
(`_lastSeekIntendedMs`/`_lastSeekMeasuredMs`) but nothing acted on them.

**Oracle:** 16.3.5→31 (Enthusiasm→Influence). Confirmed: act now, don't
hesitate (line 3) — but treat this as a chronic condition to manage on an
ongoing basis, not a single permanent cure (line 5, "persistently ill, does
not die"). Influence (the resulting hexagram) pointed at a sensing/responsive
fix rather than brute-force suppression — wait and observe whether the seek
actually landed before deciding to act again.

**Change:** In listener.html's snap path, after the 200ms post-seek
measurement, compare measuredJumpMs to intendedJumpMs. If the seek clearly
didn't land (measured < 30% of intended) on a real snap-magnitude correction,
increment `_snapFailCount`. After 3 consecutive no-lands, call
`_hardReloadTrack()` — the same escalation path already used elsewhere in
this file for the BT pause/resume loop — instead of endlessly re-issuing
identical seeks. Resets to 0 on any seek that actually lands.
**File:** listener.html — fastDriftCorrect()'s snap branch

**Status:** implemented, not yet observed live. Needs push + a real
recurrence of the spin bug to confirm the escalation actually fires and
clears it (rare/intermittent bug — may take a while to observe in the wild).

---

## Step 6 — 2026-06-29/30 (Goal 3, data-driven: compounding stall detector)

**Problem:** Class C devices (rt9jjg, h7fuax) never held CONVERGED, even
after step 4's nudge tier. Originally assumed this was because their stall
*cadence* was simply faster than Class B. Measured actual stall episode
intervals from sync/monitor-logs/2026-06-29_18-50.csv (live-monitor.mjs ran
the whole session) to test that assumption before designing anything:

- cionsr (Class B, converges fine): stalls rare, median 241s apart, 0% under 5s.
- rt9jjg (Class C, stuck): dominant cluster ~8-9s — same as Class B — but a
  secondary cluster at ~3-4s, present in 41/309 episodes.
- h7fuax (Class C, stuck): same pattern — dominant ~8-10s, secondary ~3-4s.

**Conclusion:** the 8-9s baseline cadence is not the problem (the engine
already handles that fine — that's what Class B effectively is). The actual
cause is the secondary ~3-4s cluster: a second stall lands while the engine
is still mid-correction from the first (correction recheck timer is 2600ms),
compounding the gap before it can close. cionsr almost never does this;
rt9jjg/h7fuax do it constantly. This reframed Goal 3 from "predict the next
stall" (broad, speculative) to "detect when a stall compounds an active
correction" (narrow, measured).

**Oracle:** 14.1.2→30 (Great Possession→The Clinging/Fire). Confirmed:
proceed with confidence (line 2, "a big wagon for loading... no blame" — the
data-driven diagnosis is adequate grounds to act). But Fire's own line 2
("Yellow light, supreme good fortune") cautions toward a *moderate*,
centered escalation — not a maximal one.

**Change:** Added `isCompounding` detection in `requestCorrection()`: true
when the engine was still `_state === 'warping'` from a previous correction
AND the new drift is larger than the previous tick's drift (a genuinely new
stall landed, not just settling). When true, uses COMPOUND_GAIN = 0.00060
(50% stronger than PROP_GAIN's 0.00040, not more — moderate per the oracle)
instead of treating it as a fresh independent correction.
**File:** sync/ternary-engine.js — requestCorrection()

**Status:** implemented, not yet observed live. Needs push + live monitoring
to confirm rt9jjg/h7fuax-class devices can now hold CONVERGED through the
3-4s compounding stall pattern, without overcorrecting on isolated stalls.

---

## Step 9 — 2026-06-30 (octonary participation layer — Phase 5)

**Vision:** Two independent 1000-cast field readings + three personal casts all converged:
- 57→61 appeared in both runs independently (gentle sampling → inner truth)
- 31→45: individual interactions accumulate into collective organization
- 60 unchanging (Limitation): synchronization requires boundaries
- 17→45: nodes determine who to follow FIRST, then gather
- Personal casts: 40.1→54 (secondary role), 11.2.3.5.6→42 (radial/bidirectional),
  12.5→35 (ends standstill → rapid progress)

**Eight roles:**
  0 ANCHORING — P 5+ ticks, weight 2.0 (trusted anchor)
  1 HOLDING   — recently settled in P, weight 1.5
  2 PULLING   — Z-state, weight 1.0
  3 FOLLOWING — Z-state, oriented toward anchor, weight 0.8
  4 PUSHING   — N-state stall recovery, weight 0.5
  5 LISTENING — post-seek settle, weight 0.3
  6 RESETTING — auto-cal fired, weight 0.5
  7 REACHING  — >300ms, excluded (weight 0.0)

**Changes:**
- `ternary/layer.js`: octonary state machine, weightedConsensus(), isGlobalDisruption(),
  findAnchor(); octoState broadcast + stored per peer + in HUD payload. Phase 5.
- `sync/ternary-engine.js`: suppress COMPOUND_GAIN during isGlobalDisruption() —
  room-wide events (≥50% peers PUSHING/REACHING) don't warrant compound escalation

**Status:** implemented, not yet observed live.

---

## Step 7 — 2026-06-30 (sound quality: cuts + warp audibility)

**Problems:** Two distinct audio quality issues heard live:
1. Cuts every 4-6s — `playing` handler firing `seekPreservingBT` (full mute/ramp) on
   every BT buffer refill at 100ms threshold. BT speakers fire `playing` on refill
   constantly; any drift ≥100ms = a mute cycle = audible cut.
2. Heavy pitch-sweep warping sounds — MAX_WARP at 4% = ~68 cents (~1 semitone) for
   up to 2600ms per correction cycle. Very audible in music.

**Oracle A (playing handler):** 57.2.3→20 (Gentle→Contemplation).
Line 3: "Repeated penetration — humiliation." The constant seekPreservingBT on every
refill is the humiliation. Line 2: work through subtle/indirect means.
→ Contemplation: watch, don't constantly intervene. Let warp handle small drift.

**Oracle B (MAX_WARP):** 49.3.6→25 (Revolution→Innocence).
Line 3: evidence has accumulated (cascades, cuts, pitch sweeps) — commit now.
Line 6: change like a panther — decisive, complete, not superficial.
→ Innocence: natural and unforced. Don't fight with brute-rate correction.

**Changes:**
- `listener.html`: playing handler threshold 100ms → **300ms** (stops firing on routine
  BT refills; only fires for genuine large stalls — matches May 13 principle)
- `sync/ternary-engine.js`: MAX_WARP 0.040 → **0.015** (1.5%, ~26 cents — closes 80ms
  Class B stall in ~6 ticks/9s, within the 8-9s stall period; audibly cleaner)

**Status:** implemented, not yet observed live. Push and monitor.

---

## Step 8 — 2026-06-30 (micro-nudge: hold devices at home once converged)

**Problem:** Below 15ms the engine was completely silent. A device at 12ms drift sat
there indefinitely — nothing fired. Once a device reached P-state (<10ms), it could
wander to 14ms and stay there forever.

**Oracle:** 37.1.3.4→12 (The Family→Standstill).
Line 1: establish firm rules from the foundation — fire early, even at tiny drift.
Line 3: firm but not harsh — gentle enough to be inaudible, strong enough to hold.
Line 4: "She is the treasure of the house" — the centering force is the most valuable.
→ Standstill: devices reach stillness and hold it. The goal state.

**Changes:**
- `listener.html`: fastDriftCorrect threshold 15ms → **5ms** (below 5ms = clock jitter)
- `sync/ternary-engine.js`: added MICRO_GAIN = 0.00020 — fires when abs < TH_P (< 10ms).
  At 8ms: 0.16% warp = ~2.4ms closed per 1500ms tick — inaudible, closes in ~4 ticks.
  Four tiers now: MICRO (sub-10ms) → NUDGE (post-P) → COMPOUND (stacking stalls) → PROP (normal)

**Status:** implemented, not yet observed live. Push and monitor.

---

## Observatory — 2026-06-30 (ternary/overlay.html full rebuild)

Complete rewrite of the debug dashboard into a multi-panel monitoring observatory.

**New panels (tab-switched):**
- **DRIFT chart** (primary): per-device drift over 180s window, ±200ms, P/Z/N lines at ±10ms/±50ms
- **WARP RATE chart**: (playbackRate − 1)×100 per device — correction magnitude. ±2% range.
  Flat 0% = engine idle. Spikes show when/how hard each device is correcting.
- **OCTO ROLES timeline**: Gantt-style colored strips per device — role transitions over 180s.
  Each of the 8 roles has its own color (teal=ANCHORING → red=REACHING).
- **AUTO-CAL chart**: deviceLatencyMs per device over 180s. Step-jumps = auto-cal fired.

**Room overview bar (always visible):**
- Drift spread (ms) — max−min across playing devices
- Ternary N/Z/P bar with counts
- Octonary 8-role stacked bar with count labels
- Global disruption indicator: CLEAR / ⚠ ACTIVE

**Enhanced device cards:**
- Trit badge + octonary role badge with oracle role colors
- Full field set: drift, warp%, BT latency, drift state, floor, cal state, consec N,
  peers, consensus, snaps, stalls, seek (intended vs measured), readyState, visibility

---

---

## 2026-07-06 session — synced entry, roving fix, jolt diagnosis ("the launch day")

Full plan: `~/.claude/plans/we-are-developing-something-robust-cook.md`. Live
baseline + verification via the new launch reports in `sync/live-monitor.mjs`
(per-launch: spread at play_at, time-to-converged, snap count, PASS/FAIL at
<50ms within 3s; `sync/launch-cycler.mjs` fires test launches on an interval).

**Baseline measured (3 phones, ~12 launches):** entry began 0.2–1.7s off,
took 3–17s and 1–33 audible mute/ramp snaps per device to converge;
calibration relearned the same floor every clip. Steady state was healthy —
entry was the whole disease.

**Shipped, in order (each oracle-cast):**
1. `cf770e4`/`b509598` — scheduled synced entry (17.4→3): playback_started_at
   = play_at (one shared future instant, ≥2.5s lead, bar-quantized from Link
   in the bridge); listeners preload muted and un-mute at play_at + own
   deviceLatencyMs. Verified live: entries went to sub-second, first ✅ PASS.
2. `b74a564` — roving re-anchor fix (54.1→40): computeSeekTime's play_at
   branch omitted BT-latency compensation; devices parked at +own-latency
   (stuck 62–666ms) on every wake/reconnect. Pinned by tests.
3. `d52c3a5` — calibration persists across tracks + burst snapping RETIRED
   (63.3→3, 34.5→43): the per-track cal reset was a ratchet creeping latency
   to the 1200ms cap; burst snaps were the audible cutting (up to 33/launch).
4. `59145e2` — wrap over-threshold seek targets into duration (17.6→25):
   unwrapped currentTime+lag past a loop's end was clamped → endless seek
   wedge at constant lag.
5. `1c944cf` — debug.html straggler controls (63.3→3): RESET CAL, NUDGE
   field, auto ⚠ STRAGGLER flag (cap-pinned / constant-offset).
6. `40c3568` — bridge never re-anchors from Link's ABSOLUTE beat (3.2→60):
   tempo-change reanchors + bridge hard_syncs minted references minutes in
   the past → the 20–160s room-wide jolts (grew with transport age).
   **Bridge process must be restarted to pick this up.**
7. `df7ea54` — floor-sample hygiene (56.2.5→9): no samples during burst,
   10s quiet after a >120ms tick jump, floor must hold across both window
   halves. Fixes auto-cal shoving converged devices off by 30–90ms.
8. `890110b` — zone offset knob (4.2.4→35): zone_offset_ms on spatial_config,
   applied inside syncedNow() (single choke point); bridge UI field. Trims
   the measured ~60–75ms common-mode offset vs the broadcaster by ear.

**Best observed:** room mutual spread ~2ms (four phones at 74–76ms identical
common-mode); entries converging in 0.1–1s with zero snaps; first launch-report
PASSes.

---

## Step — 2026-07-06 (engine no-op-seek escalation)

**Oracle:** 22 unchanging (Grace). Modest yes — favorable in small matters;
implement as pure ornament on the proven step-5 mechanism, no new structure.

**Change:** `seekPreservingBT()` in sync/ternary-engine.js now measures its
own landing (intended vs measured jump, both wrapLag'd, 200ms post-seek) for
snap-magnitude seeks (intended ≥ TH_SEEK). Three consecutive no-lands
(measured < 30% of intended) → `onSeekStuck()` hook, wired to
`_hardReloadTrack()` in listener.html; any landed seek resets the counter.
Measurement deliberately NOT gated on `_driftGen`: the post-ramp recheck
re-seeks (bumping the gen) exactly when the seek failed, which would starve
the counter. Covers the engine's own TH_SEEK branch plus all coordinated-snap
callers, which the listener-side step-5 check couldn't see.
**Files:** sync/ternary-engine.js — createTernaryEngine()/seekPreservingBT();
listener.html — engine construction (onSeekStuck).

**Status:** implemented; verified offline with a fake-transport harness
(no-op transport escalates once after 3, landed seeks never escalate,
landing resets the count, sub-TH_SEEK jumps ignored). Existing 35 engine
tests pass. Needs live recurrence of a BT no-op route to observe.

---

---

## 2026-07-06/07 late session — live tuning marathon (broadcast running throughout)

Deployed and verified live, in oracle order:

1. `73baf10` — **no-op-seek escalation in the engine** (22 unchanging) +
   **MAX_WARP 1.5→3%** (53 unchanging, gradual). The 3% was later judged
   unlistenable mid-music and superseded by (5).
2. `0009296` — **Boomy sync-entry companion** (48.1.2.4→49, "lining the
   well"): ≥300ms for 2 ticks → "Syncing up with everyone…" + soft C5→E5
   beep; "Locked in!" under 50ms; 45s cooldown. Monitor report-time
   ter_/dev_ dedupe (dev-first race was double-grading phones).
3. `af5c28e` — **zone-row reference repair** (32.2→62): the anchor
   heartbeat/triggerResync/DJ gate all run off the cached reference, so a
   diverged row (observed ±140s!) was invisible while every entry-seek and
   60s poll read it. Every 5th heartbeat: fetch row, rewrite if >500ms
   apart (skips scheduled launches in their lead window). Root cause of the
   night's "entering ~1s desynced" — entries seeked the ghost row, then the
   anchor reeled them back.
4. `81179e3` — **loadTrack no-op guard** (14.5→1): ANY zones-row update
   (listener-count bump on join, DJ message) re-ran loadTrack on every
   phone — a new device joining forced the whole room to reload/re-enter
   the current track. Same URL + same reference → no-op. Fixed "adding a
   device desyncs everyone" (user-observed, confirmed mechanism).
5. `1c82be5` — **two-tier warp** (32.4→46, "no game in the field"):
   audible ceiling back to 1.5%; ≥150ms silences output (transport.muted —
   FX pulse loop owns volume) and warps to 8%, un-mute via 180ms
   smoothstep <30ms, hysteresis 150/30.
6. `8d77d12` — **silent warp gated to entry phase** (19.3→11): (5) fired
   on any ≥150ms drift, so mid-track BT stalls kept muting playback.
   Now: armed at launch/coordinated snaps, disarmed at first convergence.
   Steady state = micro-nudge + inaudible 1.5% + seekSilent; can never
   mute mid-music. Engine life cycle: silent heavy entry → lock →
   inaudible hold forever.
7. `281e379`/`2c53819` — **master_tick + split grading**: bridge publishes
   its position on byob_debug (5s); monitor grades SPREAD (<25ms,
   listenability) separately from MASTER (median vs master, <50ms) and
   convergence (<3s). Master source switched to the DJ anchor after the
   bridge reference proved stale for artist-launched tracks. **MASTER math
   still wrong** (stable ~87.7s, then −2.2s readings) — debug next session;
   SPREAD/convergence unaffected.

Ops during the session: bridge restarted (master_tick live), artist.html
refreshed (row-repair active — schism ghosts stopped recurring after),
remote RESET CAL via latency_cmd from CLI (fvotp9: 222ms pinned+snapping →
70ms clean). Launch reports observed: first full PASS (3 devices, 1.3–1.7s
convergence, 10ms spread); post-fix complete windows converging 0.9–2.7s,
spreads reaching 9–28ms.

**Posture cast** (user question: "sync once and keep them synced"):
63.1→39 — After Completion: perfect sync is the moment decay begins;
keeping synced is continuous small vigilance (micro-nudge IS the product).
Line 1: brake the wheels at each crossing (restrained entry; a wet tail —
30ms residue, a beat of silence — is no blame). →39: when obstructed,
don't push — pause, regroup, rejoin (disruption hold).

**Deferred by dual cast** (user 30.1.4.6→15, Claude 2.2.6→4):
anchor-disciplined virtual clock (phones slew _clockOffset to the DJ
anchor's time base, killing per-phone server RTT asymmetry ~10–40ms).
Right destination, wrong night. Design law from line 6 ("dragons fight in
the meadow"): exactly ONE clock authority at a time — server loop must
fully yield when the anchor disciplines, never blend. See Obsidian "BYOB
Synced Entry" action items.

---

## 2026-07-07 ~2:30am — anchor-disciplined virtual clock (MARKED OCCASION)

**Revert point: `pre-master-clock` tag (83f9efb).** Change: `15e622e`.

**Oracle:** deferred earlier by dual cast (30.1.4.6→15 / 2.2.6→4 "dragons");
user directed proceed; implementation cast 15.1.3.6→27 — Modesty (the very
hexagram the user's cast resolved to): line 6 "set armies marching to
chastise one's own city" = each phone disciplines its own clock; →27 mind
what feeds it (sample hygiene).

**Change (listener.html):** `_anchorClockDiscipline()` on every DJ anchor
heartbeat: o = ourServerNow − anchor.ts = clockError + latency; min(o) over
a 24-beat (~2min) window estimates error at the latency floor; slew
_clockOffset ∓15ms/heartbeat with a 15ms deadband, 2s outlier guard, window
reset after 30s anchor silence. **One authority:** measureClockOffset
returns early while the anchor is feeding (bootstrap + >60s-silence
fallback only). Kills per-phone server RTT asymmetry; the common latency
floor is shared by all phones → zone_offset territory.

**Offline sweep:** 3 simulated phones, errors +45/−70/+120ms, latency
U(30,150): window 12/deadband 10 converged but sawtoothed ±38ms; **window
24/deadband 15 → 15ms inter-phone in 5min, 0.0ms wobble over 33min.**

**Status:** deployed; phones pick it up on next refresh/wake. Verify: watch
[anchor-clock] slews in device consoles taper to silence; launch-report
per-launch absolute offsets (previously wandering 0–80ms per launch) should
stabilize; then trim the stable residual with zone_offset_ms.

**SECOND CROSSING ~sunrise (`c97364c` + gauge `8a9dd9d`, oracle 64.2→35 —
"he brakes his wheels; perseverance brings good fortune" → Progress, the sun
rising):** same min-filter core, two lessons applied: (1) slews only in
P-state (engine converged <50ms, not silent-warping) so the corrector never
chases a moving reference; (2) every slew calls the calibration layer's new
`noteExternalDisturbance()` hook so floor sampling sits out the settling
stretch (the 15ms slews were invisible to the 120ms jump detector). Coupling
is one-directional — clock reads anchor timestamps, never drift — so cal
cannot poison the clock back. Gauge fixed first: ter_ hud rows now carry
ts/duration/deviceLatencyMs, so live-monitor's MASTER column reads the
trusted rows. Gated sim: 190→5ms inter-phone in 80 beats despite 30%
gate-outs, zero wobble. Verify live: [anchor-clock] slews taper, cal floors
stay honest, MASTER column stabilizes → trim zone_offset_ms once.

**REVERTED ~3:15am (`0b54638`, oracle 59.2.5→23 — "hurry to that which
supports him"):** phones that refreshed onto the clock discipline
destabilized within minutes (250–460ms finals, 11–25 snaps/window, latency
debt re-inflating right after RESET CAL) while the one pre-refresh phone
stayed rock stable. The dragons' third form: the clock slew and auto-cal
both absorb the same residual — clock moves the reference ≤15ms/heartbeat,
corrector chases, auto-cal eats the churn into stored latency. The 2.2.6→4
warning was about server-vs-anchor; the REAL second authority was auto-cal.
Redesign requirement for daylight: when the anchor disciplines the clock,
auto-cal must be frozen (or the clock slewed only while cal is settled) —
one authority per signal, not just per clock. Offline sim missed it because
it modeled no calibration loop. The `pre-master-clock` tag did its job.

---

---

## 2026-07-07 daylight session — stabilization + instrumentation

Direction set by a five-question cast batch: acoustic bench YES-as-servant
(54.1.2→16 "one-eyed man who is able to see"); construction freeze (31);
entry-phase cal gate YES (44.2.5→22); anchor clock DORMANT (19.3→11 again);
ternary engine parked hard (23.3→52, double hold).

Shipped: DJ gate retreat 500ms restored (12.3→33 — quiet self-repair for
150–500ms band was cast and HELD); entry-phase floor-sample gate + engine
`isEntryPhase()`; anchor clock behind `window._anchorClockEnabled` (default
off); ter hud rows carry ts/duration/deviceLatencyMs (master gauge on
trusted rows); monitor grades ter-only + final-tick ghost detection.

Acoustic bench built (sox + numpy venv, scratchpad roombench.*): real music
defeated both envelope and waveform correlation (loop-based tracks
self-match every ~5.5s). Non-repeating bench signal generated →
~/Desktop/byob-bench-signal.wav (60s chirp cloud); upload as a track and
play once to measure every speaker's true acoustic offset (master's own
peak = zero reference). NOT the banned mic calibration — laptop-side bench
only.

45-min scorecard: sap54f self-healed (22ms med, 0 snaps — the machinery
works); dlqexq healing (239→80ms); four phones DEADLOCKED at 160–240ms:
**snap↔cal deadlock** — ≥6 snaps/min means never 10 calm seconds, so the
calibration that would stop the snapping can never run. Broken live with
floor-sized latency_cmd nudges (the correction cal would have made).

Unresolved measurement puzzle: latency_cmd nudges of +700/+1100ms moved the
monitor's master column only ~80ms — the audible-position model
(currentTime − deviceLatencyMs) is not validated; bench first, then trust.

**NEXT SESSION, FIRST MOVE (cast already obtained, 14.2→30 — "a big wagon
for loading"): GREENHORN FAST-CAL for live crowds.** Reframed goal: 500
random BT devices entering, sound-sync near-immediate. Element sync is
seconds and scales; sound sync is minutes and hand-tended. Design blessed:
(1) device with no stored latency makes ONE bold 100% correction from ~8
early drift samples (2s post-disturbance, post-entry) within ~10–20s, then
conservative mode — also structurally cures the snap↔cal deadlock;
(2) trust ctx.outputLatency at t=0 harder; (3) crowd prior — devices report
(model, learned latency) so new arrivals of known hardware start correct;
the bigger the crowd, the faster it syncs. Implementation was about to
begin in ternary/layer.js tick() when the session closed — no code written.

---

**Next session (casts pending):**
- Live-verify floor hygiene + zone offset knob + restarted bridge; disciplined
  launch-cycler session at 60s cadence; tighten PASS bar 50→25ms.
- Watch: devices whose true BT latency exceeds the 1200ms cap (oracle has
  held against raising it three times, latest 64.1→38 — revisit only with
  clean post-fix evidence).
- Note: same-track relaunches don't reload the audio element — wedged phones
  free only on a DIFFERENT track URL (or reload). Candidate fix if it still
  matters after escalation lands.

---

## 2026-07-07 evening session — greenhorn fast-cal (offline build)

No live listeners — built and validated offline per the fourth-wave handoff
(cast already obtained, 14.2→30 — "a big wagon for loading").

**Shipped (code + sim, NOT yet live-verified):**
- **Greenhorn fast-cal** (`ternary/layer.js`): device with no stored latency
  at load makes ONE bold 100% correction from 8 drift samples needing only
  2s post-disturbance calm each (vs auto-cal's 10s) — median + agreement
  guard (≥5/8 within ±60ms, else slide). <25ms → stands down. After firing,
  conservative lane (`_calCount = 1`). Structurally immune to the snap↔cal
  deadlock: 2s calm windows exist between snap-storm snaps.
- **Crowd prior**: `byob_ternary` trit broadcasts now carry
  `(model, latencyMs, calSettled)`; a greenhorn with ≥2 settled same-model
  peers seeds from their median latency on its first tick. One shot; own
  fast-cal may still refine once.
- **Plumbing** (`listener.html`): `window._terLatencyWasStored` flag at load;
  `hudResetCal()` calls `_terLayer.noteLatencyReset()` so RESET CAL re-arms
  the greenhorn lane (relearn boldly, `_calCount = 0`).
- **Debug fields**: `terGreenhorn`, `terGreenSamples`, `terGreenPrior` in hud
  packets; `ter_greenhorn_cal` / `ter_crowd_prior` sync_events.

**Offline validation — `sync/greenhorn-sim.mjs`** (runs the REAL layer.js in
a vm sandbox with simulated clock + calibration loop — the loop the reverted
master-clock sim lacked). Five scenarios, all pass:
1. plain greenhorn floor 350ms → one correction at 20s, lands 343ms
2. deadlock (snap every ~7.5s, floor 200ms) → auto-cal can never run,
   greenhorn fires at 50s with +201ms
3. crowd prior (2 settled Pixel-7 peers @300ms) → seeded 300ms on first
   tick at 2.5s, stands down, no second correction
4. tight greenhorn (floor 10ms) → zero corrections
5. veteran (stored latency) → greenhorn lane stays dark

**Live verify next session:** fresh phone (or RESET CAL) should show
`terGreenhorn:true` → one `ter_greenhorn_cal` within ~20s → converged
without hand-tending; two same-model phones then a third → third should
log the crowd prior and enter near-correct.

**Deploy cast (55.1.4→15 — Abundance, "dark at midday, yet he meets his
hidden ruler" → Modesty): GO.** Pushed `ba763b2` between broadcasts.
Phones pick it up on next refresh. Live-verify checklist unchanged above.

**LIVE VERIFY (same evening, 3 phones ~20:45–21:10):**
- 🌱 **Greenhorn fired live**: after RESET CAL, `ter_sld052` re-armed and
  made its one bold shot — `floor=104ms → correction=104ms (#1)`, zero
  snaps, no hand-tending. RESET→greenhorn re-arm path confirmed working.
- **Watch item found — conservative lane races the bold lane:** `h4k5e3`
  never greenhorned; two small auto-cals (18/20ms) fired first and disarmed
  it (by design), leaving an ~85–117ms sawtooth the bold lane would have
  taken in one bite. Cause hypothesis: the sawtooth spread keeps failing
  the ±60ms agreement guard, sliding the window until 30s auto-cal wins.
  Candidates (cast first): widen agreement band; or don't let a sub-30ms
  auto-cal disarm a still-armed greenhorn.
- Crowd prior not exercised — all three phones different models.
- Master gauge vindicated: MASTER median −7ms ✅ on trusted ter rows
  (the ~87.7s mystery was the dev_-row-only computation, now bypassed).
- End state: 3 phones flat at 67–117ms drift, snaps=0, spread 40–48ms —
  quiet but not tight; residual debt for auto-cal/zone_offset to close.
- Monitor patch: `ter_greenhorn_cal`/`ter_crowd_prior` sync_events now
  print inline (🌱/👥) — they were silently dropped before.

## 2026-07-13/14 — relay migration + first live audio + anchor-broadcast bug found

**Context:** Jul 13 — Supabase retired for a self-hosted relay
(`bridge/relay.mjs` + `byob-shim.js`, see repo CLAUDE.md "Architecture").
Before this session NO audio reached any listener at all (root cause:
absolute Cloudflare tunnel URLs baked into `tracks.public_url` /
`zones.current_track_url` at upload time; tunnel host rotates every
restart). Fixed by a read-time normalizer in `byob-shim.js` (rewrites any
stale `*.trycloudflare.com` or `localhost:3100` `/storage/` URL to the
client's current relay origin on every message) — heals existing rows with
no migration, survives future rotations. Also fixed: `artist.html`
`loadFromLibrary` was reading a nonexistent storage-list API against the
wrong bucket path (`from('tracks')` instead of `from('boombox')`) — now
lists the `tracks` table directly. Also added: one-active-zone-per-`host_id`
enforcement in `relay.mjs` (`enforceOneActiveZone`, single choke point on
insert/update/upsert), a bridge Play guard (won't broadcast `hard_sync`
with no `track_url` — falls back to the zone's `current_track_url` or
rejects with a toast), `deactivate_zone` command, and single-port WS
(`:3000` upgrade, alongside legacy `:3001`) for Safari. `ternary/overlay.html`
was still pointed at the retired Supabase project — repointed to the relay
via `byob-shim.js`. Bridge UI got a **Broadcast Ableton** section — the
WebRTC Go Live path (BlackHole capture → phones), ported verbatim from
`artist.html`'s `toggleLive()`/`startWebRTCBroadcast()`, so the bridge can
now do everything artist.html's Go Live did, just from the bridge's browser
page instead. None of the above touches the corrector/anchor/calibration
code — plumbing only.

**Once audio reached phones, sync was messy** — "clip a bunch, snap in
perfectly, then cut out and desync, cut out and resync" (Neeff's words),
worse as the track played longer. Diagnosed with a live `byob_debug` capture
plus a browser-exported CSV (`byob-obs-2026-07-14T02-05-05-315Z.csv`, 1082
rows, kinds sync/health/event, 3 real devices dev_0ro7iy/dev_mkc9x4/dev_rd00fx
across ~5.5 min):

- `master_verdict` (bridge-computed, field vs. bridge's own `_playbackStartedAt`)
  swung wildly and non-stationarily: −47000ms → −35000ms (rising) →
  −59500ms (sign-flipped, then plateaued). A STABLE wrong offset would mean
  a one-time bad anchor; a MOVING one means the thing being measured is
  still sliding in real time.
- `dev_0ro7iy`: idle↔warping the entire capture, drift sawing −245ms to
  +141ms, **snapCount frozen at 4 for all 110 rows** — perpetually warping,
  never converging (audible as continuous pitch-bend).
- `dev_mkc9x4`: `deviceLatencyMs=0` all session (never calibrated), snapCount
  crept 9→10→11 (**two real seek/mute/ramp events** — the literal audible
  cut-outs) while cycling warping/seeking/idle throughout.
- `dev_rd00fx`: joined late, snapCount frozen at 0 — never corrected once.
- Isolated tick outliers (drift +2324ms, −1530ms, +1897ms) all traced to
  `currentTime≈0` vs. a stale `expectedPos` at track-load — one-tick
  transients the corrector's own wrap-guard already discards (`seekIntendedMs`
  stayed small even when raw `driftMs` spiked). Not the live bug.

**Root cause — traced code, not yet fixed (needs a cast before touching):**
Two independently-reasonable changes compound:

1. **Pre-existing scoping bug, `listener.html:4275-4284`.** The DJ's 5s
   `anchor` broadcast handler unconditionally runs
   `_anchorPlaybackStartedAtMs = payload.ts - payload.position * 1000` —
   only the *extra smoothing* (`_anchorClockDiscipline`, the "anchor-
   disciplined clock" from `c97364c`/oracle 64.2→35) is gated by
   `window._anchorClockEnabled` (documented OFF/dormant, oracle 19.3→11).
   The raw reference override is **not** gated. At `listener.html:6274`,
   `_anchorPlaybackStartedAtMs ?? row's playback_started_at` is what the
   corrector actually uses — so every listener has been silently re-deriving
   its ground-truth reference from the DJ's *live* playhead every ~5s,
   despite the system believing that path was shut off.
2. **Last night's `a494a8f` self-nudge, `artist.html:2896-2926`.** When the
   DJ's cached reference drifts 100–500ms from its own expectation, the DJ
   hard-seeks (`audio.currentTime = ...`, no mute, no ramp) its *own* audio
   to match — deliberately scoped as local-only/cosmetic, no
   `noteStartedAt()`, no row write, no `hard_sync`. But because of (1), that
   same jump-cut position gets broadcast via `anchor` 5s later and adopted
   as every listener's new ground truth anyway.

Together: a reference that moves (sometimes jump-cuts) every 5 seconds,
faster than any single phone's own corrector can settle — reads exactly as
"clip, snap in perfectly, cut out, resync, repeat," worsening the longer the
track plays as the DJ's own cached reference accumulates more divergence to
nudge against. This also fully explains the `master_verdict` swings: the
bridge's verdict math compares listener-reported offsets to
`_playbackStartedAt`, while listeners have actually been tracking a
different, wobbling reference underneath the whole time.

**Proposed fix (minimal, matches the two-nights-ago oracle intent that
"dormant" should mean dormant):** gate the raw assignment at
`listener.html:4277` behind the same `window._anchorClockEnabled` flag that
already gates `_anchorClockDiscipline()` — a scoping fix, not new design.
With it off (current default), listeners fall through to the stable row
`playback_started_at` unconditionally, as intended. **Not yet cast or
applied — do before touching per repo protocol.**

**Also logged:** a related, smaller "follow the row" gap on the bridge side
was found and cast on mid-session — 29→46 (Abysmal repeating → Pushing
Upward), lines 3 and 5 moving. Reading: fix confirmed but scope constrained
("fill the abyss only to the rim, no higher") — the bridge should adopt
`playback_started_at` from the zone row whenever it changes and the bridge
didn't mint the launch itself, nothing more (no new correction channel, no
broadcast). Not yet implemented — smaller than the anchor-broadcast bug
above and likely secondary to it.

**Fix applied 2026-07-14** (cast 63.5.6→22 — After Completion, small offering
outperforms the big one → Grace, keep it plain): gated the raw
`_anchorPlaybackStartedAtMs` override at `listener.html:4277` behind
`window._anchorClockEnabled`, matching the flag's original documented
intent. With the flag off (current default), `_anchorPlaybackStartedAtMs`
now stays `null` and listeners fall through unconditionally to the row
`playback_started_at`. `_launchGuardUntil` clear left ungated (guard-clear
only, not a reference override — line 6 of the cast said watch this
carefully rather than assume one gate closes everything, so flagging it
here explicitly as reviewed-and-intentional). Commit `9718f40`, pushed —
phones pick it up on next refresh. **Live-verify next: same test as before
(byob_debug capture / CSV export over a several-minute track) — expect
snap counts to stop incrementing and master_verdict to stabilize instead
of swinging.**

**Second fix applied 2026-07-14** (cast 8.1.5→24 — Holding Together, "the
king's beaters cover three sides only, foregoes game running off in front"
→ Return: push forward, don't revert, light touch): `noteCalDebt`'s
`DEBT_MIN_RUN` raised 3→7 in `ternary/layer.js`. Root cause was distinct
from the anchor-broadcast bug — a second, independent problem in the same
session's symptom ("once synced perfectly, audio jumps and resets"). The
debt-ratchet detector's own design comment already said the right thing
("real calibration converges, a ratchet only climbs") but the
implementation only checked sign-consistency + a raw sum over 3
corrections — well inside a single track's normal legitimate budget (4
auto-cal/snap-cal + 1 greenhorn + 1 crowd-prior = 6). Live data showed
three phones getting zeroed mid-legitimate-convergence (12→91→197ms,
112→246→312ms, 496→615→664ms — all plausible real floors, especially
`v1vjb8`'s ~664ms) right as they approached their true latency. Raised past
the max legitimate same-track count so it only fires on genuine
cross-track/persisting debt. Commit `81ffce3`, pushed.

**Live-verify next:** run a track for several minutes without refreshing;
watch `deviceLatencyMs` per device — it should climb and *hold* (no more
drop-to-0 resets) as it approaches each device's true floor. Use the new
overlay.html marker buttons (✅ Synced / ⚠ Jump / 📝 Note, commit `d0c8147`)
to stamp exact moments for correlation against the CSV export.

## 2026-07-14 (cont.) — anchor-disciplined clock: offline re-validation, still NOT ready

**Question:** after fixing tonight's anchor-broadcast scoping bug and the noteCalDebt
ratchet, is it safe to re-enable the dormant `window._anchorClockEnabled` (the
anchor-disciplined clock, `_anchorClockDiscipline` in listener.html) as the
"disgustingly simple" fix for phones that converge individually but never
share one absolute reference?

**Cast: 50.4→18** (The Cauldron, "legs broken, meal spilled" → Work on What
Has Been Spoiled). Reading: the mechanism is the right vessel for this
problem, but line 4 warns against trusting an unchecked foundation with
weight — resolving to 18 says the correct move is deliberate re-validation,
not a live flag-flip. Built `sync/anchor-clock-sim.mjs` (same real-code vm
sandbox approach as `greenhorn-sim.mjs`) to validate offline first.

**History this matters against** ("2026-07-07 ~2:30am — anchor-disciplined
virtual clock" above): this exact mechanism was deployed live and REVERTED
TWICE the same night. First offline sim modeled no calibration loop at all.
Second attempt added `noteExternalDisturbance()` coupling (cal sits out the
settling stretch after every slew) — still destabilized live within minutes
(250-460ms finals, 11-25 snaps/window). Postmortem: "the clock slew and
auto-cal both absorb the same residual... one authority per signal, not just
per clock" — never actually redesigned, just reverted.

**Sim result: 3/4 scenarios FAIL.** Ran `_anchorClockDiscipline`'s real
algorithm (ported verbatim) alongside the REAL `ternary/layer.js` calibration
loop, modeling measured lag as the sum of an uncorrected clock-offset
residual + an uncorrected device-latency residual (the literal "one signal,
two authorities" coupling from the postmortem):
- **Scenario A** (clock error 120ms + latency 280ms, 20min): converges partway
  then PLATEAUS at ~60-85ms residual for the rest of the run. Final residual
  258ms vs the 60ms bar.
- **Scenario B** (clock error 180ms + latency 20ms, 15min): same plateau
  shape, final residual 441ms.
- **Scenario C** (latency 350ms alone, NO clock error — control): converges
  cleanly to <35ms and holds. Confirms the corrector itself is fine in
  isolation — the failure is specifically the interaction.
- **Scenario D** (noisier anchor, stress test, 25min): same plateau shape,
  final residual 315ms.

**New failure mode found (distinct from the 2026-07-07 "cal eats slew churn"
danger):** a genuine deadlock at the boundary of both mechanisms' gating
conditions. `_anchorClockDiscipline` only slews while the corrector's own lag
reading is already <50ms (the P-state gate — only nudge once things look
basically converged). But `maybeAutoCalibrate`/`maybeSnapCal` exhaust their
shared per-track budget (`_calCount` caps at 4) while the residual is still
sitting just ABOVE that 50ms line. Calibration is out of moves; the clock
won't slew further because the engine never looks "converged enough" to earn
it. Neither mechanism finishes the job — the device plateaus at a stable but
wrong position for the rest of the track.

**This plausibly explains tonight's live "stable but none at the same time"
finding directly**: each phone would plateau at ITS OWN residual (different
clock-error/latency mix per device), never reaching a shared absolute
position — re-enabling as-is would likely reproduce a milder version of the
exact symptom it was proposed to fix, not solve it.

**Verdict: DO NOT enable `window._anchorClockEnabled` yet.** Redesign needed
before a third live attempt — candidates for next session (cast before
building): loosen the P-state gate to allow slewing based on the anchor's own
sample confidence rather than the corrector's current lag reading; or extend
the correction budget specifically for tracks where clock-discipline is
active; or coordinate the two budgets explicitly (one combined budget/gate
covering both authorities, per the original postmortem's "one authority per
signal" requirement, never actually implemented). Sim harness
(`sync/anchor-clock-sim.mjs`) is reusable for validating whichever redesign
comes next — extend scenarios there before any live re-enable.

## 2026-07-14 (cont.) — live tuning session + the real remaining gap: ground truth, not opinion

**Live tuning session** (post noteCalDebt fix, ~03:15-03:42, growing to 5+
phones with a full restart mid-session): individual devices calibrated
cleanly all session — clean auto-cal/greenhorn/snap-cal corrections landing,
no more stuck-forever devices (one exception below). `dev_k15e54` sat at
`deviceLatencyMs=0` for 13+ minutes at one point with zero calibration
attempts; root cause found live via a full hud_data payload capture:
`"visibilityState": "hidden"` — the tab was backgrounded, and Safari heavily
throttles JS on hidden tabs, starving the calibration loop of ticks. Not a
code bug — the phone's screen was off. Resolved itself after the user's
full restart. Separately found (and worth building, not fixing tonight): my
own live-monitor script conflated "still reads 0 after a restart" with
"still stuck from before" — track_change/hard_sync events now reset the
stuck-timer in the monitor script so future live-watches don't misreport.

**Referenced `91ee6c8` (May 16 2026, evening before "May 17"), user's memory
of "it worked and was binary":** confirmed — that commit's drift correction
was a pure binary threshold: `if (drift > 0.08) seekPreservingBT(expected)`,
no proportional warp at all (matches the documented `6f4f5b0`/May 13
"philosophical anchor" baseline in repo CLAUDE.md). Also confirmed its
clock-sync was radically simpler: ONE single RTT sample taken once
(`measureClockOffset` — one `t0`/`t1`/one `server_now()` call), no 8-sample
median, no 30s re-measurement, no ternary layer, no auto-cal/greenhorn/
snap-cal/debt-ratchet, no anchor-clock — none of tonight's whole apparatus
existed yet.

**The core finding, stated precisely by the user mid-session:** "It sounds
fine individually, but misses the mark totally when many are playing." This
reframes everything chased tonight. Traced to three real, distinct sources
that all differ per-phone and are NEVER reconciled against each other:
1. Each phone's own independently-measured `_clockOffset` (RTT-sampled,
   noisy, no cross-device reconciliation).
2. Cached `playback_started_at` can be stale on some phones for up to 60s
   after a relaunch (syncZoneAudio poll interval) or a missed hard_sync.
3. Each phone's own `deviceLatencyMs` — correctly meant to differ per
   device, but frequently wrong-in-flight (calibration resets, stuck states,
   snap-cal/debt-ratchet corrections chasing a moving true value).

**Then the key design conversation.** User: "I thought that is why we made
the ternary system... to make them all agree... and the octonary system."
Checked the actual code (`weightedConsensus()`, `isGlobalDisruption()`,
`peerMedianLag()` in `ternary/layer.js`): **all peer consensus in the
current system operates on each phone's own SELF-REPORTED verdict** — trit,
octoState, lagMs — every one of them already computed against that phone's
own private (possibly-wrong) reference. `weightedConsensus` even gives
ANCHORING peers 2× vote weight. None of it ever compares two phones' actual
playback positions against each other. **It's consensus of opinions, not
comparison of ground truth.** A room where every phone is confidently,
consistently wrong (each converged to a different absolute instant) reads
as full consensus (`P`) to this system — because it never checks agreement,
only self-consistency. This is a precise, load-bearing distinction: ternary/
octonary were built for (and are good at) detecting collective disruption
and speeding up individual convergence (crowd-prior, ANCHORING-weighted
vote) — not for verifying the room actually agrees on where the song is.

**User confirmed: original design intent WAS the ground-truth version** —
"when we were making it I wanted its purpose to be exactly that," "can we
add a layer that makes them all talk?" This is the real, correctly-scoped
next-session target.

### Next-session build target: a comparable ground-truth peer layer

**What to add** (purely additive — new broadcast field + new comparison
function, does NOT touch any correction/seek/warp/cal decision logic, so it
does not need a cast; it's telemetry, not corrector behavior):

- In `broadcastPeerTrit()` (`ternary/layer.js` ~line 703), add one new field
  to the existing `trit` broadcast payload: a reconstructed, directly-
  comparable absolute reference point — e.g.
  `refMs: payload.ts - (currentTime - deviceLatencyMs/1000) * 1000`
  (same math the bridge's `master_verdict` already trusts: back-compute
  "what wall-clock instant does this phone believe corresponds to
  `playback_started_at`, given its own current audible position"). If every
  phone truly agreed, every phone's `refMs` would be identical. If they've
  diverged, this is a REAL, comparable number — not a self-report.
- In `receivePeerTrit()` (~line 633), store the peer's `refMs` alongside the
  existing fields.
- New function, e.g. `roomSpreadMs()`: across all live peers + self,
  extrapolate each stored `refMs` forward by elapsed real time since its
  `ts`, and return max−min — a true, live "how far apart is the room
  actually" number, comparable in spirit to what I computed by hand tonight
  from the CSV (the 700-800ms cross-device `currentTime` gap).
- Surface `roomSpreadMs()` in the existing `hud_data` broadcast (already
  carries many fields) so it flows to `byob_debug` → `ternary/overlay.html`
  for live display — a genuine, ground-truth "Room Spread: Xms" gauge,
  distinct from and complementary to per-device drift.
- **Stop here for a first pass.** Do NOT wire `roomSpreadMs()` into any
  correction action yet (e.g., nudging a phone toward the room median) —
  that would be a real corrector behavior change and needs its own cast,
  once the comparison layer itself is live-verified to actually reveal true
  room agreement/disagreement correctly.

This is the honest fulfillment of the ternary system's original intent —
consensus over what's actually true, not consensus over what everyone
privately believes.

## 2026-07-14 (cont.) — discrete room-consensus correction: first offline validation, promising

Built `sync/room-consensus-sim.mjs` to validate the discrete correction
design from the consensus-plan conversation (see "the real remaining gap"
above): instead of a continuous clock-slew (anchor-clock, already found
broken), a phone periodically compares its own reconstructed reference
(refMs, same math as the new overlay Room Spread gauge) against the room,
and — only past a threshold and rate-limited — fires ONE discrete jump via
the existing `window._terCorrect()` path (same machinery `hard_sync` already
uses), entirely separate from `deviceLatencyMs`/calibration state.

**Result: 3/4 checks fail, but for tuning reasons, not a structural
deadlock** — a genuinely different and better outcome than anchor-clock-sim:
- **Scenario B** (clock-error dominant, 180ms true error): PASSED all three
  checks. One discrete correction landed the clock offset within ~6.5ms of
  true, final residual **13.5ms**. Calibration converged normally alongside
  it with zero interaction/fighting — no sign of the anchor-clock's deadlock.
- **Scenario A** (120ms true clock error + 280ms latency): correction never
  fired — the 150ms threshold was too high for this magnitude of error plus
  ±20ms peer noise. Tuning issue, not a flaw: lower the threshold.
- **Scenario D** (noisy peers, ±60ms): fired once but overshot by ~22ms —
  a ONE-SHOT correction has no noise-averaging, so it fully inherits
  whatever single noisy peer-comparison sample it acted on. The anchor-clock
  avoided exactly this by taking a min-filter over 24 samples before acting;
  this design wants an analogous short averaging window (a few peer
  readings) before committing to the jump, not a reaction to one sample.

**Conclusion: the discrete-jump design itself is sound and worth pursuing** —
unlike the anchor-clock, it shows no interaction/deadlock with calibration
in any scenario tested. Before live implementation: (1) lower/tune the
disagreement threshold so real errors in the 100-150ms range actually
trigger a correction, (2) average several peer refMs samples over a short
window (e.g. 3-5 readings) before computing the jump, instead of acting on
one comparison. Re-run this sim with those two changes before considering a
cast to implement live. Not yet attempted tonight — clean stopping point.

## 2026-07-14 (cont.) — room-consensus correction: shipped live, broke, reverted

Deployed the sim-validated discrete room-consensus correction live (commit
`38c5655`) after casting specifically on the deployment step: **53.1.4.5→30**
(Development, gradual step-by-step progress with real doubt at early/middle
stages, "no blame" → The Clinging, a fire that must be continually tended,
not lit once and left). Read at the time as a genuine go-ahead, with the
explicit expectation of watching closely and possibly not succeeding on the
first try — which is exactly what happened. The cast's caution held up.

Also mid-session: the Cloudflare quick tunnel silently died (process still
running, hostname unresolvable) after running a long time — unrelated to
the sync work, just an operational blip. Restarted via `bridge/start.command`
(relay/bridge untouched, only the tunnel + `relay.json` republish needed).

**Live watch caught two real bugs within ~3 minutes of deploy, before any
harm beyond audible jumps on a handful of devices:**

1. **`measureClockOffset()`'s existing independent 30s timer overwrites
   `_clockOffset` with a fresh RTT measurement every cycle, with zero
   awareness of the new room-consensus correction.** Its early-return guard
   only trips when `_anchorClock.active` — which requires the (disabled)
   anchor-clock discipline to have fired — so with that flag off, nothing
   protects a room-consensus correction from being silently clobbered ~30s
   after it lands. Confirmed live: multiple devices' `clockOffset` reverted
   to their pre-correction value between firings and re-fired repeatedly
   (`dev_zo12r3`, `dev_ldd9gh`, `dev_1uzrbr`, `dev_2nkyiv` all cycling every
   ~30-40s). User confirmed audibly: "all are about a second or more off
   from one another" — the correction never got the chance to help.
2. **`computeOwnRefMs()` has no track-loop-wrap guard**, unlike
   `bridge.mjs`'s `master_verdict` (which explicitly handles this — see the
   wrap-ambiguity comment there). A track wrapping to `currentTime≈0`
   produces a nonsensical `refMs` for one peer; averaged into the 4-sample
   window, it poisons the whole correction. Live evidence: `dev_1uzrbr` got
   hit with a **−67593ms** correction, then **+34779ms**, both wildly larger
   than the true ~1000ms disagreement — the averaging window has no
   defense against one contaminated sample.

**Response:** reverted immediately (`git revert 38c5655` → `2713593`),
pushed, confirmed deployed, confirmed via live monitor that all devices
stopped firing once reloaded (~5min from bug discovery to fully clear).
Tonight's two real fixes (anchor-broadcast scoping, `noteCalDebt` threshold)
are UNAFFECTED — the revert only removes today's newest, broken piece.

**Fix requirements for the next attempt (both must be addressed, then
re-validate in `sync/room-consensus-sim.mjs` — which did NOT model either
failure mode, a real gap in that sim, before ever trying live again):**
1. Either gate `measureClockOffset()`'s periodic re-measurement behind an
   `_anchorClock.active`-equivalent flag that room-consensus also sets, or
   have `_terAdjustClockOffset` and `measureClockOffset` share one clock
   authority explicitly (same "one authority per signal" principle the
   anchor-clock postmortem already named but this new mechanism didn't
   inherit).
2. Add the same wrap-ambiguity guard `master_verdict` already has to
   `computeOwnRefMs()`/`peerMedianRefMs()` — drop readings where
   `currentTime` is near a track boundary, or wrap the comparison modulo
   duration the same way.
Extend `room-consensus-sim.mjs` with scenarios modeling BOTH: a periodic
independent clock-remeasurement timer running concurrently, and a
track-loop-wrap event during the averaging window. Neither was simulated —
that's the real lesson, not "the concept is wrong."

**On the state of things:** cutting-out (fixed, verified), the ratchet-reset
bug (fixed, verified), and the room-consensus/ground-truth gap (correctly
diagnosed, correctly speced, first live attempt correctly caught its own
bugs and rolled back clean). The Room Spread gauge in `ternary/overlay.html`
(commit `c800a71`, unaffected by this revert — pure telemetry) remains live
and will show the true room spread whenever this is attempted again.

## 2026-07-14 (cont.) — room-consensus v3: SECOND live attempt, reverted again

Ported the v3 design (wrap-guard + one-authority-full-yield + zone_offset
disturbance gate) from the sim into real code for the first time since the
`2713593` revert, cast specifically on the deploy step (55.3.4→24 —
Abundance→Return, third independent cast this session confirming the
approach), deployed (`93dad07`), phones refreshed onto it.

**Live result: room felt "generally chaotic."** Checked telemetry directly
before deciding anything — watched `sync_event`/`correction_event` traffic
for 65s straight. Found: **zero `room_consensus` corrections had fired** in
that window (its first possible correction needs ~40s of accumulated
4-sample averaging, so it hadn't even activated yet) — what was actually
observed was a legitimate DJ track change (`track_change`+`hard_sync` on
all 3 devices) landing at the same moment several freshly-refreshed devices
were independently mid-recalibration (`auto_cal` events, 87→26ms,
364→313ms) — the same "track changes are chaotic, fresh devices
recalibrating" pattern that's always existed, not new.

**Cast on whether to revert anyway: 30.3.4→27** (Fire/Clinging→Nourishment).
Line 4 ("its coming is sudden; it flames up, dies down, is thrown away")
read plainly as a revert signal. Line 3 (sunset, calm acceptance vs. gloomy
complaint) read as: treat this as a natural step-back, not a dramatic
failure. **Reverted** (`081efc4`), pushed, despite not having directly
caught room-consensus misbehaving — because its danger window was still
ahead (not yet fired) rather than behind, "no misfire observed yet" wasn't
the same as "confirmed safe," and the live cost of waiting to be extra sure
falls on an actual running party, not a test session.

**Honest state of things:** still not proven whether v3 itself would have
caused real problems if left running through its first actual correction —
genuinely inconclusive, not a confirmed-bad result like the first attempt's
`-67593ms` correction bug. Reverted on caution + cast + the practical
reality of a live set, not on hard evidence of a new bug. `zone_offset_ms`
disturbance gate reverted along with it (same commit, not isolated) —
harmless but simplest to revert as one unit, matching the precedent from
the first room-consensus revert.

**Before any third attempt:** get a genuinely quiet verification window
(not a live set) to actually observe a `room_consensus` correction fire
start-to-finish, rather than judging from a deploy window that happened to
coincide with an unrelated track change. The sim validation (E/F/G, ~75-90%
clean pass rate at a strict bar) and the two real code fixes (wrap-guard,
full-yield) are still believed sound — what's unresolved is purely "does it
behave live," which this session did not get a clean chance to observe.

## 2026-07-15 — octonary cascade consensus: designed, built, sim-validated, ported

**New day, controlled test only — no live party, explicitly agreed
("just me and you testing, I wouldn't test this at a party").**

**Design origin:** real CSV analysis (`byob-obs-2026-07-14T17-37-57-018Z.csv`,
post-revert baseline) found one device (`k7je2c`) was the lowest/most-
reference-like `refMs` in **106/106** five-second windows across the whole
session — a stable natural flagship the flat weighted-median approach (v3)
never recognized or used. Also found the disagreement itself is a slow,
stable, near-constant bias per device (one stretch held ±8ms for nearly a
minute), not fast jitter — the right regime for a rate-limited discrete
correction, wrong regime for a continuous slew.

**Design: NTP/PTP-stratum-style cascade** — each device locks onto its
single highest-octonary-weight visible peer (ANCHORING 2.0 > HOLDING 1.5 >
PULLING 1.0 > ... > REACHING 0.0) and corrects toward that ONE peer's
`refMs`, rather than v3's flat median of all peers. Trust propagates
outward one hop at a time; a real flagship (or the DJ, in a later
follow-up) emerges from the existing weight table with no manual
assignment. First divergent cast of the session (mine: 52, Keeping Still;
user's: 19.1.2.4→16, Approach→Enthusiasm) — reconciled as "discuss/design
yes, code not yet," consistent with three earlier casts resolving to
Return. Cast specifically on this cascade design once formulated:
30.4→22 (Fire→Grace), line 4 repeating the exact same "flames up, dies
down, thrown away" caution from the earlier revert decision — read as
refine-in-sim, not rush-to-deploy.

**Built `sync/octonary-cascade-sim.mjs`** — multi-instance harness, N real
independent copies of `ternary/layer.js` sharing one wall clock, exchanging
real trit+refMs broadcasts through an in-process bus (not one device vs. an
abstracted peer median like room-consensus-sim.mjs — this needed actual
interacting instances to test emergence).

**Real bugs found and fixed during sim iteration (not tuning nits):**
1. **Chicken-and-egg deadlock**: requiring a peer to already be HOLDING/
   ANCHORING before ever acting means the room can get stuck at PULLING
   forever whenever no device can naturally reach that trust level WITHOUT
   the correction it's gated on (exactly true for an uncorrected clock-type
   error — calibration alone plateaus, see room-consensus-sim.mjs scenario
   A'). Fixed: lowered minimum trust weight to accept a PULLING-level peer
   (1.0) as a valid, if weak, bootstrap anchor.
2. **Sim-only bug**: `ownRefMs()` used the raw shared clock instead of
   `syncedNow()` (clock + own `clockOffsetMs`), making corrections
   invisible to the next cycle — runaway re-correction, -1182ms every
   single 30s cycle instead of converging once. Caught via `DEBUG_CASCADE=1`
   instrumentation.
3. **Sim-only bug**: synthetic DJ reference assumed "track started right
   now" while devices assumed 10s already elapsed — a baseline mismatch
   that made every DJ-vs-phone comparison look like a false ~12,500ms
   disagreement and get wrap-guarded away. Fixed by deriving the DJ
   reference from the same time-invariant `TRUE_PLAYBACK_START_MS` constant
   real devices use.

**Tried and removed: entry-phase bold bootstrap.** Motivated by "get
everything launching at the same time" — but found (honestly, not
papered over) that it can never fire as modeled: injected "true error"
only manifests in `refMs` gradually, via calibration reacting to `lagMs`,
not immediately in `currentTime`. At the true moment of arrival there's no
informative ref-comparable disagreement yet, regardless of mechanism. Real
answer: launch timing is already handled by the existing scheduled-entry
mechanism (`playback_started_at = play_at`); cascade consensus's job is the
*ongoing* correction after, not the launch instant itself. Confirmed the
handoff between them is already correct in the existing architecture — a
track change (including a scheduled launch) already triggers `enterBurst()`
in `layer.js` (self-exiting on convergence or timeout), and cascade
correction is gated `if (!isBurst)`, same as v3 — no new gate needed.
Removed the dead bold-entry code cleanly rather than leave a feature that
doesn't do anything.

**Ported for real into `ternary/layer.js`**: `computeOwnRefMs()`,
`pickCascadeAnchor()` (single highest-weight peer, NOT a median),
`maybeCascadeCorrect()` — wrap-guard (`CASCADE_WRAP_SANITY_MS`, mirrors
`TH_SEEK_SANITY`) and one-authority-full-yield (`_cascadeEngaged`,
permanent once true) both carried over from v3's hard-earned lessons.
`refMs` added to the existing `trit` broadcast (`broadcastPeerTrit`/
`receivePeerTrit`) — no new channel. `isCascadeEngaged()`/
`getCascadeAnchorId()` exposed on `window._terLayer`.
**`listener.html`**: `window._terAdjustClockOffset(deltaMs)` (mirrors
`_terAdjustLatency`), `measureClockOffset()` gains the second
one-authority gate. **NO DJ participation in this port** — deliberately
deferred, would need `bridge.mjs` changes (a different, riskier file).

**Re-validated against the REAL ported code**, not just the design
prototype — important catch along the way: my first re-run accidentally
kept the sim's own standalone `pickAnchor`/`maybeCascadeCorrect` running
*alongside* the newly-ported real `layer.js` internal logic, double-
correcting and invalidating that "ALL PASS." Rewrote the sim to exercise
only the real internal mechanism via `tick()`. Clean result: **3/3
phone-to-phone scenarios pass** (A: real-CSV-shape 3-device convergence;
B: 4 devices, no pre-existing flagship; D: one latency-capped broken device
correctly never chosen as anchor). `sync/sync-engine.test.js` 29/29
unaffected. `sync/greenhorn-sim.mjs`'s pre-existing 3 failures (flagged
last session, predates this work) unchanged — not made worse.

**Status: built, sim-validated against the real ported code, not yet
deployed.** Next: cast specifically on the deploy step, then a controlled
live test (just the two of us, explicitly not a live party), watched
closely, ready to revert immediately if anything looks wrong — same
posture as both v3 attempts.

## 2026-07-14 — master-rooted cascade: sim scenarios built, harness blind spot found

**Context:** bulletproof roadmap session (plan:
`~/.claude/plans/i-want-you-do-inherited-jellyfish.md`). User's cast on the
roadmap — **61.4.5→38** (Inner Truth, "the team horse goes astray" / "he
possesses truth which links together" → Opposition) — read as: phones must
orient to the MASTER, not each other; one truth-holder; two parallel
truth-powers = the thrice-lived two-authority failure. Roadmap Phase 1
became "root the cascade in the bridge (stratum-0)". Per that plan,
extended `sync/octonary-cascade-sim.mjs` with master scenarios BEFORE any
cast/port — harness work only, engine untouched.

**Added:** synthetic MASTER bus participant (models bridge.mjs broadcasting
on the trit channel: `octoState: ANCHORING`, `refMs` = true track-start,
`calSettled: true`); absolute-truth check (phones' refs vs the master's
truth — inexpressible in phone-only scenarios); scenario E (master at stock
weight 2.0 — zero layer.js changes needed), F (adversarial tie: confidently-
wrong phone inserted into `_peerTrits` first, so at equal weight it wins
`pickCascadeAnchor`'s strict-> tie-break), G (SIM-ONLY what-if of the
proposed 3.0 master weight, patched into the loaded source — on-disk code
untouched, real change still needs its own cast).

**Belief-level results:** E: 3/3 phones anchor to the master and the room
converges to ABSOLUTE truth (absErr 17ms), not merely to itself — at stock
weight 2.0, meaning a first live bridge experiment needs only bridge.mjs to
*broadcast* (no layer.js change at all). F/G: master chosen 3/3 even with
adversarial ordering.

**The real finding — harness blind spot (applies to ALL scenarios, incl.
A/B/D's historical passes and by extension the phone-only validation the
deployed cascade shipped on):** this harness has NO engine model — device
`currentTime` never seeks/warps in response to lag. Added a residual
readout (the corrector's input signal) and every scenario carries large
unresolved residual behind its perfect ref-spread (A: 1483ms, D: 4373ms,
F: 350ms). In sim terms: refs agreeing ≠ audio agreeing; the harness
validates **belief-consistency only**. Emitted as ⚠ WARN per scenario (not
FAIL — a hard fail would over-claim; the ported code isn't proven wrong,
the harness is proven incomplete). Corollary: in F, following the master
reopens lag that budget-spent calibration can't re-close, so no wrong phone
can ever re-earn ANCHORING — the adversarial tie never actually occurs, and
**the 2.0-vs-3.0 master-weight question is still OPEN**, answerable only
after the harness gets an engine-response model.

**Before the stratum-0 cast/port, in order:** (1) add an engine-response
model to the harness (ct seeks toward the device's own believed expected
position; residual WARN promoted to hard check measuring true audible
alignment), (2) re-run E/F/G — the weight question and the cal-budget
interaction (master-follow reopening lag after `_calCount` is spent — smells
like the anchor-clock plateau deadlock in new clothes; watch it explicitly)
are the two things that sim must answer, (3) then cast on the bridge.mjs
port. All engine changes still one-at-a-time per protocol.

## 2026-07-14 (cont.) — V2 engine-model harness: cascade signal/lever mismatch found

Built the engine-response model the previous entry named as the blocking
gap (`makeDeviceV2` in `sync/octonary-cascade-sim.mjs`): real ct that snaps
(≥500ms → own believed expected) and warps (15–500ms, ±2.5% cap) exactly
like fastDriftCorrect; belief clock `synced = wall + trueClockError +
clockOffset`; the REAL layer.js reads the REAL ct, so its computeOwnRefMs
is now honest. New metric: `posErrMs` = ct-domain position vs the true
schedule (what live CSV/hud actually measures). Scenarios H1–H3.

**The algebra first (hand-checkable):** for a drift-converged phone,
ct = (synced − S)/1000 − devLat/1000, so
`computeOwnRefMs = synced − (ct − devLat/1000)·1000 = S + 2·devLat` —
clock terms cancel COMPLETELY. Converged phones' refMs carries ONLY
latency-belief information (×2), and none of the clock error the cascade
was built to correct.

**H1 — the live symptom, exactly** (3 phones converged, devLat beliefs
[0,300,600], no clock error — "stable individually, 0.5-1s apart"):
**RUNAWAY.** Cascade fires every rate-limit window forever (108 corrections
/25min, one audible snap each), because corrections move clockOffset →
position → but refMs is invariant to clockOffset → the disagreement it acts
on NEVER closes. posSpread grew unboundedly (~2.4s/min, 63s by minute 24)
while refSpread oscillated 600–1200ms. Mechanism verified by hand: d0
corrects +600 toward d1 while d1 corrects −600 toward d0 — they swap and
re-fire forever.

**H2 — same room + master at 2.0: same runaway.** The master's truth refMs
gives sample = −2·devLat — real INFORMATION (it's the latency belief!) —
but the correction applies it to the CLOCK: right signal, wrong lever.
Master weight (2.0 vs 3.0) is MOOT until the lever is fixed.

**H3 — pure clock error [0,+400,−250], equal devLats — the designed-for
case: cascade fires ZERO corrections.** Converged phones' positions absorb
their clock error; refSpread = 0 while the room sits 650ms apart in real
position. The error the cascade was designed for is INVISIBLE to refMs
between converged phones. (It is exactly what LAN-first RTT symmetry fixes
at the root — roadmap Phase 4.)

**Why the Jul 15 live test looked clean anyway:** the one correction
observed was on a SNAP-LOCKED device (~1300-1400ms raw drift, never
converged) — for a non-converged phone, ct ≠ expected and refMs genuinely
carries its offset, so the correction was real and worked. The cascade
helps broken devices and fights/ignores converged ones. The runaway regime
needs ≥2 mutually-visible CONVERGED phones with ΔdevLat > 30ms (deadband/2)
— i.e., any normal healthy room — which the 2-3 device controlled test
never had (the broken device had weight 0 and no healthy pair existed).

**Deployed-code implication (cascade is LIVE on phones):** a healthy
multi-device room is predicted to enter a mutual correction/snap loop at
the ~30-40s cadence. Live signature to watch for: repeating `ter_cascade`
sync_events on byob_debug with near-constant correctionMs magnitudes
(~2×ΔdevLat), snapCount climbing in lockstep, refs/Room-Spread gauge NOT
improving. Candidate mitigations (each ONE change, cast first, in
preference order): (a) gate maybeCascadeCorrect on own drift-state being
broken/snap-locked — preserves the proven rescue behavior, disarms the
converged-room loop; (b) revert cascade from live until redesign; (c)
redesign the lever: master-sample corrects LATENCY (sample/2) with
auto-cal yield — bigger design, needs its own sim pass. Do NOT ship (c)
hastily — it makes devLat two-authority.

**Also check next session:** bridge.mjs `master_verdict` uses "the same
math" as refMs reconstruction — if it shares the −lat/1000 form, verdicts
carry the same 2·devLat bias vs converged listeners. Verify before
trusting verdicts for anything corrective.

**Harness caveats (honest):** no BT stall/floor physics yet (auto-cal had
nothing legitimate to chase in these runs — devLat stayed put, which is
WHY the refMs invariance is so clean here); no scheduled-entry phase; snap
threshold 500ms flat. None of these plausibly rescue the H1/H3 mechanism —
the algebra doesn't depend on them.

## 2026-07-14 (cont.) — LIVE: orbit confirmed, sign fix shipped mid-broadcast (daab95f)

**Controlled live test (user broadcasting, 3 phones: zu99i2/swflvr/6alag5,
watched via live-monitor + a focused cascade watcher on byob_ternary+
byob_debug).** The V2 harness's H1 prediction appeared live within minutes,
numerically:

- zu99i2 (lat 1200) fired −283, −260, −248, −421, +236 (five corrections,
  clockOffset accumulating to −1388ms); 6alag5 (lat ~1076) fired +161, +163
  BACK toward zu99i2 — mirror-image pairs; swflvr orbiting both (5 fires).
  All fired at drift 11–105ms — i.e., on CONVERGED phones.
- The room-table gap held at the predicted invariant: zu99i2−6alag5 refΔ
  248–312ms vs 2·Δlat = 248ms; swflvr−6alag5 ~204ms vs 2·Δlat = 202ms.
  Corrections could never close it; refSpread oscillated 131–854ms.
- Bonus finding for Phase 3 (entry): one track launch was RECEIVED 18s
  apart across the three phones (367s/382s/385s watcher clock) — launch
  propagation itself is staggered (hidden-tab throttling suspected), before
  any sync math runs.

**Cast on the fix: 61.3→44** (Inner Truth line 3 — "he finds a comrade;
now he beats the drum, now he stops" = the orbit described literally —
resolving to Coming to Meet: small thing with big influence, contain it).
Containment done before deploy: flipped-formula scenarios added to the V2
harness (zero corrections, zero snaps, refSpread 0 in the rooms that
unflipped produce 108 corrections/63s divergence) and refMs consumers
enumerated (layer.js cascade+trit broadcast: the fix site; overlay Room
Spread gauge inherits via broadcast, becomes honest; bridge master_verdict
is separate math — audit pending, flagged).

**Fix: `daab95f`** — computeOwnRefMs sign: `ts − (ct − lat/1000)·1000` →
`ts − (ct + lat/1000)·1000`, with a comment documenting the algebra.
User-confirmed ("go"), shipped mid-broadcast. Phone refresh required
(refresh also clears accumulated clockOffset garbage).

**Sim suite restructured against the fixed code (ALL PASS):** V2 scenarios
are authoritative — H1 (shipped formula: quiet, refSpread 0), H1b (bugged
pre-daab95f formula patched back in: MUST reproduce the orbit — regression
guard on the sign), H2 (master w2.0: quiet agreement), H3 (honest null:
clock error invisible to refMs, posSpread stays ~650ms — Phase 4/LAN
territory, and if this ever "converges" something new is moving clocks).
V1 belief-model scenarios (A–G) demoted to informational: no engine model,
superseded by V2; kept for their scenario shapes.

**Verification criteria post-refresh:** zero ter_cascade events between
converged phones; overlay Room Spread reading near-0 for healthy phones
(gauge is now honest); cascade fires still permitted on genuinely broken/
stale devices (true-offset rescue preserved). Watch a full track through.

**Post-fix open questions (cast before building):** (1) master/stratum-0
value proposition changed — with honest refMs, converged phones agree at
trackStart regardless of clock error, so the cascade (peer OR master) now
corrects only broken/stale devices; pure clock error stays invisible
(H3) and is LAN/Phase-4 work. Re-frame the bridge stratum-0 sub-step
accordingly. (2) bridge master_verdict sign audit. (3) The devLat-belief
spread that the orbit was falsely "seeing" is still REAL positional spread
(H1 posSpread 600ms) — the true fix for that is calibration truth
(acoustic referee / tap-cal / grounded prior), exactly as the roadmap has
it.

## 2026-07-14 — session close: post-fix steady state, relay blip, next targets

**Burst-clear shipped live (`4b9d9fc`, cast 11.1→46)** on the user's "ship
it" — `_cascadeSamples` cleared in `enterBurst()`; full sim suite ALL PASS
before push. Mid-session the relay process died (~3min outage, cause
unconfirmed — a second Claude instance was concurrently working on playlist
continuity in artist.html; bridge+tunnel never blinked). Restarted from
committed code, rows intact, phones auto-reconnected without reload
(same device IDs — NOTE: the shim's reconnect works when the relay URL is
unchanged; the stale-URL problem is only about tunnel-hostname rotation).

**Post-refresh steady state (fresh IDs on burst-clear code, final ~13min,
2 trit-visible phones):** 9 cascade corrections, −62 to −125ms, cadence
53–147s, and — the notable signature — **all negative from BOTH sides**
(each device pulling toward the other, downward), with room refSpread
breathing 5→150→8ms between fires. Only 6 track_changes in the stretch, so
these are NOT launch contamination: this is deadband-edge shepherding of
genuinely wandering hardware, plus a same-sign creep worth understanding.
Mutual sync stays good (that's why it sounded right) but both clockOffsets
walk downward together — common-mode, inaudible, yet unbounded over hours.

**Named next targets (cast before building):**
1. **Deadband hysteresis** — fire only past ~75–80ms (avg), correct back
   toward ~0: spaces out the minimum-size chatter that currently hovers at
   the 60ms edge every 1–3 minutes.
2. **Both-negative creep** — analyze why alternating anchors produce
   same-direction pulls on both devices; candidate guard: bound cumulative
   cascade |clockOffset| per session, or re-zero common mode against the
   bridge (natural stratum-0 job — folds into the master question).
3. Session ended with a 3.5s refSpread blip as a third device
   appeared/left at the last tick — entry/exit transients, Phase 3 world.

**Where this leaves the night:** `baseline-sync-jul14` tagged; sign fix +
burst-clear both live; the user's verdict mid-session: "sync is perfect,
never heard this before." The engine's remaining audible artifacts are now
small (≤125ms one-shot pulls, minutes apart) and all four named error
sources have owners on the roadmap.

## 2026-07-14 (late) — connection layer fixed end-to-end + named tunnel

"Zone relay connection constantly lost" diagnosed as four stacked failures,
all fixed (`350b805`): (1) relay killed by its own clients — ws socket
errors (ECONNRESET) had no handler and threw fatally; per-socket handlers +
process traps + 25s ping/pong keepalive added. (2) tunnel dies silently —
new bridge/watchdog.mjs supervises relay (15s) + tunnel end-to-end (60s),
respawn/rotate + republish automatically. (3) phones retried dead hostnames
forever — byob-shim.js now re-fetches /relay.json after 6 failed reconnects
and adopts a moved relay IN PLACE (no reload). (4) start.command process-
group coupling — bridge restarts no longer kill the backend.

Then quick tunnels failed SYSTEMATICALLY (three fresh hostnames, none
routed — CF free-tier degradation/rate-limit) → executed the named-tunnel
plan live: **relay.boombox.productions** (tunnel `byob`, CNAME via
`cloudflared tunnel route dns`, ingress → localhost:3100, `1c08a05`).
Verified end-to-end. Watchdog named mode: URL constant, rotation = respawn.
Closes the "Named Cloudflare Tunnel" open item.

Bridge zone-create mystery resolved in layers: half-transaction (deactivate
lands, insert doesn't) from a bridge process running since morning across
three relay restarts — bridge restart fixed the backend path (probe
create_zone via WS → 21ms success); remaining failures were the stale
browser page. Lesson for the runbook: after any relay restart, bounce the
bridge AND reload its page. Zone "Honest Signal" (723ad9b2, r=20km) active.

## 2026-07-14 (night) — the well gauge (casts 48 / 42.1.4→12 / 51.2.3→34)

User's idea: each phone weighs where it's at as a hexagram; the channel
carries a hexagram that categorizes it. Cast 48 (The Well) reframed it
precisely: the shared reference is the well — sound, central, unchanging —
and what differs per phone is its ACCESS: rope and jug. 42.1.4→12 gave the
architecture (deep foundation; a mediator that reports upward to the
console; resolved-state Standstill = the gauge NEVER acts — written
invariant). 51.2.3→34: it helps the way thunder helps — revelation met
with discipline, don't chase every lost treasure it shows.

Implementation (`8687bbc`, observe-only, additive telemetry lane):
- `layer.js deviceHexagram()` — lower trigram from lived access state,
  bottom-up: JUG (calibration settled), ROPE (clock steady — no cascade
  pull in 120s), WATER (currently trit-P). Upper trigram = octo role
  (ANCHORING=☰ … REACHING=☷). Moving lines = bits flipped within 120s.
  King Wen via verified 8×8 table. Broadcast as hexKw/hexLines/hexMoving
  on both the trit channel and hud_data. NOTHING reads it back — invariant
  in the code comment: "the well gauge observes; it never acts."
- `overlay.html` — per-device glyph badge (䷀–䷿, ✶ = moving lines); new
  "the well" panel: ROOM hexagram by per-line majority across playing
  devices, lines where the room disagrees rendered as contested/moving.
- Found & fixed while there: overlay's own `computeRefMs` still used the
  pre-daab95f minus form — the Room Spread gauge had been measuring the
  retired formula since the sign fix. Now matched.
- Discovered: the `_calSeq` octonary trigram documented in SYNC_ENGINE.md
  Step 7 is RETIRED from the code (doc-only survivor of an old design) —
  Step 7 needs a doc pass next session.
- Emergent semantics, verified in the math: perfect device = 1 Creative;
  lost device = 2 Receptive; uncalibrated-but-flowing mid-listen = 48 The
  Well itself; and a device with broken access wearing an ANCHORING face —
  the confident liar — reads 12 Standstill. The gauge names untrustworthy
  confidence with its own invariant hexagram.

Live during the build: rrqkto↔mrviaw trading small mutual pulls
(−63..−120ms, 1-4min cadence, both-negative) — the named creep target,
unchanged, next session's first analysis. Verify the gauge live: refresh
phones + overlay, expect glyphs per card and a room hexagram that reads
Creative-adjacent when the room is truly settled.

## 2026-07-15 early — the both-negative creep DIAGNOSED: warp breaks refMs time-invariance

Live trigger: two fresh-generation phones fired simultaneous mutual
negative pulls (−81/−71) — impossible for a true static gap. CSV analysis
(byob-obs-2026-07-15T02-01-40, playing-segment-only refMs slopes): mrviaw
−753 ms/min sustained, rrqkto −800 in stretches, 6opr0z flat. −13..−15 ms/s
= (playbackRate−1)×1000 at ~+1.4% warp: **computeOwnRefMs assumes ct
advances 1:1; under sustained warp it doesn't, so a warping phone's refMs
SLIDES at the warp rate** — not time-invariant, the design's core
assumption broken exactly while the corrector is busiest. The cascade
reads the slide as real disagreement (14ms/s × 40s window ≫ deadband),
pulls, warp continues, gap re-opens → the endless same-sign mutual creep
observed across three device generations tonight. Whole-span slopes also
showed +1000ms/s segments = idle/paused rows (ct frozen) polluting
naive fits — always slope playing-segments only.

**Fix candidate for next session (cast first): warp-gate cascade sampling**
— in maybeCascadeCorrect, skip the sample when |playbackRate − 1| > ~0.003
(and consider the same gate on the refMs broadcast, or send rate so peers
can judge). Only compare references from phones whose reconstruction
assumption holds. Sim first in the V2 harness (add a perpetual-warp
device). Secondary finding: mrviaw warped continuously ~25min (Class-C
restlessness lives) — the gate also stops such devices from feeding
everyone else's clockOffset.

Baseline CSV (01:35–02:01, pre-guileless-clock generation): drift p50
~80ms, p95 180–350ms, latencies pinned stable at 1200 all hour (ratchet
dead), heavy threshold-crossing counts. A/B against the post-clock-fix
generation pending next export.

**Marker caveat (2026-07-15 ~02:2x):** the ✅ Synced ground-truth marker
stamped during this live session (~row 700 of the next overlay CSV export)
was ACCIDENTAL — 2-phone room only, not a verified full-sync moment.
Disregard it when correlating markers against calibration/cascade events.

## 2026-07-15 ~02:20 — guileless-clock A/B: inconclusive; flagship-warp confirmed 3rd time

Export byob-obs-2026-07-15T02-17-49 (9.5min, 3 devices, churn-heavy: one
rejoin + one join + track changes) vs the 01:35–02:01 baseline: drift p50
WORSE (101–185 vs 79–91ms) but p95 tail tighter (189–222 vs 181–349ms).
Too short + too churned to grade the clock fix — needs a calm 20min+
stretch. Real findings: (1) the FLAGSHIP f4zzg4 warped continuously
(refSlope −317ms/min ≈ +0.5%) — the room's anchor was feeding sliding
references downstream; third independent confirmation that the warp-gate
must cover ANCHOR selection, not just own sampling. (2) c0tzzz held a
constant 185ms floor (p50≈p95) with cal budget spent — refills next track.
(3) hexKw/hexLines/hexMoving missing from CSV exports — overlay REC_COLS
needs the three columns (queue with warp-gate work). Accidental SYNCED
marker = rows 604–608 of this export.

## 2026-07-15 — WARP-GATE SHIPPED (cast 8→55 lines 1·3·4·5): creep mechanism
measured exactly, gated at both ends; X4 finds a gate-neutral cascade limit

Session goal declared by the user: play jungle/DnB — tightness target
≤20–35ms sustained (a 16th at 172BPM is ~87ms) + entries that land clean.

**Evidence pass (read-only, both recent exports, playing-pairs only):**
d(refMs)/dt during warped pairs = −14.9 ms/s vs −(rate−1)·1000 predicted
−15.0, on EVERY device in both exports; calm pairs 0.0 ms/s. The Jul-15
"warp breaks refMs time-invariance" diagnosis is now measurement, to
~0.1ms/s. Warp duty: mrviaw 70%, f4zzg4 63%, rrqkto 37%, c0tzzz 30%,
6opr0z 6%, 1kv6s1 1%. One 10s check interval at 15ms/s = 150ms phantom =
2.5× the deadband — most 40s windows on a restless device held poisoned
samples. f4zzg4's flagship mystery fully explained by duty-cycled +1.5%
corrective warp (rate 1.015 rows throughout); no BPM-warp involvement.

**Cast:** 8 Holding Together → 55 Abundance, moving 1·3·4·5. Line 3 names
the bug ("you hold together with the wrong people"); line 1 = the sincerity
gate on own samples; line 4 = the outward gate (broadcast null); line 5 =
exclusion without coercion — no staleness compensation, no peer rate-judging,
gate only excludes. User approved via plan.

**Sim (X scenarios, `octonary-cascade-sim.mjs`, committed first):** V2 model
gains `stallStealSPerTick` (Class-C restlessness: ct loses real time, catch-up
warp chases; standing deficit ≈ steal-rate/0.0002·1000) + `wedgeSeekBroken`/
`wedgeOffsetS` (same-track-relaunch wedge) + `refErrorMs` (stale row belief)
+ per-device refMs-null broadcast counters. ensureGated/ensureUngated
string-patchers keep scenarios valid regardless of whether layer.js carries
the gate (X1 = permanent creep-reproduction guard, H1b's sibling).
- X1 UNGATED stall room (steal 0.0375/0.025/clean): 38 false fires on
  zero-clock-error devices, walk −2753ms, maxPosSpread 2633ms against the
  clean witness — the live creep, reproduced with its signature.
- X2 GATED identical room: 0 corrections, warper broadcasts 100% refMs:null
  (anchor-side cover proven), spread bounded at the 97ms physical deficit.
- X3 GATED wedge (seeks no-op, −800ms): exactly 1 correction, snap-thrash
  ends, refs agree; posErr honestly stays −800 (physics can't move — that's
  the relaunch fix's job). Offline twin of the first live rescue.
- **X4 (NEW LIMIT FOUND, gate-neutral, fires at rate 1):** stale
  playback_started_at + WORKING seeks = the cascade ORBITS — every pull is
  re-absorbed by re-convergence to the stale row, refMs returns to the same
  wrong value, physical position walks −800ms/cycle (14 fires, −12s in
  10min, identical gated and ungated). Cascade corrections CANNOT close
  persistent reference divergence; row-repair + anchor-scoping (9718f40) +
  bridge follow-the-row are LOAD-BEARING for the cascade era. Guard checks
  fail loud if this ever "goes quiet."

**Change (ternary/layer.js, one mechanism):** `CASCADE_WARP_RATE_GATE=0.003`;
`cascadeWarpGated()` compares `_audio.playbackRate` against
`SpatialRouting.getBpmWarpRate() ?? 1` (BPM warp = legitimate base);
`maybeCascadeCorrect` skips sampling while gated; `broadcastPeerTrit` sends
`refMs: null` while gated (pickCascadeAnchor's existing null-skip drops
warping devices from anchor eligibility — zero peer-side logic). Side
benefit by construction: post-correction warp chases can't re-sample their
own transient. Full suite ALL PASS against the real gated source; greenhorn-
sim still exactly its 3 pre-existing failures (stash-verified unchanged);
sync-engine.test.js 29/29. SYNC_ENGINE.md gains the cascade+gate section.
Overlay REC_COLS now exports hexKw/hexLines/hexMoving (queued item closed).

**Expected live signature:** steady-state cascade pulls collapse from
−62..−125ms every 1–3min to rare one-shots; converged-device clockOffsets
stop walking; rescues unaffected. Known display caveat: overlay Room Spread
still shows sliding refs for warping devices (observe-only, honest); a
future polish could gray warped rows. Live window = tonight's broadcast,
bounded, revert-fast; calm 20min+ stretch doubles as the pending
guileless-clock A/B vs the 01:35–02:01 baseline.

## 2026-07-15 ~12:47 — baseline-sync-jul15 (`d32faec`): THE STABLE ROOM,
marked by the user mid-session ("most stable it's ever been, rough entry")

The user ran a broadcast on pre-gate code while the gate was being built.
Export byob-obs-2026-07-15T12-46-54-201Z.csv (8.4min, 4 settled phones +
2 transient joiners, THREE deliberate SYNCED ground-truth markers at
12:42:14 / 12:43:10 / 12:45:16 — 4-phone room, unlike the accidental 2-phone
marker of 02:2x):
- **Settled phones:** |drift| p50 54–85ms, p95 71–122ms (2c4eua p95 71ms!),
  warp duty 0–3%. All six devices cap-pinned lat=1200 — the accidental-
  equalizer regime (standing note: don't "fix" naively).
- **Room refMs spread p50 33ms / p95 53ms**, pinned flat at 33–34ms for the
  final 90s. First time the DnB tightness band (≤20–35ms) shows up as a
  sustained digital p50.
- **Guileless-clock A/B: PASS.** vs the 01:35–02:01 pre-fix baseline (p50
  79–91 / p95 181–349ms): the calm-stretch comparison the fix was waiting
  for. p95 tail collapse 181–349 → 71–122ms. (Caveats: different daypart +
  device mix; magnitude convincing anyway.)
- **The rough entry, quantified (thread B evidence #1):** the 12:39 launch
  event cluster reached devices staggered over **34 seconds** (12:39:14 →
  :26 → :29 → :37 → :48) while the 12:42:26 and 12:46:50 clusters landed on
  all phones within ~1s. Both late joiners never settled (su8kup: p50 161ms,
  p95 2605ms, 61% warp duty; mc9oh5: 44s off, then gone). Propagation before
  math — consistent with the 18s-stale-tab evidence from the launch era.
  Note: overlay `event` rows carry no event-kind column (REC_COLS drops the
  payload specifics) — worth adding `note`-style detail for events so launch
  forensics don't need inference.
Tagged `baseline-sync-jul15` at `d32faec` (the code those phones ran — the
gate shipped after their last refresh). New regression floor: post-gate
sessions must beat THIS room, not jul14. Phones refreshed onto gated code
right after this export — gate live-verification follows.
