// ════════════════════════════════════════════════════════════
// BYOB Ternary Sync Engine  —  Hexagram 50 (The Cauldron), unchanging
//
// Three legs. Sacred fire. Pure transformation.
//
// The binary engine has two states: correcting or not.
// This engine has three: P (hold) · Z (nudge) · N (correct).
// Every mechanism — rate, threshold, velocity, consensus —
// is governed by balanced ternary math.
//
// Same interface as sync-engine.js so it can be hot-swapped
// in listener.html or tested in sync-sim.html.
// ════════════════════════════════════════════════════════════

import { expectedPosition, computeLag, wrapLag, SEEK_STAB_S, computeSeekTime, bpmWarpRate, computeClockOffset } from './sync-engine.js';

export { expectedPosition, computeLag, wrapLag, SEEK_STAB_S, computeSeekTime, bpmWarpRate, computeClockOffset };

// ── Balanced ternary primitives ───────────────────────────────────────────────
const N = -1, Z = 0, P = 1;

const tcons  = (...vs) => { const s = vs.reduce((a,v) => a+v, 0); return s>0?P:s<0?N:Z; };
const tcmp   = (a, b)  => a < b ? N : a > b ? P : Z;

export const TRIT_NAME  = { [-1]:'N', [0]:'Z', [1]:'P' };

// ── Thresholds ────────────────────────────────────────────────────────────────
// Three zones define the cauldron's three chambers.
const TH_P   =  10;   // ms — converged. Hold.
const TH_Z   =  50;   // ms — negotiating. Nudge.
const TH_SEEK = 500;  // ms — beyond warp reach. Seek. Matches DRIFT_SNAP_THRESHOLD_MS.

// ── Rate table — one leg of the cauldron per trit ────────────────────────────
// P: barely a breath. Z: steady pull. N: urgent close.
// P: barely a breath. Z: steady pull. N: urgent close.
const BASE_RATE = { [P]: 0.004, [Z]: 0.020, [N]: 0.050 };

// tcons() consensus modifiers — never reduce when converged, slight boost when struggling
const CONSENSUS_MOD = { [N]: 1.10, [Z]: 1.00, [P]: 1.00 };

// tcmp() velocity modifiers — gentle range, avoid strangling corrections mid-close
const VEL_MOD = { [P]: 1.20, [Z]: 1.00, [N]: 0.90 };


function lagToTrit(absMs) {
  if (absMs < TH_P) return P;
  if (absMs < TH_Z) return Z;
  return N;
}

