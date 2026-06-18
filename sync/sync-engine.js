// ════════════════════════════════════════════════════════════
// BYOB sync engine — pure core, ported from listener.html
//
// No DOM, no Supabase, no localStorage, no GPS. Everything the engine
// needs comes in through `transport`, `timers`, `clock`, `getContext`,
// and `getBaseRate` — see createSyncEngine() below.
//
// Phase 1 ported the corrector logic in listener.html (~4782-4896) plus the
// seek-position math and clock-offset estimator verbatim, bugs included.
// Phase 3 fixed three of them here (see sync/ROADMAP.md defects #1, #3, #5):
//  - computeLagMs() now wraps at the track boundary (wrapLag)
//  - expectedPosition() / requestCorrection() are rate-aware, so BPM warp
//    (playbackRate != 1) no longer throws off position math
//  - cancelDriftCorrection() invalidates an in-flight duck via a generation
//    counter, so an orphaned duck can't re-seek/dip volume after a snap
// ════════════════════════════════════════════════════════════

// Audio seek stabilization latency constant — must match listener.html,
// debug.html's expectedPos formula, and sync-sim.html.
export const SEEK_STAB_S = 0.19;

// ── Position math ─────────────────────────────────────────────
// expected = ((elapsed + SEEK_STAB_S - deviceLatency - scatterOffset) * warpRate % duration + duration) % duration
//
// `warpRate` is the BPM-warp playbackRate (1.0 when no master BPM is set).
// Track position advances at `rate` per wall-clock second, so the whole
// wall-clock bracket — elapsed time plus the wall-clock-denominated latency/
// stabilization offsets — is converted to track-position seconds by scaling
// by `warpRate` before wrapping. At warpRate=1 this is exactly the original
// formula.
export function expectedPosition({ elapsedS, duration, deviceLatencyMs, scatterOffsetMs, warpRate = 1 }) {
  const raw = (elapsedS + SEEK_STAB_S - deviceLatencyMs / 1000 - scatterOffsetMs / 1000) * warpRate;
  return (raw % duration + duration) % duration;
}

// lag = expected - actual, in ms. Positive = audio is behind where it should be.
export function computeLag({ expected, currentTime }) {
  return (expected - currentTime) * 1000;
}

// Wrap a lag value into [-durationMs/2, durationMs/2] — a lag near
// +/-durationMs is really a small lag the other direction across the track's
// loop point, not a near-full-track desync.
export function wrapLag(lagMs, durationMs) {
  const half = durationMs / 2;
  while (lagMs > half) lagMs -= durationMs;
  while (lagMs < -half) lagMs += durationMs;
  return lagMs;
}

// Seek target for seekToSync(startedAt, playAt, playFromS) — listener.html:1405
export function computeSeekTime({ startedAt, playAt, playFromS, syncedNowMs, deviceLatencyMs, scatterOffsetMs }) {
  let seekTo = 0;
  if (playAt && playFromS !== undefined) {
    const delayMs = playAt - syncedNowMs;
    seekTo = (playFromS || 0) + SEEK_STAB_S;
    if (delayMs < 0) seekTo += (-delayMs / 1000);
  } else if (startedAt) {
    const elapsed = (syncedNowMs - new Date(startedAt).getTime()) / 1000;
    seekTo = elapsed - (deviceLatencyMs / 1000) + SEEK_STAB_S - (scatterOffsetMs / 1000);
  }
  return seekTo;
}

// ── Clock offset estimator ────────────────────────────────────
// samples: [{ t0, t1, serverMs }] — t0/t1 are local Date.now() before/after
// the RPC, serverMs is the parsed server_now() response. RTT >= 400ms is
// rejected; offset = median of (serverMs - midpoint of [t0,t1]).
// Returns null if no sample qualifies (caller should keep the previous offset).
export function computeClockOffset(samples) {
  const offsets = [];
  for (const { t0, t1, serverMs } of samples) {
    if (serverMs == null || isNaN(serverMs)) continue;
    const rtt = t1 - t0;
    if (rtt < 400) offsets.push(serverMs - (t0 + rtt / 2));
  }
  if (!offsets.length) return null;
  offsets.sort((a, b) => a - b);
  return offsets[Math.floor(offsets.length / 2)];
}

