# ternary/

Ternary sync layer for BYOB. Read-only research tools + integration layer.

---

## Files

| File | What it is |
|---|---|
| `overlay.html` | Standalone monitor. Open in browser. Auto-finds active zone, loads audio, runs both engines independently. No config needed. |
| `layer.js` | Two-line integration for listener.html. Reads drift from BYOB's own corrector, converts to trit, broadcasts on byob_debug. Non-destructive. |
| `README.md` | This file. |

---

## How to use overlay.html right now (zero changes to BYOB)

1. Start a broadcast in `artist.html`
2. Open `ternary/overlay.html` in any browser tab
3. It finds the active zone automatically, loads the track silently, and runs both engines

**Left panel — Binary engine:** controls the actual audio (same logic as `listener.html`)
**Right panel — Ternary engine:** maintains its own independent shadow position, applies ternary corrections to that shadow only

The two will diverge because:
- Binary snaps at ≥150ms drift (BYOB Phase 5v)
- Ternary snaps at ≥50ms drift (3× earlier intervention)
- After a snap, the two positions differ until the next correction aligns them

---

## How to wire layer.js into listener.html (two lines)

**Step 1** — add to `<head>` in `listener.html`:
```html
<script src="ternary/layer.js"></script>
```

**Step 2** — add ONE line inside `fastDriftCorrect()`, right after `computeLagMs()`:
```javascript
const lagMs = computeLagMs();
window._terLayer?.tick(lagMs);   // ← this line
// ... rest of fastDriftCorrect unchanged ...
```

That's the entire integration. Nothing else changes.

**What it does:**
- Converts drift → trit (N=diverging, Z=negotiating, P=converged)
- Broadcasts trit on `byob_debug` so `overlay.html` and `debug.html` can see it
- Shows a small trit badge in the corner of the listener UI
- Never touches `audio`, `playbackRate`, or `currentTime`
- Exports CSV via `window._terLayer.exportCSV()`

**What it doesn't do:**
- Does not change how BYOB corrects audio
- Does not add any channels or subscriptions beyond what BYOB already has
- Does not interfere with the drift corrector, state machine, or seek formula

---

## What the trit means

```
N (cyan)    — DIVERGING    — drift ≥ 50ms, needs correction
Z (dim)     — NEGOTIATING  — drift 10–50ms, micro-correcting
P (coral)   — CONVERGED    — drift < 10ms, locked in
```

Ternary's 50ms threshold vs binary's 150ms: ternary intervenes earlier, more often, with smaller corrections. Binary waits longer, snaps harder. Over a full session, ternary should show lower mean absolute drift.

---

## What the data looks like

Once `layer.js` is wired in, `overlay.html` reads real drift from `listener.html` instead of computing it independently. The overlay shows:
- Per-device trit state in real time
- Binary state (`idle`/`warping`/`ducking`) alongside ternary trit
- Drift comparison: binary mean vs ternary mean over the session
- Record + export for analysis

---

## The I Ching

Hexagram 52 (Keeping Still): ternary stills the drift.
Hexagram 49.4 → 63 (Revolution → After Completion): the timing is right.
