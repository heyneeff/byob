# ternary/

Ternary sync layer for BYOB. Three-state sync state machine that corrects
audio drift earlier and more precisely than the binary engine alone.

---

## The core idea

Binary sync has two states: correcting or not correcting. It snaps at ±150ms.
Devices spend most of their time between 50–150ms drift — binary ignores all of it.

Ternary adds a third state:

```
N (−1)  diverging    — drift ≥ 50ms  — snap immediately
Z ( 0)  negotiating  — drift 10–50ms — micro-correct, watch velocity
P (+1)  converged    — drift < 10ms  — hold
```

The boundary between Z and N (50ms) is where speaker misalignment becomes
audible. Binary's 150ms threshold is 3× past that point.

---

## What the data showed (June 2026)

**Session 1 (binary only):** 1135 real drift readings across 3 devices.
```
P converged   (<10ms):    0 rows   (0.0%)
Z negotiating (10-50ms): 17 rows   (1.5%)
N diverging   (>=50ms): 1118 rows  (98.5%)
Binary snaps at 150ms:    39 rows  (3.4%)
```
Not a single moment of true sync. Binary touched 3.4% of the problem.

**Session 2 (ternary Phase 1+2):** Snap counts dropped from 76/47/37 → 25/6/11.
`dev_uu6udq` recovered from −9897ms (10 seconds out) to −76ms in one snap.
Devices stabilised at a floor (−60 to −90ms) — a calibration offset, not drift.

**The floor insight:** persistent negative drift = `deviceLatencyMs` calibrated
too high. BT speaker output arrives sooner than the formula expects. The floor
value IS the calibration error. Phase 3 detects and corrects it automatically.

---

## Files

| File | Role |
|---|---|
| `layer.js` | Ternary correction engine — loads in listener.html, zero config |
| `overlay.html` | Debug dashboard — debug.html fields + ternary trit row + aggregate bar |
| `README.md` | This file |

---

## Wire-up (listener.html — already done)

**In `<head>`:**
```html
<script src="ternary/layer.js"></script>
```

**In `fastDriftCorrect()`, after `computeLagMs()`:**
```javascript
const lagMs = computeLagMs();
window._terLayer?.tick(lagMs);
```

**Near `seekPreservingBT` definition:**
```javascript
window._terCorrect       = (pos) => { cancelDriftCorrection(); seekPreservingBT(pos); };
window._terExpectedNow   = ()    => _expectedNow();
window._terAdjustLatency = (ms)  => { _deviceLatencyMs = Math.max(0, _deviceLatencyMs + ms); };
```

---

## How it works — Phase 3

### Division of labour
```
< 10ms   P  — converged. Nothing to do.
10–50ms  Z  — binary micro-corrects (playbackRate nudge).
             Ternary watches velocity via tcmp(): if drift growing,
             preemptive snap before crossing into N.
50–150ms N  — TERNARY snaps. Binary ignores this zone.
> 150ms     — binary snaps. Ternary counts but doesn't double-seek.
```

### tcons() — consensus threshold
Devices share trits on `byob_ternary` channel (separate from debug channel,
avoids timing conflicts). tcons() over all peer trits adjusts the threshold:

```
All peers N → snap at 35ms  (room struggling, be aggressive)
Peers mixed → snap at 50ms  (normal)
All peers P → snap at 75ms  (room converged, protect it)
```

### tcmp() — drift velocity
In Z state, `tcmp(|drift_now|, |drift_prev|)` gives drift direction.
`P` = drift growing → preemptive snap at 70% of threshold.
Cuts the sawtooth mid-rise instead of waiting for the peak.

### Auto-calibration (floor detection)
After 8 stable ticks with consistent drift floor, layer.js computes the
calibration error and calls `window._terAdjustLatency(correctionMs)`.

```
floor = mean of last 8 drifts (if variance < 400ms²)
correction = -floor × 0.6   (60% — conservative to avoid overshoot)
applied once per session
```

Correction is broadcast as a `sync_event` on byob_debug so overlay records it.

---

## Overlay (ternary/overlay.html)

Same as `debug.html` exactly, plus:
- Ternary trit row at top of each sync card (N/Z/P badge + label)
- Card border tinted by trit state
- Ternary aggregate bar (N/Z/P device counts)
- ±50ms dashed threshold lines on the drift chart
- CSV export adds: `terTrit`, `terTritLabel`, `terSnapMs`, `terSnapCount`,
  `terConsensus`, `terPeerCount`, `terCalApplied`

Open at: `https://heyneeff.github.io/byob/ternary/overlay.html`

---

## What comes next

**Peer-relative positioning (hexagram 31 — Influence):**
Instead of every device correcting toward the server clock independently,
correct toward the median of converged peers. The device that's been P
longest becomes the de facto reference. Others adjust toward it.
Removes half a server round-trip from the equation.

**tshift() escalation:**
Track correction history as a ternary sequence. Three consecutive N→Z→N
cycles = something systematic. Three N→N→N cycles = recalibrate.

