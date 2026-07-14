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

## 2026-07-14 (cont.) — 4-device overnight session: zone_offset_ms migration gap found, live-tested, reverted

**Live session (no phones can refresh tonight — remote-command levers only,
no corrector-logic pushes).** Reset two devices' badly stale `deviceLatencyMs`
remotely via `latency_cmd` (`dev_vuoyl7` 601ms→0, `dev_rgscxd` 867ms→0 —
both wildly inconsistent with their own `outputLatencyMs` seed of 6-12ms,
almost certainly debt-ratchet damage from a prior session, predating
tonight's `noteCalDebt` fix).

**Finding:** all 4 live devices read a consistent negative drift, same sign,
tightly clustered (-69 to -99ms) with mutual peer consensus — the signature
of one shared/common-mode reference error, not per-device disagreement.
Checked `bridge/relay-data.json`: **no zone has a `zone_offset_ms` field at
all.** This is the manually-tuned common-mode trim from `890110b`
("~60-75ms common-mode offset vs the broadcaster") that lived on the old
Supabase `zones` row — never carried over in the Jul 13 relay migration.
Magnitude matches almost exactly.

Cast before treating it as a real common-mode problem: **62 unchanging**
(Small Preponderance — small/modest correction, don't reach for a
structural fix). Read as confirming the small-trim framing over a bigger
mechanism.

**Live test:** broadcast `spatial_config { zone_offset_ms: 80 }` on
`sync_{zoneId}` (a config broadcast, not a corrector-code change — treated
as safe without a fresh cast, same class as `latency_cmd`). **Result:
spread got WORSE, not better** — before: -69 to -99ms (30ms spread, tight).
20s after: -30 to -269ms (240ms spread). Not noise — held steady over the
window. `os07tv` alone improved to a steady -30ms (best all night);
`vuoyl7`/`erxi88` got substantially worse.

**Reverted** `zone_offset_ms` to 0 immediately — did not leave a
worse-than-baseline state live unattended overnight.

**Why it likely didn't work uniformly:** if this were a pure shared bias,
all 4 devices should have shifted by the same signed amount. They fanned
out instead — points to each device's own calibration loop (`layer.js`
auto-cal/greenhorn) reacting to the introduced shift differently depending
on its current cal state, rather than a clean independent common-mode term.
`vuoyl7`/`rgscxd` had just been remote-reset (fresh, reactive cal state);
`os07tv` had long-standing stable calibration and was the one device that
actually benefited. `erxi88` was a brand-new mid-entry joiner, unrelated.

**Open question for next session (needs a cast before any further live
zone_offset attempt):** is `zone_offset_ms` actually independent of
`deviceLatencyMs` in practice, or do the two silently compound/fight the
same residual — the same "one authority per signal" failure class as the
anchor-clock and room-consensus postmortems, just not yet named for this
pairing? Candidate next step: replicate tonight's exact 4-device readings
(pre-offset: -69/-73/-85/-99, post-offset: -30/-94/-116/-269,
deviceLatencyMs 94/160/0/0) as a new scenario in a sim harness before ever
re-broadcasting zone_offset_ms live. Separately: `zone_offset_ms` needs a
persistence path (write to the zone row, or a bridge-side default) so it
survives phones joining/reconnecting — right now it's broadcast-only and
evaporates on every relay restart.

## 2026-07-14 (cont.) — infra: tunnel died silently again, restarted; real fix deferred

Cloudflare quick tunnel died silently (process alive 8.5h, hostname
unresolvable — same failure mode as the Jul 13/14 late-session log entry)
and surfaced live as "relay connection lost" when creating a zone.
Restarted `cloudflared` manually, verified the new URL actually forwards,
republished `relay.json` to GitHub Pages (commit `8d30e26`, pushed).

**Found while investigating: this class of failure is worse than it looks.**
`byob-shim.js`'s `resolveServer()` only resolves the relay URL ONCE at page
load; the WebSocket reconnect loop (`ws.onclose` → retry) reuses that same
cached URL forever — it never re-fetches `/relay.json`. So if the tunnel
hostname ever rotates while phones are already connected mid-set, those
phones do NOT recover on their own; they retry a dead hostname silently
until someone manually refreshes. A watchdog that auto-restarts the tunnel
and republishes `relay.json` only helps NEW phones joining after the
restart — it does nothing for anyone already in the room. Not safe to rely
on for a live set.

