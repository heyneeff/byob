/**
 * ternary/layer.js  —  Phase 2
 *
 * Adds to Phase 1 (snap at 50ms):
 *   1. tcons() consensus threshold — adapts snap point based on what peers report
 *   2. tcmp() drift velocity — preemptive snap when Z state is heading toward N
 *
 * Wire-up (unchanged from Phase 1):
 *   <head>: <script src="ternary/layer.js"></script>
 *   fastDriftCorrect(), after computeLagMs():
 *     window._terLayer?.tick(lagMs);
 *   listener.html near seekPreservingBT definition:
 *     window._terCorrect     = (pos) => { cancelDriftCorrection(); seekPreservingBT(pos); };
 *     window._terExpectedNow = ()    => _expectedNow();
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

  // Base thresholds
  const TER_SNAP_BASE  = 50;   // default snap threshold (ms)
  const TER_MICRO_MS   = 10;   // micro-correction boundary (ms)
  const BIN_THRESHOLD  = 150;  // binary's snap threshold — don't overlap

  // Consensus-adjusted snap thresholds
  const SNAP_IF_N = 35;   // peers all diverging → snap sooner
  const SNAP_IF_Z = 50;   // peers mixed        → normal
  const SNAP_IF_P = 75;   // peers all converged → relax, avoid disturbing good sync

  // ── STATE ─────────────────────────────────────────────────────────────────
  let _trit       = Z;
  let _snapCount  = 0;
  let _tickCount  = 0;
  let _channel    = null;
  let _badge      = null;

  // Drift history for velocity detection (tcmp)
  let _driftHistory = [];   // last 3 lagMs values
  // Peer trits received from other devices
  let _peerTrits  = {};     // deviceId → { trit, ts }
  // Consecutive N ticks (for escalation)
  let _consecutiveN = 0;

  function driftToTrit(lagMs, snapThreshold) {
    const abs = Math.abs(lagMs);
    if (abs >= snapThreshold) return N;
    if (abs >= TER_MICRO_MS)  return Z;
    return P;
  }

  // ── CONSENSUS THRESHOLD ───────────────────────────────────────────────────
  function consensusSnapThreshold() {
    // Prune stale peers (>15s silent)
    const now = Date.now();
    Object.keys(_peerTrits).forEach(id => {
      if (now - _peerTrits[id].ts > 15000) delete _peerTrits[id];
    });

    const peers = Object.values(_peerTrits).map(p => p.trit);
    if (!peers.length) return SNAP_IF_Z; // no peers → normal threshold

    const consensus = tcons(...peers);
    return consensus === N ? SNAP_IF_N :
           consensus === P ? SNAP_IF_P :
                             SNAP_IF_Z;
  }

  // ── DRIFT VELOCITY (tcmp) ─────────────────────────────────────────────────
  function driftVelocity() {
    // Need at least 2 samples
    if (_driftHistory.length < 2) return Z;
    const prev = _driftHistory[_driftHistory.length - 2];
    const curr = _driftHistory[_driftHistory.length - 1];
    // tcmp(|curr|, |prev|): P = drift growing, N = drift shrinking
    return tcmp(Math.abs(curr), Math.abs(prev));
  }

  // ── SNAP ──────────────────────────────────────────────────────────────────
  function applySnap(lagMs, reason) {
    if (typeof window._terCorrect !== 'function' ||
        typeof window._terExpectedNow !== 'function') return;
    const target = window._terExpectedNow();
    if (target == null) return;
    window._terCorrect(target);
    _snapCount++;
    console.log('[ternary]', reason, Math.round(lagMs) + 'ms → ' + target.toFixed(3) + 's');
  }

  // ── TICK — called from fastDriftCorrect() every 5s ────────────────────────
  function tick(lagMs) {
    if (typeof lagMs !== 'number' || isNaN(lagMs)) return;

    _tickCount++;
    const abs = Math.abs(lagMs);

    // Update drift history (keep last 3)
    _driftHistory.push(lagMs);
    if (_driftHistory.length > 3) _driftHistory.shift();

    // Compute consensus-adjusted threshold
    const snapThreshold = consensusSnapThreshold();

    // Classify trit using consensus threshold
    _trit = driftToTrit(lagMs, snapThreshold);

    // ── CORRECTION LOGIC ─────────────────────────────────────────────────
    if (abs >= BIN_THRESHOLD) {
      // Binary handles this — count it, don't double-seek
      _snapCount++;
      _consecutiveN++;

    } else if (_trit === N) {
      // N state (50-150ms, or consensus-adjusted 35-150ms):
      // Ternary's exclusive zone — snap it
      applySnap(lagMs, 'snap(N)');
      _consecutiveN++;

    } else if (_trit === Z) {
      // Z state: check drift velocity via tcmp
      // If drift is growing (velocity=P), preemptive snap before reaching N
      const vel = driftVelocity();
      if (vel === P && abs > TER_SNAP_BASE * 0.7) {
        // Growing AND already at 70% of snap threshold — snap now, don't wait
        applySnap(lagMs, 'snap(Z→N)');
        _consecutiveN = 0;
      } else {
        _consecutiveN = 0;
      }

    } else {
      // P state — converged
      _consecutiveN = 0;
    }

    // Escalation: 4 consecutive N ticks = systematic problem
    // Signal for BT recalibration (if hook available)
    if (_consecutiveN >= 4) {
      console.warn('[ternary] persistent divergence — consider recalibrating BT latency');
      _consecutiveN = 0; // reset to avoid log spam
    }

    updateBadge();
    broadcast(lagMs, snapThreshold);

    const row = { ts: Date.now(), lagMs: Math.round(lagMs), trit: TRIT_NAME[_trit], snapThreshold };
    _history.push(row);
    if (_history.length > 500) _history.shift();
  }

  const _history = [];

  // ── PEER TRIT RECEIVER ────────────────────────────────────────────────────
  // Called when another device's hud_data arrives (wired up after channel subscribe)
  function receivePeerTrit(deviceId, trit) {
    if (trit == null) return;
    _peerTrits[deviceId] = { trit, ts: Date.now() };
  }

  // ── BROADCAST ─────────────────────────────────────────────────────────────
  function broadcast(lagMs, snapThreshold) {
    if (!_channel) return;
    const peers = Object.values(_peerTrits).map(p => p.trit);
    const consensus = peers.length ? tcons(...peers) : Z;
    try {
      _channel.send({
        type: 'broadcast', event: 'hud_data',
        payload: {
          deviceId:     'ter_' + (window.listenerId || 'unknown').slice(0, 6),
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
          playbackRate: window._audio?.playbackRate ?? 1,
          driftState:   window._driftState ?? 'unknown',
          currentTime:  window._audio?.currentTime ?? null,
          zone:         window.activeZone?.name ?? 'unknown',
        },
      });
    } catch (e) { /* channel not ready */ }
  }

  // ── INIT ──────────────────────────────────────────────────────────────────
  function init() {
    if (!window.db) { setTimeout(init, 500); return; }

    _channel = window.db.channel('byob_debug')
      .on('broadcast', { event: 'hud_data' }, ({ payload }) => {
        // Receive peer trits from other devices running this layer
        if (payload.terTrit && payload.deviceId &&
            !payload.deviceId.startsWith('ter_' + (window.listenerId || '').slice(0, 6))) {
          const tritVal = { N, Z, P }[payload.terTrit] ?? Z;
          receivePeerTrit(payload.deviceId, tritVal);
        }
      })
      .subscribe();

    createBadge();
    window._terLayer = { tick, history: () => _history, exportCSV, receivePeerTrit };
    console.log('[ternary/layer] Phase 2 ready — tcons + tcmp active');
  }

  // ── BADGE ─────────────────────────────────────────────────────────────────
  function createBadge() {
    const el = document.createElement('div');
    el.id = 'ter-trit-badge';
    el.style.cssText = [
      'position:fixed','bottom:12px','right:12px',
      'width:44px','height:44px','border-radius:50%',
      'display:flex','flex-direction:column',
      'align-items:center','justify-content:center',
      'font-family:monospace','font-size:15px','font-weight:bold',
      'opacity:0.75','pointer-events:none','z-index:9999',
      'border:2px solid currentColor',
      'transition:color 0.3s,background 0.3s',
      'background:#050312','color:#607080',
    ].join(';');
    el.innerHTML = '<span id="ter-badge-trit">Z</span><span id="ter-badge-sub" style="font-size:7px;letter-spacing:1px;opacity:0.7"></span>';
    document.body.appendChild(el);
    _badge = el;
  }

  function updateBadge() {
    if (!_badge) return;
    const col = TRIT_COLOR[_trit];
    _badge.style.color = col;
    _badge.style.borderColor = col;
    _badge.style.background = _trit === P ? '#001810' :
                               _trit === N ? '#001828' : '#050312';
    const t = document.getElementById('ter-badge-trit');
    const s = document.getElementById('ter-badge-sub');
    if (t) t.textContent = TRIT_NAME[_trit];
    // Show peer count if we have peers
    const peerCount = Object.keys(_peerTrits).length;
    if (s) s.textContent = peerCount ? peerCount + 'p' : '';
  }

  // ── EXPORT ────────────────────────────────────────────────────────────────
  function exportCSV() {
    if (!_history.length) return;
    const rows = ['ts,lagMs,trit,snapThreshold',
      ..._history.map(r => `${r.ts},${r.lagMs},${r.trit},${r.snapThreshold}`)];
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `ternary-layer-${Date.now()}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
