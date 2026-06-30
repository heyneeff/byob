/**
 * ternary/layer.js  —  Phase 4
 *
 * Phase 1: snap at 50ms (binary snaps at 150ms)
 * Phase 2: tcons() consensus threshold + tcmp() drift velocity
 * Phase 3: peer channel (byob_ternary) + auto-calibrate floor
 * Phase 4: burst mode — rapid convergence on song start
 *
 * I Ching 48.1.4.5 → 34: The Well → Great Power
 * Line 1: rope too short, can't reach the water (5s tick = short rope)
 * Line 5: clear cold spring (burst mode = long rope, instant access)
 * → 34: when the rope reaches the source, the power is great
 *
 * On track start, ternary enters BURST MODE:
 *   - Measures its own drift every 1s (doesn't wait for fastDriftCorrect)
 *   - Snap threshold drops to 20ms
 *   - Exits automatically when tcons() consensus = P (whole room synced)
 *   - Hard limit: 20 seconds, then back to normal cadence
 *
 * Wire-up (unchanged from Phase 3):
 *   <head>: <script src="ternary/layer.js"></script>
 *   fastDriftCorrect(), after computeLagMs():
 *     window._terLayer?.tick(lagMs);
 *   Near seekPreservingBT:
 *     window._terCorrect       = (pos) => { cancelDriftCorrection(); seekPreservingBT(pos); };
 *     window._terExpectedNow   = ()    => _expectedNow();
 *     window._terAdjustLatency = (ms)  => { _deviceLatencyMs = Math.max(0, _deviceLatencyMs + ms); };
 */

