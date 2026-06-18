// ════════════════════════════════════════════════════════════
// BYOB Ternary Sync Engine  —  Hexagram 50 (The Cauldron), unchanging
//
// Three legs. Sacred fire. Pure transformation.
//
// The binary engine has two states: correcting or not.
// This engine has three: P (hold) · Z (nudge) · N (correct).
// Every mechanism — rate, threshold, velocity, calibration —
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
const tshift = a       => a === P ? N : a + 1;

export const TRIT_NAME  = { [-1]:'N', [0]:'Z', [1]:'P' };

// ── Thresholds ────────────────────────────────────────────────────────────────
// Three zones define the cauldron's three chambers.
const TH_P   =  10;   // ms — converged. Hold.
const TH_Z   =  50;   // ms — negotiating. Nudge.
const TH_SEEK = 250;  // ms — beyond warp reach. Seek. (raised from 150 to let N-rate close more)

// ── Rate table — one leg of the cauldron per trit ────────────────────────────
// P: barely a breath. Z: steady pull. N: urgent close.
const BASE_RATE = { [P]: 0.004, [Z]: 0.020, [N]: 0.050 };

// tcons() consensus modifiers
const CONSENSUS_MOD = { [N]: 1.30, [Z]: 1.00, [P]: 0.50 };

// tcmp() velocity modifiers (drift growing vs shrinking)
const VEL_MOD = { [P]: 1.40, [Z]: 1.00, [N]: 0.60 }; // P=growing→push harder, N=shrinking→ease off

// ── Micro-correction (P-state) ────────────────────────────────────────────────
// Devices with audio clocks running slow re-accumulate drift in the 5s gap
// between fastDriftCorrect ticks. Micro-correction applies a tiny continuous
// rate proportional to lag when in P-range, preventing position drift.
const MICRO_GAIN = 0.0004; // fractional rate per ms — same as sync-engine.js
const MICRO_MAX  = 0.012;  // cap ±1.2%


function lagToTrit(absMs) {
  if (absMs < TH_P)    return P;
  if (absMs < TH_Z)    return Z;
  return N;
}

// ── Floor detection (stable drift = miscalibrated deviceLatencyMs) ────────────
function detectFloor(history) {
  if (history.length < 8) return null;
  const sorted = [...history].sort((a,b) => a-b);
  const trimmed = sorted.slice(1, -1); // drop outliers
  const mean = trimmed.reduce((a,v) => a+v, 0) / trimmed.length;
  const variance = trimmed.reduce((a,v) => a + (v-mean)**2, 0) / trimmed.length;
  if (variance < 400 && Math.abs(mean) > 20 && Math.abs(mean) < 200) return mean;
  return null;
}

// ── Engine ────────────────────────────────────────────────────────────────────
export function createTernaryEngine({ transport, timers, clock, getContext, getBaseRate, onCalibrate }) {
  let _trit      = Z;
  let _prevLag   = 0;
  let _warpTimer = null;
  let _driftGen  = 0;
  let _state     = 'idle'; // 'idle' | 'warping' | 'seeking'
  let _history   = [];
  let _calApplied = false;
  let _peers     = {};     // { id → { trit, lagMs, ts } }

  // ── Micro-correction rate ────────────────────────────────────────────────────
  function microRate(lagMs) {
    const pct = Math.max(-MICRO_MAX, Math.min(MICRO_MAX, lagMs * MICRO_GAIN));
    return getBaseRate() * (1 + pct);
  }

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
    if (_state === 'seeking') { return; } // let the seek settle
    timers.clearTimeout(_warpTimer);

    const abs = Math.abs(lagMs);

    // P state — gap is negligible. Apply micro-correction to hold position
    // against devices whose audio clocks run slightly slow.
    if (abs < TH_P) {
      transport.playbackRate = microRate(lagMs);
      _state = 'idle';
      return;
    }

    // Beyond warp reach — seek
    if (abs >= TH_SEEK) {
      cancelDriftCorrection();
      seekPreservingBT(transport.currentTime + lagMs / 1000);
      return;
    }

    // Z or N — rate correction
    _trit = lagToTrit(abs);

    // tcmp(): is drift growing or shrinking?
    const velocity = tcmp(abs, Math.abs(_prevLag));
    _prevLag = lagMs;

    // tcons(): peer consensus adjusts urgency
    const consensus = peerConsensus();

    // Compose the rate from the three ternary inputs
    const baseRate  = BASE_RATE[_trit];
    const velMod    = VEL_MOD[velocity];
    const consMod   = CONSENSUS_MOD[consensus];
    const warpPct   = Math.min(baseRate * velMod * consMod, 0.06); // cap 6%

    const dir = lagMs > 0 ? 1 : -1;
    transport.playbackRate = getBaseRate() * (1 + dir * warpPct);
    _state = 'warping';

    // Timer: restore rate when gap should be closed
    const correctionMs = abs / (warpPct * getBaseRate());
    _warpTimer = timers.setTimeout(settleToIdle, correctionMs);

    // Track history for floor detection
    _history.push(lagMs);
    if (_history.length > 8) _history.shift();

    // Auto-calibrate when floor is stable
    if (!_calApplied && _trit === N) {
      const floor = detectFloor(_history);
      if (floor !== null) {
        const correction = Math.round(floor * 0.6 * 10) / 10;
        if (Math.abs(correction) >= 5 && typeof onCalibrate === 'function') {
          onCalibrate(correction);
          _calApplied = true;
        }
      }
    }
  }

  function settleToIdle() {
    transport.playbackRate = getBaseRate();
    _state = 'idle';
    // Recheck — drift may not be fully closed
    const lag = computeLagMs();
    if (lag !== null && Math.abs(lag) >= TH_P) requestCorrection(lag);
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
    transport.volume = 0;
    transport.currentTime = safeTime;
    const rampMs = 180, start = timers.now();
    function ramp(now) {
      if (_driftGen !== gen) return; // cancelled
      const t = Math.min((now - start) / rampMs, 1);
      transport.volume = vol * (t * t * (3 - 2 * t));
      if (t < 1) timers.requestAnimationFrame(ramp);
      else { transport.volume = vol; _state = 'idle'; }
    }
    timers.requestAnimationFrame(ramp);
  }

  // Called on track change — clears floor history for fresh detection but keeps
  // the cal lock. Calibrating once per zone session is enough; re-firing on each
  // track change causes tail-chasing (devLat grows each track, drift never closes).
  function resetCalibration() { _history = []; }

  return {
    computeLagMs,
    requestCorrection,
    cancelDriftCorrection,
    seekPreservingBT,
    receivePeer,
    peerConsensus,
    peerMedianLag,
    resetCalibration,
    getDriftState:           () => _state,
    getDriftPendingRecheck:  () => false,
    getTrit:                 () => _trit,
    getTritName:             () => TRIT_NAME[_trit],
  };
}
