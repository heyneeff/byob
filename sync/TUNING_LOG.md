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