// ── BPM warp ───────────────────────────────────────────────────
// rate = masterBpm / trackBpm, clamped to a safe range. Returns 1.0 if
// either BPM is unknown (no warp).
export function bpmWarpRate(masterBpm, trackBpm) {
  if (!masterBpm || !trackBpm) return 1.0;
  return Math.max(0.25, Math.min(4.0, masterBpm / trackBpm));
}

// ── Micro-rate correction ───────────────────────────────────────
// Phase 5r: real devices carry a small, *constant* hardware clock-rate error
// (their audio clock runs a fixed fraction fast or slow relative to
// syncedNow()) — this is what made drift sawtooth from ~0 to -300ms every
// ~2 minutes under the Phase 5p snap-only design (median drift -60 to
// -180ms, well above the ~50ms target). A continuous, tiny proportional
// rate trim cancels that constant error so drift settles near 0 between
// snaps, instead of just bouncing inside the snap threshold.
//
// This is deliberately much gentler than the old +/-3% warp band (the
// "finger on a record" wobble): +/-1.2% is still well under that and below
// typical pitch-discrimination thresholds, and — critically — it settles to
// a small *constant* offset rather than continuously flipping direction, so
// there's nothing to hear flutter against.
//
// Phase 5v (2026-06-15): widened from 0.0002/0.6% to 0.0004/1.2% — a
// sync-sim.html batch sweep (30 seeds x 15min x 8 listeners) showed the 0.6%
// cap was too gentle to hold drift down between snaps: with the also-widened
// DRIFT_SNAP_THRESHOLD_MS=150 (listener.html), mean settled |drift| dropped
// from 110ms to 91ms and time spent >=150ms from 6.7% to 6.0%, for the same
// snap rate. At 0.0002/0.6% with the 150ms threshold, mean drift was still
// 110ms; at 0.0004/1.2% with the old 300ms threshold, mean drift was 102ms —
// both knobs needed moving together to get under ~90ms.
export const MICRO_GAIN_PER_MS = 0.0004;  // fractional rate adjustment per ms of lag
export const MICRO_MAX_PCT     = 0.012;   // cap +/-1.2%

// Ternary proportional warp — replaces fixed ±3% in the 15–500ms zone.
// GAIN = 0.0003/ms → 3% at 100ms (same as old fixed rate at that point).
// Below 100ms: gentler than before (1.5% at 50ms). Above 100ms: faster.
// Convergence time ≈ 1/GAIN ≈ 3.3s regardless of drift magnitude (below cap).
export const TER_WARP_GAIN = 0.0003;  // 0.03% per ms of lag
export const TER_WARP_MAX  = 0.04;    // cap at 4% — above 133ms lag

// rate = baseRate * (1 + clamp(lagMs * MICRO_GAIN_PER_MS, +/-MICRO_MAX_PCT))
// Positive lag (audio behind expected) -> speed up; negative -> slow down.
// At the worst-case +/-0.5% hardware drift modeled in sync-sim.html, this
// converges to a steady-state |lag| of ~12.5ms (0.5% / MICRO_GAIN_PER_MS),
// comfortably under the cap (pct=0.005 < 0.012) so it's not saturated at
// equilibrium.
export function microCorrectionRate(lagMs, baseRate = 1) {
  const pct = Math.max(-MICRO_MAX_PCT, Math.min(MICRO_MAX_PCT, lagMs * MICRO_GAIN_PER_MS));
  return baseRate * (1 + pct);
}

