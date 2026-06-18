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

## I Ching

Hexagram 52 (unchanging): ternary stills the drift.
Hexagram 49.4 → 63: revolution → completion. The timing was right.
Hexagram 31: mutual influence. Devices sense each other. Next phase.