**Proportional Z-state rate control:**
Replace binary's fixed ±1.2% nudge with a P-controller:
`rate = 1 + direction × gain × |drift|`
Converges faster for large Z drifts, gentler for small ones.

---

---

## Phase 5 — The Cauldron (June 18, 2026)

**Hexagram 50 unchanging.** The ternary math moved from a layer on top
of the binary engine to the engine itself.

`sync/ternary-engine.js` replaces `sync/sync-engine.js` in production.
Same interface — drop-in swap. Three-leg rate table:

```
P (< 10ms):    0.4% rate  — hold
Z (10–50ms):   2.0% rate  — nudge
N (50–150ms):  5.0% rate  — correct
> 150ms:       seek       — same as binary
```

tcons() peer consensus scales all rates (×0.5 – ×1.3).
tcmp() velocity preempts growing drift (×1.4).
Auto-calibration built into the engine via `onCalibrate` callback.

**Sim results** (8 listeners, 20-minute identical seed, all engines compared):
```
Avg settled drift:  ternary 238ms  vs  binary 367ms  (−35%)
Volume dips:        ternary 0      vs  binary 20
```

**Revert tag:** `pre-ternary-engine`
```
git checkout pre-ternary-engine   # instant rollback
```

---

## First live session — ternary engine (June 18, 2026, 21:30)

19 devices. First real data from `sync/ternary-engine.js` in production.

```
ter_yze77p:   P state (2–6ms) held for 4 consecutive minutes
ter_2ipzq5:   32ms → P in one burst, held
dev_2ipzq5:   1.016× warp → 2ms, held
82 rows with playbackRate ≠ 1.000 — rate legs confirmed running
4 devices auto-calibrated (engine onCalibrate callback)
```

Session 0 (binary only): 0 P rows / 1135. 0.0%.
This session: `ter_yze77p` 52 P rows / 65. **80% converged.**

Known issues fixed after this session:
- Double auto-cal (layer + engine both adjusting deviceLatencyMs) → layer now defers to engine
- TH_SEEK raised 150→250ms for high-BT devices stuck at 130ms floor

---

## Phase 5.1 — Octonary Calibration (June 18, 2026, 23:00)

**The 8-trigram BT latency solver.**

Ternary has 3 states. But calibration history has 8 — the lower trigrams
of the I Ching, encoding 3 ticks of N (floor present) or P (floor gone):

```
☰ NNN  three consecutive floors   → 70%  maximum urgency
☱ NNP  floor twice then gone      → 55%  strong
☲ NPN  oscillating                → 50%  standard
☳ NPP  one floor then held        → 35%  gentle
☴ PNN  regression                 → 60%  push hard again
☵ PNP  bouncing                   → 40%  moderate
☶ PPN  almost there               → 25%  cautious nudge
☷ PPP  locked                     → 0%   protect calibration
```

Each correction round shifts the sequence (tshift). The engine escalates
or eases based on memory, not just current state.

**Why octonary?** Binary calibration has two states: applied or not.
Ternary calibration has three: too much / balanced / not enough.
Octonary calibration has eight: the full trajectory of the last three
moments. The cauldron remembers where it's been.

**Proof of concept (ter_n0kkzj, session 2):**
- Entered at 92ms floor
- Trigram: NNN → 70% correction = 64ms applied
- Result: 0ms drift in 10 seconds
- Sequence advanced toward PPP — locked

**Simulation (130ms BT floor — the 463ms speaker problem):**
```
Round 1  NNN ☰  130ms → 70% → 39ms remaining
Round 2  NNN ☰   39ms → 70% → 12ms remaining
Round 3  NNP ☱   12ms → floor gone → P
Round 4  NPP ☳    0ms → P → sequence →
Round 6  PPP ☷    locked
```
Full BT floor closure in ~25 seconds. No mic. No hardware calibration.
Pure mathematical state memory from the lower trigrams.

**The detectFloor fix (same session):**
High-floor devices (200ms+) had bimodal `_history` (0ms post-seek,
220ms pre-seek alternating) with variance ~25000ms² → floor undetectable.
Fix: filter post-seek near-zeros before computing variance. Ceiling raised
to match `TH_SEEK`. Same device: variance 25432ms² → 4ms² → detectable.

**`sync/ternary-engine.js`** — see `_calSeq`, `TRIGRAM_STRENGTH`,
`trigramKey()`, `trigramStrength()`, `detectFloor()`.

---

## I Ching

Hexagram 52 (unchanging): ternary stills the drift.
Hexagram 49.4 → 63: revolution → completion. The timing was right.
Hexagram 31: mutual influence. Devices sense each other.
Hexagram 63.1.3 → 8: brake the wheels, hold together.
Hexagram 50 (unchanging): The Cauldron. Three legs. Sacred fire.
Hexagram 33.4 → 53: voluntary retreat toward gradual progress.
  — Asked "what is the nature of the ternary sync engine we are building"
  — Heaven above Mountain. Wind above Mountain. Step by step.