// ── Engine ────────────────────────────────────────────────────────────────────
export function createTernaryEngine({ transport, timers, clock, getContext, getBaseRate, onSeekStuck }) {
  let _trit                = Z;
  let _prevLag             = 0;
  let _seekFailCount       = 0;      // consecutive snap-magnitude seeks that didn't land
  let _warpTimer           = null;
  let _driftGen            = 0;
  let _state               = 'idle'; // 'idle' | 'warping' | 'seeking'
  let _peers               = {};     // { id → { trit, lagMs, ts } }
  let _disruptionHoldUntil = 0;      // epoch ms — block all correction until this time

  // ── Compute lag ─────────────────────────────────────────────────────────────
  function computeLagMs() {
    const ctx = getContext();
    if (!transport.duration || !ctx.playbackStartedAt || transport.hasSrcObject?.()) return null;
    const elapsed = (clock.syncedNow() - ctx.playbackStartedAt) / 1000;
    const expected = expectedPosition({
      elapsedS: elapsed, duration: transport.duration,
      deviceLatencyMs: ctx.deviceLatencyMs, scatterOffsetMs: ctx.scatterOffsetMs,
      warpRate: getBaseRate(),
    });
    return wrapLag(computeLag({ expected, currentTime: transport.currentTime }), transport.duration * 1000);
  }

  // ── Peer trit consensus ──────────────────────────────────────────────────────
  function receivePeer(id, trit, lagMs) {
    _peers[id] = { trit, lagMs: lagMs ?? null, ts: Date.now() };
  }

  function peerConsensus() {
    const now = Date.now();
    const live = Object.values(_peers).filter(p => now - p.ts < 20000);
    if (!live.length) return _trit;
    return tcons(_trit, ...live.map(p => p.trit));
  }

  function peerMedianLag() {
    const now = Date.now();
    const lags = Object.values(_peers)
      .filter(p => now - p.ts < 20000 && p.lagMs != null)
      .map(p => p.lagMs).sort((a,b) => a-b);
    if (!lags.length) return null;
    const m = Math.floor(lags.length / 2);
    return lags.length % 2 ? lags[m] : (lags[m-1] + lags[m]) / 2;
  }

  // ── Rate correction ──────────────────────────────────────────────────────────
  function requestCorrection(lagMs) {
    if (_state === 'seeking') return; // let the seek settle
    timers.clearTimeout(_warpTimer);

    const abs = Math.abs(lagMs);

    // Disruption hold (oracle 41 — Decrease, unchanging): when ≥50% of peers are
    // PUSHING/REACHING, it's a room-wide cascade. Seeking or warping here just adds
    // to the resonant oscillation. Pause all correction for 2s; re-engage with
    // PROP_GAIN only once the room settles.
    if (window._terLayer?.isGlobalDisruption?.()) {
      _disruptionHoldUntil = timers.now() + 2000;
      settleToIdle();
      return;
    }
    if (timers.now() < _disruptionHoldUntil) {
      settleToIdle();
      return;
    }

    // Beyond warp reach — muted seek with volume ramp.
    // Wrap the target into [0, duration): on a looping track, currentTime+lag
    // can land past the end, and seekPreservingBT CLAMPS to duration-0.1
    // instead of wrapping — the seek "lands" in the wrong place, lag
    // recomputes to nearly the same value, and the device wedges in an
    // endless seek loop (observed live 2026-07-06: three phones stuck at a
    // constant ~21.4s lag with snaps firing every tick and never landing).
    if (abs >= TH_SEEK) {
      cancelDriftCorrection();
      const dur = transport.duration;
      let target = transport.currentTime + lagMs / 1000;
      if (dur) target = ((target % dur) + dur) % dur;
      seekPreservingBT(target);
      return;
    }

    // Proportional warp across the full range (P/Z/N). Rate scales continuously
    // with drift — no hard cutoffs, no micro-correction tier. At 5ms: 0.1%.
    // At 100ms: 2%. At 250ms+: capped at 2.5%. Gentle enough to be inaudible,
    // strong enough to overcome BT stalls. Oracle 27.4→21, 53 unchanging.
    const prevTrit = _trit;
    const wasWarping = _state === 'warping';
    const prevAbsLag = Math.abs(_prevLag);
    _trit = lagToTrit(abs);
    _prevLag = lagMs;

    const MICRO_GAIN    = 0.00020;      // sub-10ms hold — tuning step 8, oracle 37.1.3.4→12
    const NUDGE_GAIN    = 0.00010;      // gentle first-touch gain right after P — tuning step 4, oracle 2.1.6→27 + 14.1.3→64
    const PROP_GAIN     = 0.00040;      // rate change per ms of drift — tuning step 3 (was 0.00025, oracle 8.1.5→24)
    const COMPOUND_GAIN = 0.00060;      // a second stall landing mid-correction — tuning step 6, oracle 14.1.2→30
    const MAX_WARP  = 0.030;            // 3% — audible DJ-style warp accepted for faster convergence, oracle 53 unchanging (gradual: 1.5→3%, revisit 6% after live verify; 1.5% was step 7, oracle 49.3.6→25)
    const dir = lagMs > 0 ? 1 : -1;
    const isCompounding = wasWarping && abs > prevAbsLag;

    // seekSilent: compounding drift in 300–500ms range (oracle 48.3→29 — The Well).
    // BT buffer absorbs a small position jump silently; no mute ramp needed.
    // Only fires when drift is actively worsening — stable large drift gets warp.
    if (abs >= 300 && isCompounding) {
      seekSilent(transport.currentTime + lagMs / 1000);
      return;
    }

    // Four tiers, one role each (oracle 37 — The Family):
    //   sub-10ms: micro-hold — pull home gently, completely inaudible (~0.2% at 10ms)
    //   post-P:   nudge — one gentle tick before escalating to full gain
    //   compound: escalate — second stall landing mid-correction
    //   normal:   proportional — standard correction
    const gain = abs < TH_P     ? MICRO_GAIN
               : prevTrit === P ? NUDGE_GAIN
               : isCompounding && !window._terLayer?.isGlobalDisruption?.() ? COMPOUND_GAIN
               : PROP_GAIN;
    const warpPct = Math.min(abs * gain, MAX_WARP);
    transport.playbackRate = getBaseRate() * (1 + dir * warpPct);
    _state = 'warping';

    // Re-evaluate after one drift-check interval — rate adjusts naturally as drift changes
    _warpTimer = timers.setTimeout(settleToIdle, 2600);
  }

  function settleToIdle() {
    transport.playbackRate = getBaseRate();
    _state = 'idle';
    // No self-recheck. Oracle 36.2.6→26 (Darkening→Great Taming) + 51.1.3→27 + 2 unchanging:
    // when warp ends, hold still. fastDriftCorrect re-enters at ≥15ms only.
  }

  function cancelDriftCorrection() {
    _driftGen++;
    timers.clearTimeout(_warpTimer);
    _state = 'idle';
    transport.playbackRate = getBaseRate();
  }

  function seekPreservingBT(newTime) {
    const gen = ++_driftGen;
    _state = 'seeking';
    const safeTime = Math.max(0, Math.min(newTime, (transport.duration || 9999) - 0.1));
    const vol = transport.volume || 1;
    const preSeekTime = transport.currentTime;
    transport.volume = 0;
    transport.currentTime = safeTime;
    // No-op-seek escalation — same chronic BT condition handled in
    // listener.html's snap branch (oracle 16.3.5→31; engine extension 22
    // unchanging): on some BT routes currentTime=x silently no-ops while
    // playing, so identical seeks re-fire forever. Measure the landing
    // ~200ms out; after 3 consecutive no-lands hand off to onSeekStuck
    // (hard reload) instead of re-issuing the same seek. Deliberately NOT
    // gated on _driftGen: the post-ramp recheck re-seeks (bumping the gen)
    // precisely when the seek didn't land, which would starve the counter.
    const durMs = (transport.duration || 0) * 1000;
    const intendedJumpMs = durMs ? wrapLag((safeTime - preSeekTime) * 1000, durMs) : 0;
    if (Math.abs(intendedJumpMs) >= TH_SEEK) {
      timers.setTimeout(() => {
        const measuredJumpMs = wrapLag((transport.currentTime - preSeekTime) * 1000, durMs);
        if (Math.abs(measuredJumpMs) < Math.abs(intendedJumpMs) * 0.3) {
          if (++_seekFailCount >= 3) { _seekFailCount = 0; onSeekStuck?.(); }
        } else {
          _seekFailCount = 0;
        }
      }, 200);
    }
    const rampMs = 180, start = timers.now();
    function ramp(now) {
      if (_driftGen !== gen) return; // cancelled
      const t = Math.min((now - start) / rampMs, 1);
      transport.volume = vol * (t * t * (3 - 2 * t));
      if (t < 1) timers.requestAnimationFrame(ramp);
      else {
        transport.volume = vol; _state = 'idle';
        const lag = computeLagMs();
        if (lag !== null && Math.abs(lag) >= TH_P) requestCorrection(lag);
      }
    }
    timers.requestAnimationFrame(ramp);
  }

  // Direct seek without mute/ramp — for moderate drift (150–400ms) where the
  // BT buffer absorbs the small position jump without an audible click.
  // Sets 'seeking' state for 300ms to block cascade re-anchors.
  function seekSilent(newTime) {
    const gen = ++_driftGen;
    _state = 'seeking';
    const safeTime = Math.max(0, Math.min(newTime, (transport.duration || 9999) - 0.1));
    // Restore volume if a prior seekPreservingBT was cancelled mid-ramp
    if (transport.volume === 0) transport.volume = 1;
    transport.currentTime = safeTime;
    timers.setTimeout(() => {
      if (_driftGen !== gen) return;
      _state = 'idle';
      const lag = computeLagMs();
      if (lag !== null && Math.abs(lag) >= TH_P) requestCorrection(lag);
    }, 300);
  }

  function resetCalibration() {} // no-op — kept for interface compatibility

  return {
    computeLagMs,
    requestCorrection,
    cancelDriftCorrection,
    seekPreservingBT,
    receivePeer,
    peerConsensus,
    peerMedianLag,
    resetCalibration,
    seekSilent,
    getDriftState:           () => _state,
    getDriftPendingRecheck:  () => false,
    getTrit:                 () => _trit,
    getTritName:             () => TRIT_NAME[_trit],
  };
}