(function() {
  'use strict';

  // ── TRIT PRIMITIVES ──────────────────────────────────────────────────────
  const N = -1, Z = 0, P = 1;

  const tcons = (...vs) => {
    const s = vs.reduce((a, v) => a + v, 0);
    return s > 0 ? P : s < 0 ? N : Z;
  };

  const tcmp = (a, b) => a < b ? N : a > b ? P : Z;

  const TRIT_NAME  = { [-1]: 'N', [0]: 'Z', [1]: 'P' };
  const TRIT_LABEL = { [-1]: 'DIVERGING', [0]: 'NEGOTIATING', [1]: 'CONVERGED' };
  const TRIT_COLOR = { [-1]: '#40c4f0', [0]: '#607080', [1]: '#f04880' };

  // ── OCTONARY PARTICIPATION ROLES (oracle field readings 31→45, 17→45, 60 unchanging) ──
  // Eight roles describe relationship topology, not timing state.
  // Weights govern how much each peer's trit influences weighted consensus.
  const OCTO = { ANCHORING:0, HOLDING:1, PULLING:2, FOLLOWING:3, PUSHING:4, LISTENING:5, RESETTING:6, REACHING:7 };
  const OCTO_NAME   = ['ANCHORING','HOLDING','PULLING','FOLLOWING','PUSHING','LISTENING','RESETTING','REACHING'];
  const OCTO_WEIGHT = [2.0, 1.5, 1.0, 0.8, 0.5, 0.3, 0.5, 0.0];
  // ANCHORING peers are trusted anchors (2×). REACHING excluded (0). LISTENING barely counts (0.3).
  // 60 — Limitation: without these bounds every node perturbs every other → noisy field.

  // ── THRESHOLDS ────────────────────────────────────────────────────────────
  const TER_SNAP_NORMAL = 50;   // normal mode snap threshold
  const TER_SNAP_BURST  = 20;   // burst mode snap threshold — very tight
  const TER_MICRO_MS    = 10;   // micro-correct boundary
  const BIN_THRESHOLD   = 150;  // binary's snap — don't overlap

  const SNAP_IF_N = 35;
  const SNAP_IF_Z = 50;
  const SNAP_IF_P = 75;

  const BURST_DURATION_MS   = 20000;  // max burst window
  const BURST_INTERVAL_MS   = 1000;   // measure + correct every 1s in burst
  const BURST_EXIT_P_TICKS  = 3;      // exit burst after 3 consecutive P consensus

  // ── STATE ─────────────────────────────────────────────────────────────────
  let _trit          = Z;
  let _snapCount     = 0;
  let _tickCount     = 0;
  let _consecutiveN  = 0;
  let _consecutiveP  = 0;      // for burst exit
  let _debugChannel  = null;  // set to window._debugChannel when available
  let _peerChannel   = null;
  let _badge         = null;
  let _peerTrits     = {};   // { deviceId → { trit, lagMs, ts } }
  let _driftHistory  = [];
  let _calApplied    = false;  // true once any correction fires (for badge)
  let _calCount      = 0;     // corrections applied this track (max 4)
  let _calState      = 0;  // diagnostic: 0=never tried, 1=already done, 2=no fn, 3=no floor, 4=correction<5, 5=fired
  let _lastFloor     = null;
  let _lastCalTs     = 0;    // timestamp of last correction — enforces minimum settle gap
  let _capHits       = 0;    // consecutive corrections swallowed by deviceLatencyMs cap
  const _history     = [];
  let _octoState     = OCTO.LISTENING; // start conservative — observe before contributing

  // ── BURST MODE ────────────────────────────────────────────────────────────
  let _burstMode    = false;
  let _burstTimer   = null;   // setInterval handle
  let _burstEndTs   = 0;
  let _burstSnaps   = 0;

  function enterBurst(reason) {
    if (_burstMode) {
      // Refresh the window if already in burst
      _burstEndTs = Date.now() + BURST_DURATION_MS;
      return;
    }
    _burstMode  = true;
    _burstEndTs = Date.now() + BURST_DURATION_MS;
    _burstSnaps = 0;
    _consecutiveP = 0;
    console.log('[ternary] BURST MODE start —', reason);
    updateBadge();

    _burstTimer = setInterval(() => {
      const drift = selfMeasureDrift();
      if (drift !== null) {
        tick(drift, /* burst */ true);
      }
      // Exit conditions
      const expired = Date.now() > _burstEndTs;
      const converged = _consecutiveP >= BURST_EXIT_P_TICKS;
      if (expired || converged) {
        exitBurst(converged ? 'consensus P' : 'timeout');
      }
    }, BURST_INTERVAL_MS);
  }

  function exitBurst(reason) {
    if (!_burstMode) return;
    _burstMode = false;
    if (_burstTimer) { clearInterval(_burstTimer); _burstTimer = null; }
    console.log('[ternary] BURST MODE end —', reason, '— snaps during burst:', _burstSnaps);
    updateBadge();
  }

  // ── SELF-MEASURE DRIFT (for burst — independent of fastDriftCorrect) ──────
  function selfMeasureDrift() {
    if (typeof window._terExpectedNow !== 'function') return null;
    if (!window._audio || !window._audio.duration) return null;
    const expected = window._terExpectedNow();
    if (expected == null) return null;
    return (expected - window._audio.currentTime) * 1000;
  }

  // ── CONSENSUS THRESHOLD ───────────────────────────────────────────────────
  function consensusSnapThreshold(isBurst) {
    if (isBurst) return TER_SNAP_BURST; // burst: always tight
    const now = Date.now();
    Object.keys(_peerTrits).forEach(id => {
      if (now - _peerTrits[id].ts > 20000) delete _peerTrits[id];
    });
    const peers = Object.values(_peerTrits).map(p => p.trit);
    if (!peers.length) return SNAP_IF_Z;
    const consensus = tcons(...peers);
    return consensus === N ? SNAP_IF_N :
           consensus === P ? SNAP_IF_P : SNAP_IF_Z;
  }

  // ── DRIFT VELOCITY ────────────────────────────────────────────────────────
  function driftVelocity() {
    if (_driftHistory.length < 2) return Z;
    const prev = _driftHistory[_driftHistory.length - 2];
    const curr = _driftHistory[_driftHistory.length - 1];
    return tcmp(Math.abs(curr), Math.abs(prev));
  }

  // ── FLOOR DETECTION ───────────────────────────────────────────────────────
  function detectFloor() {
    if (_driftHistory.length < 10) return null;
    // Sort by absolute value — readings with smallest |drift| are post-warp
    // settled states. Stall spikes land at the high-|drift| end and are
    // naturally excluded. This works for high-stall devices (BT=200ms+) where
    // the old trimmed-mean approach was rejected by the std>25ms guard because
    // stall oscillations of 150-214ms blew the variance wide open.
    const byAbs = [..._driftHistory].sort((a, b) => Math.abs(a) - Math.abs(b));
    const settle = byAbs.slice(0, Math.max(3, Math.ceil(byAbs.length * 0.4)));
    const mean     = settle.reduce((a, v) => a + v, 0) / settle.length;
    const variance = settle.reduce((a, v) => a + (v - mean) ** 2, 0) / settle.length;
    const std      = Math.sqrt(variance);
    if (std > 40)             return null; // settled samples still too noisy
    if (Math.abs(mean) < 30)  return null; // already converged
    if (Math.abs(mean) > 200) return null; // stall contamination (real floors < 200ms)
    if (Math.abs(mean) > 500) return null; // wrapLag artifact
    return mean;
  }

  // ── AUTO-CALIBRATION ──────────────────────────────────────────────────────
  const CAL_SETTLE_MS = 60000; // minimum gap between corrections — lets each one settle before next

  function maybeAutoCalibrate() {
    if (_calCount >= 4)                                    { _calState = 1; return; } // max 4 per track
    if (Date.now() - _lastCalTs < CAL_SETTLE_MS)          { _calState = 1; return; } // wait for previous to settle
    if (typeof window._terAdjustLatency !== 'function')    { _calState = 2; return; }
    const floor = detectFloor();
    _lastFloor = floor;
    if (floor === null)                                    { _calState = 3; return; }
    const correction = Math.round(floor * 0.5); // 50% step — converges in 2-3 cycles
    if (Math.abs(correction) < 8)                         { _calState = 4; return; }
    const actualDelta = window._terAdjustLatency(correction); // updates _deviceLatencyMs + localStorage
    _calApplied = true;
    if (Math.abs(actualDelta ?? correction) >= 5) {
      _calCount++;
      _capHits = 0;
      _lastCalTs = Date.now();
      _driftHistory = [];
      _consecutiveN = 0;
    } else {
      // Cap swallowed the correction — don't reset timer, count failures
      _capHits++;
      if (_capHits >= 3) _calCount = 4; // give up — cap will never allow this device
    }
    _calState = 5;
    console.log(`[ternary] auto-cal #${_calCount}: floor ${Math.round(floor)}ms → adjust ${correction}ms`);
    try {
      const ch = _debugChannel || window._debugChannel;
      ch?.send({
        type: 'broadcast', event: 'sync_event',
        payload: { deviceId: myId(), kind: 'ter_calibration',
                   floorMs: Math.round(floor), correctionMs: correction, calCount: _calCount }
      });
    } catch (e) {}
  }

  // ── SNAP — burst only, light goes underground (36) ────────────────────────
  // Normal N/Z states no longer seek. Binary warp handles 15-150ms silently.
  // Ternary governs calibration (auto-cal) not correction (snaps).
  // Only burst mode snaps — at track start when audio is inaudible anyway.
  function applySnap(lagMs, reason) {
    if (typeof window._terCorrect     !== 'function') return;
    if (typeof window._terExpectedNow !== 'function') return;
    // Guard: if BT latency exceeds elapsed, expectedPosition() wraps negative raw
    // to near end-of-track. Seeking there plays ~500ms then loops from 0.
    const zone = window._terGetZone?.();
    if (zone?.playback_started_at) {
      const elapsed = (Date.now() - new Date(zone.playback_started_at).getTime()) / 1000;
      const btS = (window._terGetDeviceLatencyMs?.() ?? 0) / 1000;
      if (elapsed < btS) return;
    }
    const target = window._terExpectedNow();
    if (target == null || target < 0) return;
    window._terCorrect(target);
    _snapCount++;
    _burstSnaps++;
    console.log('[ternary]', reason, Math.round(lagMs) + 'ms → ' + target.toFixed(3) + 's');
  }

  // ── TICK — called by fastDriftCorrect() AND burst interval ────────────────
  function tick(lagMs, isBurst) {
    if (typeof lagMs !== 'number' || isNaN(lagMs)) return;
    _tickCount++;

    const abs = Math.abs(lagMs);
    _driftHistory.push(lagMs);
    if (_driftHistory.length > 12) _driftHistory.shift(); // 12 readings = ~36s at 3s tick

    const snapThreshold = consensusSnapThreshold(isBurst);
    _trit = driftToTrit(lagMs, snapThreshold);

    // Track network convergence for burst exit
    const peers = Object.values(_peerTrits).map(p => p.trit);
    const consensus = peers.length ? tcons(_trit, ...peers) : _trit;
    // ANCHORING tracks own stability, not room consensus (oracle 3.2.4.6→10).
    // A device at 0ms should reach ANCHORING even when a Class C peer is cycling N-state.
    // Consensus still governs burst exit and broadcast — own trit governs the role threshold.
    if (_trit === P) { _consecutiveP++; }
    else if (_trit === N) { _consecutiveP = 0; }
    // Z: hold the count — oscillating near the boundary is not diverging

    if (abs >= BIN_THRESHOLD) {
      _snapCount++;
      _consecutiveN++;

    } else if (_trit === N) {
      // N-state rate correction owned by ternary-engine.js — no seek here.
      // Layer tracks consecutiveN for auto-cal trigger only.
      _consecutiveN++;

    } else if (_trit === Z) {
      // Z-state (drift 10–50ms): still structurally offset — don't reset.
      // Proportional warp oscillates through Z while correcting toward the floor;
      // resetting here prevented auto-cal from ever reaching the 10-tick trigger.

    } else {
      _consecutiveN = 0; // P-state only: truly converged, no cal needed
    }

    // Burst mode: snap aggressively at track start (audio is transitioning).
    // If floor detection has confirmed a large uncorrectable residual (device is
    // beyond the 1200ms BT cap), snapping only causes seekPreservingBT ramps that
    // bounce drift back. Still the reflex — let warp handle it instead.
    if (isBurst && abs >= TER_SNAP_BURST && abs < BIN_THRESHOLD) {
      const overCap = _lastFloor !== null && _lastFloor > 150;
      if (!overCap) applySnap(lagMs, 'burst-snap');
    }

    if (!isBurst && _consecutiveN >= 10) { // 10 × 3s = 30s of stable N-state before attempting cal
      maybeAutoCalibrate();
      _consecutiveN = 0;
    }

    updateBadge();
    if (!isBurst) broadcastDebug(lagMs, snapThreshold, consensus);
    broadcastPeerTrit(lagMs);

    _octoState = computeOctoState(lagMs);

    _history.push({ ts: Date.now(), lagMs: Math.round(lagMs),
                    trit: TRIT_NAME[_trit], snapThreshold, burst: !!isBurst,
                    octo: OCTO_NAME[_octoState] });
    if (_history.length > 500) _history.shift();
  }

  function driftToTrit(lagMs, snapThreshold) {
    const abs = Math.abs(lagMs);
    if (abs >= snapThreshold) return N;
    if (abs >= TER_MICRO_MS)  return Z;
    return P;
  }

  // ── OCTONARY STATE ────────────────────────────────────────────────────────
  function findAnchor() {
    const now = Date.now();
    return Object.values(_peerTrits).find(p => now - p.ts < 20000 && p.octoState === OCTO.ANCHORING) || null;
  }

  function computeOctoState(lagMs) {
    const abs = Math.abs(lagMs);
    const driftState = window.SyncEngine?.getDriftState?.();
    if (abs >= 300)                                           return OCTO.REACHING;
    if (driftState === 'seeking')                             return OCTO.LISTENING;
    if (_calState === 5 && Date.now() - _lastCalTs < 10000)  return OCTO.RESETTING;
    if (_trit === N)                                          return OCTO.PUSHING;
    if (_trit === Z) return findAnchor() ? OCTO.FOLLOWING : OCTO.PULLING;
    if (_consecutiveP < 5) {
      if (_octoState === OCTO.ANCHORING && abs < 50) return OCTO.ANCHORING; // hysteresis — hold form through small drift
      return OCTO.HOLDING;
    }
    return OCTO.ANCHORING;
  }

  // Global disruption: if ≥50% of live peers are PUSHING or REACHING, it's a
  // room-wide event (network hiccup, track change lag) — don't compound-escalate.
  function isGlobalDisruption() {
    const now = Date.now();
    const live = Object.values(_peerTrits).filter(p => now - p.ts < 20000);
    if (live.length < 2) return false;
    const disrupted = live.filter(p => p.octoState === OCTO.PUSHING || p.octoState === OCTO.REACHING).length;
    return disrupted >= Math.max(2, Math.ceil(live.length * 0.5));
  }

  // Weighted tcons: ANCHORING peers have 2× pull, REACHING excluded (weight 0).
  // 17→45: follow first, then gather — highest-confidence peers lead consensus.
  function weightedConsensus() {
    const now = Date.now();
    const live = Object.values(_peerTrits).filter(p => now - p.ts < 20000);
    if (!live.length) return _trit;
    let sum = _trit * 1.0, total = 1.0;
    for (const p of live) {
      const w = OCTO_WEIGHT[p.octoState ?? OCTO.PULLING];
      sum += p.trit * w;
      total += w;
    }
    const avg = sum / total;
    return avg > 0.25 ? P : avg < -0.25 ? N : Z;
  }

  // ── PEER ──────────────────────────────────────────────────────────────────
  function receivePeerTrit(deviceId, trit, lagMs, octoState) {
    if (trit == null || deviceId === myId()) return;
    _peerTrits[deviceId] = { trit, lagMs: lagMs ?? null, octoState: octoState ?? OCTO.PULLING, ts: Date.now() };
  }

  // Median of all peer lagMs values (excludes nulls, expires stale peers)
  function peerMedianLag() {
    const now = Date.now();
    const lags = Object.values(_peerTrits)
      .filter(p => now - p.ts < 20000 && p.lagMs != null)
      .map(p => p.lagMs)
      .sort((a, b) => a - b);
    if (!lags.length) return null;
    const mid = Math.floor(lags.length / 2);
    return lags.length % 2 ? lags[mid] : (lags[mid - 1] + lags[mid]) / 2;
  }

  function myId() {
    return 'ter_' + (window.listenerId || 'unknown').slice(0, 6);
  }

  // ── BROADCAST ─────────────────────────────────────────────────────────────
  function broadcastDebug(lagMs, snapThreshold, consensus) {
    _debugChannel = _debugChannel || window._debugChannel || null;
    if (!_debugChannel) return;
    const peers = Object.values(_peerTrits).map(p => p.trit);
    try {
      _debugChannel.send({
        type: 'broadcast', event: 'hud_data',
        payload: {
          deviceId:      myId(),
          build:         'listener+ternary',
          driftMs:       Math.round(lagMs),
          terTrit:       TRIT_NAME[_trit],
          terTritLabel:  TRIT_LABEL[_trit],
          terSnapMs:     snapThreshold,
          terConsensus:  TRIT_NAME[consensus],
          terPeerCount:  peers.length,
          terPeerMedian: peerMedianLag() !== null ? Math.round(peerMedianLag()) : null,
          terSnapCount:  _snapCount,
          terTickCount:  _tickCount,
          terBurst:      _burstMode,
          terBurstSnaps: _burstSnaps,
          terCalApplied: _calApplied,
          terCalState:   _calState,
          terLastFloor:  _lastFloor !== null ? Math.round(_lastFloor) : null,
          terConsecN:    _consecutiveN,
          terOctoState:  _octoState,
          terOctoName:   OCTO_NAME[_octoState],
          terGlobalDisruption: isGlobalDisruption(),
          playbackRate:  window._audio?.playbackRate ?? 1,
          driftState:    window._driftState ?? 'unknown',
          currentTime:   window._audio?.currentTime ?? null,
          zone:          window.activeZone?.name ?? 'unknown',
        },
      });
    } catch (e) {}
  }

  function broadcastPeerTrit(lagMs) {
    // Forward own trit to arpeggiator for voice assignment / consensus
    window._terArpReceivePeer?.(myId(), _trit, Date.now());

    if (!_peerChannel) return;
    try {
      _peerChannel.send({
        type: 'broadcast', event: 'trit',
        payload: { deviceId: myId(), trit: _trit, lagMs: Math.round(lagMs), octoState: _octoState, ts: Date.now() },
      });
    } catch (e) {}
  }

  // ── INIT ──────────────────────────────────────────────────────────────────
  function init() {
    if (!window.db) { setTimeout(init, 500); return; }
    if (_peerChannel) return;

    _peerChannel = window.db.channel('byob_ternary')
      .on('broadcast', { event: 'trit' }, ({ payload }) => {
        if (payload?.deviceId && payload.deviceId !== myId()) {
          receivePeerTrit(payload.deviceId, payload.trit, payload.lagMs, payload.octoState);
          // Feed peer data into the ternary engine for tcons() rate modulation
          window._terEngineReceivePeer?.(payload.deviceId, payload.trit, payload.lagMs);
          // Feed peer trits into arpeggiator for room consensus / voice harmony
          window._terArpReceivePeer?.(payload.deviceId, payload.trit, payload.ts);
        }
      })
      .subscribe();

    // Watch zone for track changes (burst trigger) — polling only, no byob_debug conflict
    watchZoneForTrackChange();

    createBadge();
    window._terLayer = {
      tick, enterBurst, exitBurst, isBurstMode: () => _burstMode, history: () => _history, exportCSV,
      getOctoState:       () => _octoState,
      getOctoName:        () => OCTO_NAME[_octoState],
      isGlobalDisruption,
      weightedConsensus,
    };
    console.log('[ternary/layer] Phase 5 ready — octonary participation layer');
  }

  // ── WATCH FOR TRACK CHANGES (triggers burst) ──────────────────────────────
  let _lastStartedAt = null;

  function watchZoneForTrackChange() {
    // Poll playback_started_at via exposed hook (window.activeZone is local in listener.html)
    setInterval(() => {
      const startedAt = window._terGetZone?.()?.playback_started_at;
      if (startedAt && startedAt !== _lastStartedAt) {
        if (_lastStartedAt !== null) {
          // It changed — new track starting
          enterBurst('track_change detected');
          _calApplied = false;
          _calCount   = 0;
          _lastCalTs  = 0;
          _driftHistory = [];
          _consecutiveN = 0;
          window._terEngineReset?.(); // clear engine's floor history for new track (cal lock preserved)
        }
        _lastStartedAt = startedAt;
      }
    }, 1000);
  }

  // ── BADGE ─────────────────────────────────────────────────────────────────
  function createBadge() {
    const el = document.createElement('div');
    el.id = 'ter-trit-badge';
    el.style.cssText = [
      'position:fixed', 'bottom:12px', 'right:12px',
      'width:44px', 'height:44px', 'border-radius:50%',
      'display:flex', 'flex-direction:column',
      'align-items:center', 'justify-content:center',
      'font-family:monospace', 'font-size:15px', 'font-weight:bold',
      'opacity:0.75', 'pointer-events:none', 'z-index:9999',
      'border:2px solid currentColor',
      'transition:color 0.3s, background 0.3s',
      'background:#050312', 'color:#607080',
    ].join(';');
    el.innerHTML =
      '<span id="ter-badge-trit" style="font-size:9px;letter-spacing:1px">TER</span>' +
      '<span id="ter-badge-sub" style="font-size:7px;letter-spacing:1px;opacity:0.8">LOAD</span>';
    el.style.color       = '#ffffff';
    el.style.borderColor = '#ffffff';
    el.style.background  = '#1a0030';
    document.body.appendChild(el);
    _badge = el;
  }

  function updateBadge() {
    if (!_badge) return;
    const col = _burstMode ? '#fff176' : TRIT_COLOR[_trit];
    _badge.style.color       = col;
    _badge.style.borderColor = col;
    _badge.style.background  = _burstMode ? '#1a1800' :
                                _trit === P ? '#001810' :
                                _trit === N ? '#001828' : '#050312';
    const t = document.getElementById('ter-badge-trit');
    const s = document.getElementById('ter-badge-sub');
    if (t) t.textContent = _burstMode ? '⚡' : TRIT_NAME[_trit];
    const peerCount = Object.keys(_peerTrits).length;
    if (s) {
      s.textContent = _burstMode ? 'SYNC'
                    : _calApplied ? 'cal'
                    : peerCount   ? peerCount + 'p'
                    : myId().slice(4); // short device ID (6 chars) when idle
    }
  }

  // ── EXPORT ────────────────────────────────────────────────────────────────
  function exportCSV() {
    if (!_history.length) return;
    const rows = ['ts,lagMs,trit,snapThreshold,burst',
      ..._history.map(r => `${r.ts},${r.lagMs},${r.trit},${r.snapThreshold},${r.burst}`)];
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `ternary-layer-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
