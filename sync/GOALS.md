# Sync Engine — Active Goals

Working notes from the 2026-06-29 live tuning session (4-9 real devices,
PROP_GAIN=0.00040, MAX_WARP=0.040, nudge tier @ NUDGE_GAIN=0.00010 — see
TUNING_LOG.md step 4). These are the concrete next targets, in priority order.

## Device classes observed tonight

| Class | Stall magnitude | Recurrence | Devices seen |
|---|---|---|---|
| A (light)        | ~0-20ms    | rare        | — |
| B (moderate)      | ~60-110ms  | ~6-10s      | cionsr, l16mit, sbx0y0, oa79v0, 6h6plh |
| C (heavy/fast)    | ~60-110ms  | ~3-4s       | rt9jjg, h7fuax, v7mgrc |
| Sleep/wake        | 1000-4800ms| sporadic    | 6h6plh, oa79v0 |

Class B and Class C have similar stall *magnitude* — the difference is purely
*recurrence speed*. Class C re-stalls faster than the engine can close the
gap and settle, so it never holds CONVERGED for more than ~1 tick even with
the nudge tier (step 4) — same root cause as the original leapfrog, just on
a faster clock.

## Goal 1 — Cap peak drift
No device should exceed ~150-200ms at any point, even mid-cascade.
**Status: met.** MAX_WARP=0.040 is already containing the ceiling for both
B and C class devices.

## Goal 2 — Hold time in CONVERGED
Once a device reaches <10ms, it should hold there for multiple ticks, not
just touch and bounce.
**Status: met for Class B** (nudge tier, step 4). **Not met for Class C** —
rt9jjg/h7fuax/v7mgrc touch CONVERGED for ~1 tick before the next stall lands.

## Goal 3 — Predictive correction for Class C (fast-cadence) devices
Instead of reacting after a stall lands, detect each device's stall period
(it appears consistent per-device — e.g. rt9jjg ~3-4s) and widen the
correction window or pre-emptively apply a stronger correction just before
the next expected stall, rather than waiting for drift to climb past
threshold first.
**Status: not started.** Needs real cadence measurements (timestamps
already in sync/monitor-logs/ and the live stream) before designing —
don't guess the interval, measure it per device.
**Requires oracle cast before implementation** (touches engine correction
timing logic).

## Goal 4 — Eliminate multi-second sleep/backgrounding stalls
6h6plh and oa79v0 both hit 1000-4800ms "stalls" — not BT hardware stalls,
almost certainly tab backgrounding/sleep. Currently these wait out the
normal ~1.5s drift-check tick cycle to resync, which can take several
ticks to fully recover.
**Proposed fix:** add a `visibilitychange` listener — on regaining
visibility, force an immediate drift check + correction instead of waiting
for the next scheduled tick.
**Status: not started.** Self-contained, lower risk than Goal 3 — good
candidate to do first.
**Requires oracle cast before implementation** (touches engine correction
trigger path).

## Suggested order
1. Goal 4 (contained, low risk, clear win)
2. Goal 3 (bigger lift — measure cadence first, then design, then cast, then implement)