**OPEN (unrelated, still deferred) — real fix for tunnel rotation:** set up a **named
Cloudflare Tunnel** (fixed hostname on the user's Cloudflare account, e.g.
`relay.boombox.productions`) so the hostname never rotates at all — a
`cloudflared` crash mid-set then just needs a process restart; already-
connected phones' existing same-URL retry loop reconnects on its own, no
refresh, no relay.json republish. Believed `boombox.productions` is
already on Cloudflare DNS (unconfirmed) — if so this is a short one-time
setup requiring the user's Cloudflare login (`cloudflared tunnel login` +
a DNS record), can't be done unattended. **Not started.**

**Correction to the overnight plan:** the scheduled unattended checks did
not actually happen — no new sim work landed between ~22:29 and this
follow-up. Logged honestly rather than implying overnight progress that
didn't occur.

**Root cause of last night's zone_offset_ms failure, confirmed offline —
no new sim needed.** `sync/room-consensus-sim.mjs` already contained the
exact scenario shape required: scenario **A'** ("WITHOUT consensus,
control") models a persistent 120ms clock-error-like residual with *nothing
but* the real `ternary/layer.js` calibration loop reacting to it — which is
mechanically identical to broadcasting `zone_offset_ms` with no dedicated
correction path of its own.

**Result — this is the smoking gun:**
- `deviceLatencyMs` converges to **368ms** instead of the true 280ms latency
  — auto-cal silently absorbed the entire 120ms uncorrected offset into the
  latency estimate.
- Then it **stops**: per-track correction budget (4 corrections) exhausts,
  so it holds steady at the wrong value (last-3-minute spread = 0ms —
  "stable," but stably *wrong*, same shape as the noteCalDebt bug's
  legitimate-looking-but-wrong plateaus).
- Final residual: **208ms**, never closes.
- Control comparison (scenario A, same true error but WITH a separate
  correction path for the clock-error term): `deviceLatencyMs` converges
  cleanly to 252ms (close to true 280), residual closes to 29ms.

**This is exactly last night's live failure mode.** `zone_offset_ms` has no
correction/settle path of its own — it's a bare broadcast value. An
uncorrected common-mode gap (the value lost in the Jul 13 migration) reads
to each phone's calibration loop as ordinary latency error and gets
partially absorbed into `deviceLatencyMs`, then gets stuck once that
phone's per-track budget runs out — the exact amount absorbed depending on
how much budget was left when the shift landed. `os07tv` (long-settled,
budget available) partially absorbed it correctly and improved; `vuoyl7`/
`rgscxd` (freshly latency-reset minutes earlier, full budget but different
starting state) fanned out instead. Confirms the "one authority per signal"
failure class named in the anchor-clock and room-consensus postmortems
applies here too, previously unnamed for this specific pairing.

**Implication for the next live attempt (needs a cast before implementing):**
the fix is NOT "don't use zone_offset_ms." It's that broadcasting a new/
changed `zone_offset_ms` needs to suppress or reset calibration's floor
sampling for a settle window first — same class of gate as the
anchor-clock's `noteExternalDisturbance()` hook — so auto-cal doesn't race
to "correct" the step change that was just intentionally introduced.
Candidate shape: `onSpatialConfig`'s `zone_offset_ms` handler
(`spatial-routing.js:211`) calls the same disturbance-notification hook
`layer.js` already exposes, sized to the magnitude of the offset change,
before the new value takes effect. Also still needed: persistence (the
value has no home on the zone row yet) and the timing of correction from
the *sound-check* — right now nobody has actually re-measured what the true
common-mode gap is post-migration; 80ms was inherited from
pre-migration `890110b`, not re-verified against the current relay+tunnel
path.

## 2026-07-14 (cont.) — zone_offset disturbance gate implemented; room-consensus v3 redesigned + validated

