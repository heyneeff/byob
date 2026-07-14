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
