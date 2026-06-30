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

---

# Octonary Participation Layer — Benchmarks

Added 2026-06-30. The octonary layer is live (Phase 5, commit 2d3631c) but has not yet
been observed or tuned. These benchmarks define what "healthy" looks like so we have
something to measure against in the overlay's ROLES tab and CSV export.

## What the layer does right now

| Mechanism | Status |
|---|---|
| Classifies each device into 1 of 8 roles per tick | ✓ live |
| Broadcasts `octoState` with each peer trit | ✓ live |
| `isGlobalDisruption()` — suppresses COMPOUND_GAIN when ≥50% peers PUSHING/REACHING | ✓ live |
| `weightedConsensus()` — OCTO_WEIGHT[role] average across live peers | ✓ computed, **not yet wired into corrector** |
| `findAnchor()` — identifies most stable peer | ✓ computed, **not yet used to orient correction** |

The weighted consensus score exists and is available on `window._terLayer` but nothing
in the engine reads it to modulate gain. That is the primary tuning gap.

## Role definitions and weights

| # | Role | Trigger | Weight | Meaning |
|---|---|---|---|---|
| 0 | ANCHORING | P ≥5 ticks | 2.0 | Trusted field reference — other devices should orient toward this |
| 1 | HOLDING   | P <5 ticks  | 1.5 | Recently settled — stable but not yet proven |
| 2 | PULLING   | Z-state     | 1.0 | Negotiating — pulling toward sync |
| 3 | FOLLOWING | Z + anchor visible | 0.8 | Oriented — knows where it's going |
| 4 | PUSHING   | N-state stall | 0.5 | Recovering from stall — contributing some field weight |
| 5 | LISTENING | post-seek settle | 0.3 | Just seeked — recovering, low weight |
| 6 | RESETTING | auto-cal fired <10s ago | 0.5 | Recalibrating — temporarily unreliable |
| 7 | REACHING  | ≥300ms drift | 0.0 | Excluded — too far out, not contributing to field |

## Target benchmarks — healthy room (6+ devices, ≥2 min steady state)

### Role distribution (% of device-ticks)

| Metric | Target | Concerning | Critical |
|---|---|---|---|
| ANCHORING + HOLDING (0+1) | ≥ 50% | 30–50% | < 30% |
| PULLING + FOLLOWING (2+3) | ≤ 35% | — | — |
| PUSHING + RESETTING (4+6) | ≤ 20% | — | — |
| REACHING alone (7) | ≤ 5% | 5–15% | > 15% |
| Roles visible in overlay: ROLES tab, also exported in CSV as `terOctoState` |

### Anchor stability
- At least 1 ANCHORING device present for ≥ 80% of all ticks
- Anchor identity (which device is ANCHORING) should not flip more than once per 60s
- Two devices ANCHORING simultaneously is fine and healthy — they will naturally stay in sync

### Convergence path timing (from stall to stable)

| Path | Target | Acceptable | Notes |
|---|---|---|---|
| REACHING → HOLDING | < 90s | < 120s | ≥300ms to <10ms — one seek + correction |
| PUSHING → HOLDING | < 30s | < 60s | N→P via warp after typical Class B stall |
| FOLLOWING → ANCHORING | < 60s | < 90s | Z-state with anchor visible → converge + hold |
| Fresh join → HOLDING | < 60s | < 90s | From first HUD packet to first stable P-tick |

### Weighted consensus score targets
`window._terLayer.weightedConsensus()` returns a float. Healthy ranges:

| Score | Meaning |
|---|---|
| ≥ 1.5 | Most peers HOLDING or better — room stable |
| 1.0–1.5 | Mix of PULLING/FOLLOWING — room converging |
| 0.5–1.0 | Many devices PUSHING — room recovering from stall |
| < 0.5 | Widespread instability or REACHING — room disrupted |

**Goal: weighted consensus ≥ 1.0 for ≥ 70% of ticks in a live session.**

### Global disruption rate
`isGlobalDisruption()` is true when ≥50% of live peers are PUSHING or REACHING.
- **Target: < 10% of all ticks** trigger global disruption
- When it triggers, all devices should return to PUSHING or better within 30s
- Currently: suppresses COMPOUND_GAIN during the event. Future: could also trigger a
  coordinated hold (pause corrections) to let BT buffers drain before re-correcting

## Tuning gaps (require oracle cast before touching)

### Gap 1 — Wire weighted consensus into corrector gain
Currently `weightedConsensus()` is computed but ignored. The corrector uses a fixed
PROP_GAIN regardless of field coherence. Proposal: scale PROP_GAIN by consensus score
(e.g. `PROP_GAIN × (1 + 0.5 × normalizedConsensus)`) so correction is stronger when
the room is coherent (high-weight peers confirm the direction) and gentler when
disrupted. **Requires oracle cast. Touches engine core.**

### Gap 2 — Orient correction toward anchor
`findAnchor()` identifies the most stable peer but the corrector doesn't use it. If a
FOLLOWING device knows which peer is ANCHORING, it could prefer that peer's trit and
lag estimate over the simple median. **Requires oracle cast.**

### Gap 3 — Role-aware COMPOUND_GAIN threshold
Currently COMPOUND_GAIN fires for any device when stalls compound AND disruption is
below 50%. Could be more nuanced: ANCHORING/HOLDING devices should never get
COMPOUND_GAIN (they're already stable — a compounding stall is a transient, not a
pattern); PUSHING devices should always get it (they need the extra force). Role-aware
gain selection. **Requires oracle cast.**

## How to observe

All three charts in the overlay show octonary data:
- **ROLES tab**: Gantt timeline — watch for sustained teal (ANCHORING) strips
- **Device cards**: octo badge next to trit badge, updates every HUD packet (~3s)
- **Room overview bar**: 8-role stacked distribution — watch REACHING (red) shrink over time
- **CSV export**: `terOctoState`, `terOctoName`, `terGlobalDisruption` columns in every row

First observation goal: run a 4+ device session, export CSV after 5 min, check role
distribution % against targets above. Note which device first reaches ANCHORING and
how long it holds.