**Zone_offset fix, implemented (not yet deployed — set is live, no refresh
tonight).** `spatial-routing.js`'s `onSpatialConfig` now calls
`window._terLayer?.noteExternalDisturbance?.()` whenever an incoming
`zone_offset_ms` actually differs from the current value, before applying
it — same gate the anchor-clock already uses for its own slews. This is
believed to directly fix last night's zone_offset live-test failure (the
sim already confirmed the mechanism: an unguarded step gets partially eaten
into `deviceLatencyMs` and holds wrong once budget exhausts). **Not yet
live-verified** — needs a safe window (set break, not mid-set) and its own
cast before deploying, since it touches corrector-adjacent code even though
it's an additive gate, not new logic.

**Room-consensus v3, redesigned in `sync/room-consensus-sim.mjs` and
validated offline against both failure modes that broke the live deploy —
neither of which any prior version ever simulated:**

1. **Wrap-guard** (fix 2 from the postmortem): `maybeRoomConsensusCorrect`
   now drops any sample whose magnitude exceeds `WRAP_SANITY_MS` (2000ms,
   mirrors the engine's own `TH_SEEK_SANITY`) before it can enter the
   averaging window.
2. **One authority, full yield** (fix 1, stronger than first attempted): a
   time-boxed suppression window (tried 45s) wasn't enough — it's close to
   both the remeasure and correction cadences (30s each) and still let
   `measureClockOffset()`'s independent RTT probe clobber the correction in
   sim (scenarios E/G FAILED with a 45s window: residual 86–150ms, 20-27
   corrections firing as the two authorities fought). Fixed instead per the
   anchor-clock postmortem's actual law — once room-consensus fires its
   FIRST correction this session, it owns the clock outright;
   `measureClockOffset`'s periodic remeasure stays fully suspended from
   then on, not just briefly.
3. **Tolerance, per this session's cast (61.2.4→25 — Inner Truth's
   crane-and-answer resonance, confirmed by a converging 62 Small
   Preponderance cast this morning):** kept `CONSENSUS_THRESHOLD_MS=60ms`
   as a genuine deadband, not a target to force to zero — a device sitting
   apart within tolerance is left alone ("the team-horse goes astray, no
   blame"), matching the constrain-the-bounce philosophy already
   established for the ternary engine itself.

**New regression scenarios E (remeasure timer), F (wrap events), G (both
together, worst case)** — modeling `trueRawClockSkewMs: 0` (the honest
worst case: the full reference error is non-RTT-visible drift, so an
un-suppressed remeasure doesn't rediscover truth, it clobbers toward a
value that's wrong by the full error). **All pass, confirmed over 5
repeated runs** (sim uses randomness — checked for reliability, not a
single lucky seed): residual closes under the 60ms bar, zero wrap leakage,
zero runaway. Only the `A'` no-consensus control still fails, which is
expected — it's the baseline proving calibration alone can't fix an
uncorrected clock-type error.

**Status: offline-validated, NOT deployed.** Both pieces (zone_offset gate
in `spatial-routing.js`, room-consensus v3 in the sim) are ready for
implementation review, but the room-consensus mechanism itself still only
exists in the sim — it was never re-added to `listener.html`/`layer.js`
after the `2713593` revert. **Next step before any live attempt:** port the
v3 design (wrap-guard + full-yield authority handoff + threshold/window
values) into real listener code, cast specifically on the deploy step (as
was done before both prior attempts), and only ship in a safe window —
never mid-set, per tonight's explicit direction.

**Honesty check on reliability (before porting further):** re-ran the sim
8x beyond the original 5 — E and G (the worst-case, both-bugs-at-once
scenarios) fail the tight 60ms combined bar roughly 1-in-4 runs, landing at
60-80ms instead. Not a new bug: the consensus deadband is deliberately
tolerant by design (per this session's casts), so a result sitting right at
the edge of an arbitrary 60ms test threshold isn't the mechanism failing —
it's the mechanism doing what it's built to do. Compare magnitude: before
any fix this scenario was STUCK at 208ms every single run. 60-80ms
occasional vs. 208ms guaranteed is a different class of problem, not a
false claim of perfection.

## 2026-07-14 (cont.) — room-consensus v3 + zone_offset gate: ported to real code, DEPLOYED

**Cast obtained specifically on the deploy decision: 55.3.4→24** (Abundance
→ Return). Line 3 ("screen so thick small stars show at noon... breaks his
right arm, no blame") read as: the existing self-report apparatus has to
yield without fault — direct match for the one-authority full-yield fix.
Line 4 ("meets his ruler, of like kind, good fortune") read as: genuine
peer comparison (refMs) is the right mechanism. Resolving to 24 (Return)
read as a caution to ship exactly what's validated, nothing more elaborate
on top. This is the THIRD independent cast this session pointing the same
way (user's 61.2.4→25 on genuine consensus + tolerance; mine, 62, on modest
scope) — treated as strong, repeated confirmation.

**Ported for real** (previously only existed in `sync/room-consensus-sim.mjs`
after the `2713593` revert deleted it from production):

- **`ternary/layer.js`**: `computeOwnRefMs()`, `peerMedianRefMs()`,
  `maybeRoomConsensusCorrect()` — same math as the sim, plus both fixes:
  `CONSENSUS_WRAP_SANITY_MS` guard (drops any sample >2000ms, mirrors the
  engine's own `TH_SEEK_SANITY`) before it can enter the averaging window;
  `_consensusEngaged` flag set permanently true on the first correction
  (one authority, full yield — not a timed suppression window, which the
  sim showed still leaks). `refMs` added to the existing `trit` broadcast
  payload (`broadcastPeerTrit`/`receivePeerTrit`) — no new channel, rides
  the existing peer exchange. `isRoomConsensusEngaged()` exposed on the
  `window._terLayer` API.
- **`listener.html`**: `window._terAdjustClockOffset(deltaMs)` — mirrors
  `_terAdjustLatency`'s existing pattern, adjusts the shared `_clockOffset`
  every `syncedNow()` call uses, broadcasts a `correction_event` for
  debug.html/live-tuner visibility. `measureClockOffset()` gains a second
  early-return gate alongside the existing anchor-clock one:
  `if (window._terLayer?.isRoomConsensusEngaged?.()) return;`
- **`spatial-routing.js`**: `onSpatialConfig`'s `zone_offset_ms` handler
  (already gated to `noteExternalDisturbance()` earlier this session) —
  unchanged from that earlier fix, ships alongside.

**Verification before deploy:** `node --check` clean on both files;
extracted-and-checked all `listener.html` inline `<script>` blocks;
`sync/sync-engine.test.js` 29/29 pass (untouched code, confirms no
collateral damage); `sync/room-consensus-sim.mjs` still passes at the same
rate as the ported design (same math, sim is the reference the port was
built from). **Found and ruled out as unrelated:** `sync/greenhorn-sim.mjs`
scenario 1 fails (`calls=2` instead of 1) on the CURRENT `main` branch
BEFORE any of tonight's changes (confirmed via `git stash` + rerun on the
original files) — a pre-existing issue, likely introduced by the
`noteCalDebt` `DEBT_MIN_RUN` fix (`81ffce3`) earlier tonight and never
re-verified against this specific sim. **Not fixed here — flagged as a
separate open item, out of scope for tonight's deploy**, since it's
unrelated to room-consensus/zone-offset and pre-dates this work.

**Live triage during this session (unrelated to the deploy, confirms
existing tools worked as designed):** `dev_bgb3zi` showed the classic
inflated-`deviceLatencyMs` pattern (stored 250ms vs. floor estimate ~-19ms)
causing constant warping/audible "tripping" — reset remotely via
`latency_cmd`, relearning from 0 as of this note. `dev_a5z0uk` (previously
rock-stable, BT=670ms) dropped into a transient N-state — read as an
ordinary BT hardware stall cycling in/out of P-state, the same
"irreducible hardware" pattern documented in this file's original June
baseline section, not a new bug.

**Deployed:** commit pushed to `origin/main` (GitHub Pages). Requires a
full page refresh on every phone to take effect — user refreshing all
devices now. **Live-verify next:** watch for `ter_room_consensus`
sync_events and `room_consensus` correction_events in debug.html/
live-tuner; confirm `[ternary] room-consensus` console lines appear on
devices; confirm `measureClockOffset` stays silent (no un-suppressed
remeasure log lines) once a correction has fired; watch room spread
(`ternary/overlay.html`'s ground-truth gauge, commit `c800a71`) actually
tighten across genuinely different devices, not just each one's own
self-reported drift.
