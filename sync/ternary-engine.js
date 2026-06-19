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

// tcons() consensus modifiers — never reduce when converged, slight boost when struggling
const CONSENSUS_MOD = { [N]: 1.10, [Z]: 1.00, [P]: 1.00 };

// tcmp() velocity modifiers — gentle range, avoid strangling corrections mid-close
const VEL_MOD = { [P]: 1.20, [Z]: 1.00, [N]: 0.90 };

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
  // Exclude post-seek near-zero values — they're correction artifacts, not the floor
  const floored = history.filter(v => Math.abs(v) > 20);
  if (floored.length < 4) return null;
  const sorted = [...floored].sort((a,b) => a-b);
  const trimmed = sorted.length > 4 ? sorted.slice(1, -1) : sorted;
  const mean = trimmed.reduce((a,v) => a+v, 0) / trimmed.length;
  const variance = trimmed.reduce((a,v) => a + (v-mean)**2, 0) / trimmed.length;
  if (variance < 400 && Math.abs(mean) > 20 && Math.abs(mean) < TH_SEEK) return mean;
  return null;
}

// ── Trigram calibration — 8 states (I Ching lower trigrams) ──────────────────
// _calSeq holds the last 3 calibration outcomes as N (floor persisted) or
// P (floor gone). The trigram formed by [a, b, c] maps to a correction
// strength — how aggressively to adjust deviceLatencyMs this round.
//
//  ☰ NNN  three consecutive floors   → 0.70  maximum urgency
//  ☱ NNP  floor twice then gone      → 0.55  strong, something shifted
//  ☲ NPN  floor / hold / floor       → 0.50  oscillating, standard
//  ☳ NPP  one floor then held twice  → 0.35  gentle, nearly stable
//  ☴ PNN  was stable, floor returned → 0.60  regression, push hard
//  ☵ PNP  bouncing                   → 0.40  mixed signal, moderate
//  ☶ PPN  almost there               → 0.25  cautious nudge
//  ☷ PPP  locked                     → 0.00  done — protect the calibration
//
// Keys encoded as 'NNN', 'NNP', etc. for lookup
const TRIGRAM_STRENGTH = {
  'NNN': 0.70, // ☰ three consecutive floors — maximum urgency
  'NNP': 0.55, // ☱ floor twice then gone — strong
  'NPN': 0.50, // ☲ floor / hold / floor — oscillating, standard
  'NPP': 0.35, // ☳ one floor then held — gentle, nearly stable
  'PNN': 0.60, // ☴ was stable, floor returned — regression, push hard
  'PNP': 0.40, // ☵ bouncing — mixed signal, moderate
  'PPN': 0.25, // ☶ almost there — cautious nudge
  'PPP': 0.00, // ☷ locked — protect the calibration
};

function trigramKey(seq) { return seq.map(t => t >= 0 ? 'P' : 'N').join(''); }
function trigramStrength(seq) { return TRIGRAM_STRENGTH[trigramKey(seq)] ?? 0.50; }

// ── Engine ────────────────────────────────────────────────────────────────────
export function createTernaryEngine({ transport, timers, clock, getContext, getBaseRate, onCalibrate }) {
  let _trit      = Z;
  let _prevLag   = 0;
  let _warpTimer = null;
  let _driftGen  = 0;
  let _state     = 'idle'; // 'idle' | 'warping' | 'seeking'
  let _history   = [];
  let _calSeq    = [N, N, N]; // trigram: last 3 cal outcomes (N=floor, P=stable)
  let _peers     = {};        // { id → { trit, lagMs, ts } }

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

    // Trigram auto-calibration — 8-state sequence drives correction strength
    if (_trit === N) {
      const floor = detectFloor(_history);
      const outcome = floor !== null ? N : P; // N=floor persists, P=floor gone
      _calSeq = [_calSeq[1], _calSeq[2], outcome]; // shift sequence

      const strength = trigramStrength(_calSeq);
      if (floor !== null && strength > 0 && typeof onCalibrate === 'function') {
        const correction = Math.round(floor * strength * 10) / 10;
        if (Math.abs(correction) >= 5) {
          onCalibrate(correction);
          console.log('[ternary-engine] cal trigram', _calSeq.map(t=>t>0?'P':'N').join(''),
            '→', (strength*100).toFixed(0)+'%',
            'floor', Math.round(floor)+'ms correction', correction+'ms');
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

  // Called on track change — clears floor history so detection restarts.
  // _calSeq is NOT reset: the trigram carries forward across tracks, so
  // a device that was at PPP stays protected; one at NNN keeps correcting.
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
