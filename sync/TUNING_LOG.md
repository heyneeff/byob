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