// ── Drift corrector ────────────────────────────────────────────
//
// Single gate `_driftState` ('idle' | 'warping' | 'ducking'), one entry
// point requestCorrection(lagMs):
//  - <15ms            -> ignored (snap back to base rate)
//  - 15-500ms         -> 'warping': +/-3% playbackRate nudge, snaps back
//                        when the gap closes. A new request during
//                        'warping' recomputes immediately.
//  - >500ms           -> 'ducking': fade down, seek, fade up (~2.5s).
//                        A new request during 'ducking' sets
//                        driftPendingRecheck; settleToIdle() re-checks
//                        drift when the duck finishes.
//
// `transport` — { currentTime, playbackRate, volume, duration } getters/
//   setters over the audio element (or a fake for tests), plus
//   `hasSrcObject()` (true while WebRTC live — drift correction is a no-op).
// `timers` — { setTimeout, clearTimeout, setInterval, clearInterval,
//   requestAnimationFrame, now } — inject fakes for deterministic tests.
// `clock` — { syncedNow() } returns ms (server-corrected wall clock).
// `getContext()` — returns the current
//   { playbackStartedAt (epoch ms or null), deviceLatencyMs, scatterOffsetMs }
//   read fresh on every call, since these change over the lifetime of a
//   duck/warp.
// `getBaseRate()` — returns the non-drift playbackRate (1.0, or the BPM
//   warp rate) — drift correction multiplies/restores around this.
export function createSyncEngine({ transport, timers, clock, getContext, getBaseRate }) {
  let driftState = 'idle'; // 'idle' | 'warping' | 'ducking'
  let driftPendingRecheck = false;
  let driftWarpTimer = null;
  let driftGeneration = 0; // bumped by cancelDriftCorrection / each new duck — invalidates in-flight duck callbacks

  // Current drift in ms (expected position - actual), wrapped to
  // [-duration*1000/2, duration*1000/2] (defect #1 — a lag near a full track
  // length is really a small lag across the loop point). Returns null if
  // there's nothing to compare against right now (no track loaded / WebRTC
  // live).
  function computeLagMs() {
    const ctx = getContext();
    if (!transport.duration || !ctx.playbackStartedAt || transport.hasSrcObject?.()) return null;
    const elapsed = (clock.syncedNow() - ctx.playbackStartedAt) / 1000;
    const expected = expectedPosition({
      elapsedS: elapsed,
      duration: transport.duration,
      deviceLatencyMs: ctx.deviceLatencyMs,
      scatterOffsetMs: ctx.scatterOffsetMs,
      warpRate: getBaseRate(),
    });
    return wrapLag(computeLag({ expected, currentTime: transport.currentTime }), transport.duration * 1000);
  }

  // Called whenever a warp/duck's timer naturally completes. Always
  // rechecks live drift before settling — a warp's correctionMs timer is
  // computed from the lag at the moment the warp STARTED, but real playback
  // (rate-change glitches, BT buffer hiccups, the next few seconds of
  // natural skew) can leave residual drift by the time the timer fires.
  // Snapping straight back to baseRate and waiting for the next ~3s
  // periodic tick let that residual balloon before anything reacted to it
  // (the "sawtooth" — drift gets close to 0, then jumps back up every
  // cycle). Re-issuing requestCorrection immediately closes that gap.
  function settleToIdle() {
    driftState = 'idle';
    driftPendingRecheck = false;
    const lagMs = computeLagMs();
    if (lagMs != null && Math.abs(lagMs) >= 15) {
      requestCorrection(lagMs);
    }
  }

  function requestCorrection(lagMs) {
    if (driftState === 'ducking') { driftPendingRecheck = true; return; }
    timers.clearTimeout(driftWarpTimer);

    if (Math.abs(lagMs) < 15) {
      transport.playbackRate = getBaseRate();
      driftState = 'idle';
      return;
    }

    if (Math.abs(lagMs) > 500) {
      transport.playbackRate = getBaseRate();
      driftState = 'ducking';
      seekWithDuck(transport.currentTime + lagMs / 1000);
      return;
    }

    // Ternary proportional warp: rate scales with drift magnitude.
    // Below 100ms: gentler than fixed 3% (inaudible). Above 100ms: faster.
    // Convergence time ≈ 3.3s at any lag below the 4% cap (~133ms).
    const baseRate = getBaseRate();
    const warpPct  = Math.min(TER_WARP_MAX, TER_WARP_GAIN * Math.abs(lagMs));
    transport.playbackRate = lagMs > 0 ? baseRate * (1 + warpPct) : baseRate * (1 - warpPct);
    driftState = 'warping';
    const correctionMs = Math.abs(lagMs) / (warpPct * baseRate);
    driftWarpTimer = timers.setTimeout(() => {
      transport.playbackRate = getBaseRate();
      settleToIdle();
    }, correctionMs);
  }

  // Coordinated DJ-commanded snaps (hard_sync / resync_at / sweep beam-hit /
  // scatter) seek immediately and must win — cancel any in-flight rate-warp/
  // duck first so it can't recompute and overwrite the snap a moment later.
  function cancelDriftCorrection() {
    driftGeneration++; // invalidate any in-flight duck's pending callbacks
    timers.clearTimeout(driftWarpTimer);
    driftState = 'idle';
    driftPendingRecheck = false;
    transport.playbackRate = getBaseRate();
  }

  function seekWithDuck(newTime) {
    const myGeneration = ++driftGeneration;
    const targetVol = transport.volume || 1;
    // Safety: if something throws mid-duck, release the gate so sync doesn't die silently
    const duckSafety = timers.setTimeout(() => {
      if (driftGeneration !== myGeneration) return; // cancelled — a snap already took over
      transport.volume = targetVol; settleToIdle();
    }, 5000);

    const DUCK_MS = 1500, RISE_MS = 1000, STEPS = 20;
    function ramp(durationMs, from, to, onDone) {
      const interval = Math.max(50, durationMs / STEPS);
      let step = 0;
      const timer = timers.setInterval(() => {
        if (driftGeneration !== myGeneration) { timers.clearInterval(timer); return; } // cancelled mid-ramp
        step++;
        const t = Math.min(step / STEPS, 1);
        const eased = t * t * (3 - 2 * t);
        transport.volume = from + (to - from) * eased;
        if (step >= STEPS) { transport.volume = to; timers.clearInterval(timer); onDone(); }
      }, interval);
    }

    ramp(DUCK_MS, targetVol, 0, () => {
      if (driftGeneration !== myGeneration) return; // cancelled during ramp-down
      // Recompute the target now, at seek time — the ~1.5s ramp we just ran
      // means the position passed in has gone stale.
      let safeTime = newTime;
      const ctx = getContext();
      if (ctx.playbackStartedAt && transport.duration) {
        const elapsed = (clock.syncedNow() - ctx.playbackStartedAt) / 1000;
        safeTime = expectedPosition({
          elapsedS: elapsed,
          duration: transport.duration,
          deviceLatencyMs: ctx.deviceLatencyMs,
          scatterOffsetMs: ctx.scatterOffsetMs,
          warpRate: getBaseRate(),
        });
      }
      safeTime = Math.max(0, Math.min(safeTime, (transport.duration || 9999) - 0.1));
      transport.currentTime = safeTime;
      timers.setTimeout(() => {
        if (driftGeneration !== myGeneration) return; // cancelled during the pause
        ramp(RISE_MS, 0, targetVol, () => {
          if (driftGeneration !== myGeneration) return; // cancelled during ramp-up
          timers.clearTimeout(duckSafety);
          settleToIdle();
        });
      }, 80);
    });
  }

  // Coordinated snap helper — instant seek with a short volume ramp to mask
  // the discontinuity (no duck/fade-down, just a click-guard around the jump).
  function seekPreservingBT(newTime) {
    const safeTime = Math.max(0, Math.min(newTime, (transport.duration || 9999) - 0.1));
    const targetVol = transport.volume || 1;
    transport.volume = 0;
    transport.currentTime = safeTime;
    const rampMs = 180;
    const start = timers.now();
    function ramp(now) {
      const t = Math.min((now - start) / rampMs, 1);
      transport.volume = targetVol * (t * t * (3 - 2 * t)); // smooth step
      if (t < 1) timers.requestAnimationFrame(ramp);
      else transport.volume = targetVol;
    }
    timers.requestAnimationFrame(ramp);
  }

  // Continuous micro-rate trim — called every fastDriftCorrect tick alongside
  // the snap check. No-op while the verifier's warp/duck machine is active
  // (driftState !== 'idle') so the two never fight over playbackRate; once
  // that settles back to 'idle' (via cancelDriftCorrection/settleToIdle,
  // which both reset playbackRate to baseRate), this resumes trimming.
  function applyMicroCorrection(lagMs) {
    if (driftState !== 'idle') return;
    transport.playbackRate = microCorrectionRate(lagMs, getBaseRate());
  }

  return {
    computeLagMs,
    requestCorrection,
    cancelDriftCorrection,
    seekWithDuck,
    seekPreservingBT,
    settleToIdle,
    applyMicroCorrection,
    getDriftState: () => driftState,
    getDriftPendingRecheck: () => driftPendingRecheck,
  };
}
