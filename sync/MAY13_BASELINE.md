# Why the May 13 Baseline Was Stable

Commit `6f4f5b0` — May 13 2026. One function, one condition, one seek.

## The Code

```js
// Inside syncZoneAudio(), called every 10 seconds
const elapsed  = (Date.now() - new Date(z.playback_started_at).getTime()) / 1000;
const expected = (elapsed + _calOffset) % audio.duration;
const drift    = Math.abs(audio.currentTime - expected);
if (drift > 0.3) seekPreservingBT(expected);
```

That's the entire corrector. No playbackRate touch. No warp. No proportional gain.
No Z-state, no N-state. No peer consensus. No burst mode. No auto-cal.

## Why It Worked

### 1. seekPreservingBT is the only thing that works on BT speakers

BT speakers buffer audio ahead. While the buffer plays, `audio.currentTime = x`
is a silent no-op — the hardware ignores it. The only way to move a BT speaker is:

1. Mute (`audio.volume = 0`) — the speaker drains its buffer
2. Seek (`audio.currentTime = x`) — now the seek lands (speaker re-buffers from new position)
3. Ramp volume back — smooth fade-in

`seekSilent` (direct seek, no mute) fails silently on BT speakers. The seek is
accepted by the browser but the hardware ignores it. May 13 only used
`seekPreservingBT` — so it always worked on every device.

### 2. 300ms threshold = only fires for real problems

BT stalls (hardware buffer drain/refill) produce +80–200ms drift jumps every
9–16 seconds. Sub-threshold jitter (~10–30ms) never triggers a seek. 300ms is
well above stall amplitude for most devices, which means:

- Frequent tiny jitter: no response. Devices sit at their natural floor.
- Genuine stall or clock drift: seekPreservingBT fires and corrects it.

The threshold was high enough to be selective, low enough to catch real drift.

### 3. 10-second interval = no cascade

After `seekPreservingBT` completes (mute + seek + 180ms ramp), the BT speaker
needs ~1–2 seconds to refill its buffer. The 10s interval meant the engine
never fired again during the refill window. No cascade seeks. No confusion.

### 4. No warp = no BT buffer drain pressure

Proportional warp at 2.5% runs the audio element 2.5% faster than real time.
The BT speaker's buffer drains 2.5% faster. A buffer that normally lasts 15s
now lasts ~14.6s. Warp shortens the BT stall cycle.

May 13 had NO warp. Audio played at exactly 1.0× base rate. The BT buffer
cycled at its natural hardware rate (~15s). There was no code-induced pressure
on the buffer.

### 5. No complexity = no edge cases

No timers fighting each other. No settleToIdle rechecks. No _reAnchorInFlight
races. No seekSilent/seekPreservingBT branching. One interval, one condition.

The engine could not enter a bad state because there were almost no states.

## The Trade-Off

May 13 could NOT correct sub-300ms drift. Devices with high BT latency (>300ms
floor) would sit permanently out of sync until the 10s interval fired and
snapped them. There was no auto-cal to converge `deviceLatencyMs`. Each snap
was a 180ms mute/ramp — perceptible every 10s if drift was always above 300ms.

The ternary engine was built to fix these gaps: finer resolution (warp handles
0–500ms silently), auto-cal to find and close the floor, burst mode for fast
track-start convergence.

## What May 13 Teaches the Ternary Engine

1. **seekPreservingBT must be the stall-recovery mechanism.** seekSilent should
   never be used in the `playing` event handler — it fails on BT speakers.

2. **Don't fight the BT buffer.** Any correction that runs the audio faster than
   base rate shortens the stall cycle and creates resonance. Warp should be
   brief and low-rate.

3. **A simple reliable mechanism beats a complex unreliable one.** The ternary
   engine should use warp for fine tuning (0–100ms) and seekPreservingBT for
   stall recovery (100ms+). Not seekSilent.

4. **The 10s interval vs 2.5s interval.** Checking more often isn't better if
   the response (seekSilent) doesn't work. May 13's 10s interval was slower
   but every response was correct.
