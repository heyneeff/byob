// ════════════════════════════════════════════════════════════
// BYOB sync engine — pure core, ported from listener.html
//
// No DOM, no Supabase, no localStorage, no GPS. Everything the engine
// needs comes in through `transport`, `timers`, `clock`, `getContext`,
// and `getBaseRate` — see createSyncEngine() below.
//
// Phase 1 note: this is a verbatim port of the corrector logic in
// listener.html (~4782-4896) plus the seek-position math and clock-offset
// estimator. Known bugs (no lag-wrap at the track loop point, BPM-warp
// position math) are intentionally preserved here — sync/ROADMAP.md
// Phase 3 fixes them with failing tests first.
// ════════════════════════════════════════════════════════════

// Audio seek stabilization latency constant — must match listener.html,
// debug.html's expectedPos formula, and sync-sim.html.
export const SEEK_STAB_S = 0.27;

// ── Position math ─────────────────────────────────────────────
// expected = ((elapsed + SEEK_STAB_S - deviceLatency - scatterOffset) % duration + duration) % duration
export function expectedPosition({ elapsedS, duration, deviceLatencyMs, scatterOffsetMs }) {
  return ((elapsedS + SEEK_STAB_S - deviceLatencyMs / 1000 - scatterOffsetMs / 1000) % duration + duration) % duration;
}

// lag = expected - actual, in ms. Positive = audio is behind where it should be.
export function computeLag({ expected, currentTime }) {
  return (expected - currentTime) * 1000;
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

  // Current drift in ms (expected position - actual), or null if there's
  // nothing to compare against right now (no track loaded / WebRTC live).
  function computeLagMs() {
    const ctx = getContext();
    if (!transport.duration || !ctx.playbackStartedAt || transport.hasSrcObject?.()) return null;
    const elapsed = (clock.syncedNow() - ctx.playbackStartedAt) / 1000;
    const expected = expectedPosition({
      elapsedS: elapsed,
      duration: transport.duration,
      deviceLatencyMs: ctx.deviceLatencyMs,
      scatterOffsetMs: ctx.scatterOffsetMs,
    });
    return computeLag({ expected, currentTime: transport.currentTime });
  }

  function settleToIdle() {
    driftState = 'idle';
    if (driftPendingRecheck) {
      driftPendingRecheck = false;
      const lagMs = computeLagMs();
      if (lagMs != null) requestCorrection(lagMs);
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

    // Small drift = rate correction — completely inaudible at +/-3%
    const baseRate = getBaseRate();
    transport.playbackRate = lagMs > 0 ? baseRate * 1.03 : baseRate * 0.97;
    driftState = 'warping';
    const correctionMs = Math.abs(lagMs) / 0.03;
    driftWarpTimer = timers.setTimeout(() => {
      transport.playbackRate = getBaseRate();
      settleToIdle();
    }, correctionMs);
  }

  // Coordinated DJ-commanded snaps (hard_sync / resync_at / sweep beam-hit /
  // scatter) seek immediately and must win — cancel any in-flight rate-warp/
  // duck first so it can't recompute and overwrite the snap a moment later.
  function cancelDriftCorrection() {
    timers.clearTimeout(driftWarpTimer);
    driftState = 'idle';
    driftPendingRecheck = false;
    transport.playbackRate = getBaseRate();
  }

  function seekWithDuck(newTime) {
    const targetVol = transport.volume || 1;
    // Safety: if something throws mid-duck, release the gate so sync doesn't die silently
    const duckSafety = timers.setTimeout(() => { transport.volume = targetVol; settleToIdle(); }, 5000);

    const DUCK_MS = 1500, RISE_MS = 1000, STEPS = 20;
    function ramp(durationMs, from, to, onDone) {
      const interval = Math.max(50, durationMs / STEPS);
      let step = 0;
      const timer = timers.setInterval(() => {
        step++;
        const t = Math.min(step / STEPS, 1);
        const eased = t * t * (3 - 2 * t);
        transport.volume = from + (to - from) * eased;
        if (step >= STEPS) { transport.volume = to; timers.clearInterval(timer); onDone(); }
      }, interval);
    }

    ramp(DUCK_MS, targetVol, 0, () => {
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
        });
      }
      safeTime = Math.max(0, Math.min(safeTime, (transport.duration || 9999) - 0.1));
      transport.currentTime = safeTime;
      timers.setTimeout(() => {
        ramp(RISE_MS, 0, targetVol, () => {
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

  return {
    computeLagMs,
    requestCorrection,
    cancelDriftCorrection,
    seekWithDuck,
    seekPreservingBT,
    settleToIdle,
    getDriftState: () => driftState,
    getDriftPendingRecheck: () => driftPendingRecheck,
  };
}
