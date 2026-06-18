/**
 * ternary/layer.js  —  Phase 3
 *
 * Phase 1: snap at 50ms (binary snaps at 150ms)
 * Phase 2: tcons() consensus threshold + tcmp() drift velocity
 * Phase 3: fix peer detection + auto-correct stable drift floor
 *
 * Wire-up (unchanged):
 *   <head>: <script src="ternary/layer.js"></script>
 *   fastDriftCorrect(), after computeLagMs():
 *     window._terLayer?.tick(lagMs);
 *   listener.html near seekPreservingBT:
 *     window._terCorrect       = (pos)     => { cancelDriftCorrection(); seekPreservingBT(pos); };
 *     window._terExpectedNow   = ()        => _expectedNow();
 *     window._terAdjustLatency = (deltaMs) => { _deviceLatencyMs = Math.max(0, _deviceLatencyMs + deltaMs); };
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

  // ── THRESHOLDS ────────────────────────────────────────────────────────────
  const TER_SNAP_BASE  = 50;   // default snap (ms)
  const TER_MICRO_MS   = 10;   // micro-correct boundary (ms)
  const BIN_THRESHOLD  = 150;  // binary's snap — don't overlap

  const SNAP_IF_N = 35;        // all peers diverging → snap sooner
  const SNAP_IF_Z = 50;        // peers mixed → normal
  const SNAP_IF_P = 75;        // all peers converged → relax

  // ── STATE ─────────────────────────────────────────────────────────────────
  let _trit        = Z;
  let _snapCount   = 0;
  let _tickCount   = 0;
  let _consecutiveN = 0;
  let _debugChannel  = null;  // byob_debug — for HUD visibility
  let _peerChannel   = null;  // ter_peers  — dedicated peer trit coordination
  let _badge       = null;
  let _peerTrits   = {};      // deviceId → { trit, ts }
  let _driftHistory = [];     // last 8 lagMs values (for floor & velocity)
  let _calApplied  = false;   // only auto-correct once per session
  const _history   = [];      // full tick log

  // ── TRIT CLASSIFIER ───────────────────────────────────────────────────────
  function driftToTrit(lagMs, snapThreshold) {
    const abs = Math.abs(lagMs);
    if (abs >= snapThreshold) return N;
    if (abs >= TER_MICRO_MS)  return Z;
    return P;
  }

  // ── CONSENSUS THRESHOLD (tcons) ───────────────────────────────────────────
  function consensusSnapThreshold() {
    const now = Date.now();
    // Prune stale peers (>20s silent)
    Object.keys(_peerTrits).forEach(id => {
      if (now - _peerTrits[id].ts > 20000) delete _peerTrits[id];
    });
    const peers = Object.values(_peerTrits).map(p => p.trit);
    if (!peers.length) return SNAP_IF_Z;
    const consensus = tcons(...peers);
    return consensus === N ? SNAP_IF_N :
           consensus === P ? SNAP_IF_P : SNAP_IF_Z;
  }

  // ── DRIFT VELOCITY (tcmp) ─────────────────────────────────────────────────
  function driftVelocity() {
    if (_driftHistory.length < 2) return Z;
    const prev = _driftHistory[_driftHistory.length - 2];
    const curr = _driftHistory[_driftHistory.length - 1];
    return tcmp(Math.abs(curr), Math.abs(prev)); // P = growing, N = shrinking
  }

  // ── FLOOR DETECTION — finds stable systematic offset ─────────────────────
  // If drift is stable around a non-zero value for 8+ ticks,
  // that value is the calibration error (BT latency under/over-estimated).
  function detectFloor() {
    if (_driftHistory.length < 8) return null;
    const recent = _driftHistory.slice(-8);
    const mean   = recent.reduce((a, v) => a + v, 0) / recent.length;
    const variance = recent.reduce((a, v) => a + (v - mean) ** 2, 0) / recent.length;
    // Stable = low variance, meaningful offset, not a wrap artifact
    if (variance < 400 && Math.abs(mean) > 20 && Math.abs(mean) < 200) {
      return mean;
    }
    return null;
  }

  // ── AUTO-CALIBRATION — adjust deviceLatencyMs to close the floor ──────────
  // floor = mean drift = (expected - actual)
  // Negative floor means audio is ahead of expected (deviceLatencyMs too high)
  // To raise expected: decrease deviceLatencyMs by |floor|
  // We apply 60% of the correction (conservative — avoid overshoot)
  function maybeAutoCalibrate() {
    if (_calApplied) return;
    if (typeof window._terAdjustLatency !== 'function') return;
    const floor = detectFloor();
    if (floor === null) return;

    // floor is negative: audio ahead → reduce deviceLatencyMs
    // floor is positive: audio behind → increase deviceLatencyMs
    const correction = -floor * 0.6; // 60% of floor, sign inverted
    const rounded = Math.round(correction * 10) / 10;

    if (Math.abs(rounded) < 5) return; // don't adjust for tiny errors

    window._terAdjustLatency(rounded);
    _calApplied = true;
    console.log('[ternary] auto-calibration: floor', Math.round(floor) + 'ms → adjusting latency by', rounded + 'ms');
    broadcastCalEvent(floor, rounded);
  }

  function broadcastCalEvent(floor, correction) {
    if (!_debugChannel) return;
    try {
      _debugChannel.send({
        type: 'broadcast', event: 'sync_event',
        payload: {
          deviceId: myId(),
          kind: 'ter_calibration',
          floorMs: Math.round(floor),
          correctionMs: correction,
        }
      });
    } catch (e) {}
  }

  // ── SNAP ──────────────────────────────────────────────────────────────────
  function applySnap(lagMs, reason) {
    if (typeof window._terCorrect      !== 'function') return;
    if (typeof window._terExpectedNow  !== 'function') return;
    const target = window._terExpectedNow();
    if (target == null) return;
    window._terCorrect(target);
    _snapCount++;
    console.log('[ternary]', reason, Math.round(lagMs) + 'ms → ' + target.toFixed(3) + 's');
  }

  // ── TICK ──────────────────────────────────────────────────────────────────
  function tick(lagMs) {
    if (typeof lagMs !== 'number' || isNaN(lagMs)) return;
    _tickCount++;

    const abs = Math.abs(lagMs);

    // Track drift history
    _driftHistory.push(lagMs);
    if (_driftHistory.length > 8) _driftHistory.shift();

    const snapThreshold = consensusSnapThreshold();
    _trit = driftToTrit(lagMs, snapThreshold);

    if (abs >= BIN_THRESHOLD) {
      // Binary handles — count, don't interfere
      _snapCount++;
      _consecutiveN++;

    } else if (_trit === N) {
      // Ternary's zone: 50ms (or consensus-adjusted) to 150ms
      applySnap(lagMs, 'snap(N)');
      _consecutiveN++;

    } else if (_trit === Z) {
      // Z: check velocity — if drift growing and near threshold, preempt
      const vel = driftVelocity();
      if (vel === P && abs > TER_SNAP_BASE * 0.7) {
        applySnap(lagMs, 'snap(Z→N velocity)');
      }
      _consecutiveN = 0;

    } else {
      _consecutiveN = 0;
    }

    // After 6 consecutive N with stable floor → auto-calibrate
    if (_consecutiveN >= 6) {
      maybeAutoCalibrate();
      _consecutiveN = 0;
    }

    updateBadge();
    broadcastDebug(lagMs, snapThreshold);
    broadcastPeerTrit();

    _history.push({ ts: Date.now(), lagMs: Math.round(lagMs), trit: TRIT_NAME[_trit], snapThreshold });
    if (_history.length > 500) _history.shift();
  }

  // ── PEER TRIT RECEIVE ─────────────────────────────────────────────────────
  function receivePeerTrit(deviceId, trit) {
    if (trit == null || deviceId === myId()) return;
    _peerTrits[deviceId] = { trit, ts: Date.now() };
  }

  function myId() {
    return 'ter_' + (window.listenerId || 'unknown').slice(0, 6);
  }

  // ── BROADCAST — debug channel (for overlay + debug.html) ─────────────────
  function broadcastDebug(lagMs, snapThreshold) {
    if (!_debugChannel) return;
    const peers = Object.values(_peerTrits).map(p => p.trit);
    const consensus = peers.length ? tcons(...peers) : Z;
    try {
      _debugChannel.send({
        type: 'broadcast', event: 'hud_data',
        payload: {
          deviceId:     myId(),
          build:        'listener+ternary',
          driftMs:      Math.round(lagMs),
          terTrit:      TRIT_NAME[_trit],
          terTritLabel: TRIT_LABEL[_trit],
          terSnapMs:    snapThreshold,
          terConsensus: TRIT_NAME[consensus],
          terPeerCount: peers.length,
          terSnapCount: _snapCount,
          terTickCount: _tickCount,
          terConsecN:   _consecutiveN,
          terCalApplied: _calApplied,
          playbackRate: window._audio?.playbackRate ?? 1,
          driftState:   window._driftState ?? 'unknown',
          currentTime:  window._audio?.currentTime ?? null,
          zone:         window.activeZone?.name ?? 'unknown',
        },
      });
    } catch (e) {}
  }

  // ── BROADCAST — peer channel (dedicated trit coordination) ────────────────
  function broadcastPeerTrit() {
    if (!_peerChannel) return;
    try {
      _peerChannel.send({
        type: 'broadcast', event: 'trit',
        payload: { deviceId: myId(), trit: _trit, ts: Date.now() },
      });
    } catch (e) {}
  }

  // ── INIT ──────────────────────────────────────────────────────────────────
  function init() {
    if (!window.db) { setTimeout(init, 500); return; }
    if (_debugChannel) return; // already initialised

    // Debug channel: broadcast HUD data, listen for nothing extra here
    _debugChannel = window.db.channel('byob_debug').subscribe();

    // Dedicated peer channel: each device broadcasts its trit here,
    // all devices receive each other's. Separate from byob_debug to
    // avoid timing/echo issues with listener.html's existing subscriptions.
    _peerChannel = window.db.channel('byob_ternary')
      .on('broadcast', { event: 'trit' }, ({ payload }) => {
        if (payload?.deviceId && payload.deviceId !== myId()) {
          receivePeerTrit(payload.deviceId, payload.trit);
        }
      })
      .subscribe();

    createBadge();
    window._terLayer = { tick, history: () => _history, exportCSV };
    console.log('[ternary/layer] Phase 3 ready — peer channel: byob_ternary');
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
      '<span id="ter-badge-trit">Z</span>' +
      '<span id="ter-badge-sub" style="font-size:7px;letter-spacing:1px;opacity:0.7"></span>';
    document.body.appendChild(el);
    _badge = el;
  }

  function updateBadge() {
    if (!_badge) return;
    const col = TRIT_COLOR[_trit];
    _badge.style.color       = col;
    _badge.style.borderColor = col;
    _badge.style.background  = _trit === P ? '#001810' :
                                _trit === N ? '#001828' : '#050312';
    const t = document.getElementById('ter-badge-trit');
    const s = document.getElementById('ter-badge-sub');
    if (t) t.textContent = TRIT_NAME[_trit];
    const peerCount = Object.keys(_peerTrits).length;
    if (s) s.textContent = peerCount ? peerCount + 'p' : (_calApplied ? 'cal' : '');
  }

  // ── EXPORT ────────────────────────────────────────────────────────────────
  function exportCSV() {
    if (!_history.length) return;
    const rows = ['ts,lagMs,trit,snapThreshold',
      ..._history.map(r => `${r.ts},${r.lagMs},${r.trit},${r.snapThreshold}`)];
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
